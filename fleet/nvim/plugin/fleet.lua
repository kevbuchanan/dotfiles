-- nvim commands for fleet task review.
--
--   :FleetDiff [task]   open one task's changes in diffview. With no task,
--                       uses the task note in the current buffer.
--   <Leader>d           :FleetDiff
--   :FleetBump [task]   tell the task's worker its note has new work. With
--                       no task, uses the task note in the current buffer.
--   <Leader>b           :FleetBump
--   :FleetFollowUp [id] [title]
--                       from a task note, create a follow-up task with
--                       `fleet task --from` and open it. The id defaults to
--                       the next free letter, such as T3b after T3.
--
-- Saving a task note runs `fleet answer` for it. fleet answers only when the
-- note's worker is waiting in state `question` and no question is left open,
-- so most saves do nothing, and those are silent.
--
-- `fleet diff --rev` picks the folder and revision: the worker's worktree
-- from Base while the task is in progress, or the repo with Base..End once
-- `fleet clear` has recorded End.

local function fleet_notes()
  local pane = vim.env.TMUX_PANE
  if not pane then return nil end
  local out = vim.trim(vim.fn.system({ "tmux", "show", "-qv", "-t", pane, "@fleet_notes" }))
  return out ~= "" and out or nil
end

local function note_task()
  return vim.fn.expand("%:p"):match("/tasks/([%w_-]+)%.md$")
end

vim.api.nvim_create_user_command("FleetDiff", function(o)
  local id = o.args ~= "" and o.args or note_task()
  if not id then
    vim.notify("FleetDiff: name a task, or run it from a task note", vim.log.levels.ERROR)
    return
  end
  if vim.fn.exists(":DiffviewOpen") ~= 2 then
    vim.notify("FleetDiff: diffview.nvim is not installed", vim.log.levels.ERROR)
    return
  end
  local r = vim.system({ "fleet", "diff", "--rev", id }, { text = true }):wait()
  if r.code ~= 0 then
    vim.notify(vim.trim(r.stderr), vim.log.levels.ERROR)
    return
  end
  local dir, rev = unpack(vim.split(vim.trim(r.stdout), "\n"))
  -- fleet prints a note on stderr when a task has no End
  if vim.trim(r.stderr) ~= "" then vim.notify(vim.trim(r.stderr), vim.log.levels.WARN) end
  -- -C makes diffview use the worker's repo, not the notes repo this buffer is in
  vim.cmd("DiffviewOpen -C" .. vim.fn.fnameescape(dir) .. " " .. rev)
end, {
  nargs = "?",
  desc = "Open a fleet task's changes in diffview",
  complete = function(lead)
    local notes = fleet_notes()
    if not notes then return {} end
    local ids = {}
    for _, f in ipairs(vim.fn.glob(notes .. "/tasks/*.md", false, true)) do
      local id = vim.fn.fnamemodify(f, ":t:r")
      if vim.startswith(id, lead) then table.insert(ids, id) end
    end
    return ids
  end,
})

vim.keymap.set("n", "<Leader>d", "<cmd>FleetDiff<cr>", { desc = "fleet diff for this task note" })

-- The fleet comes from the note's path, as in the save hook below, so this
-- works from any nvim. It saves first: the worker reads the note from disk.
vim.api.nvim_create_user_command("FleetBump", function(o)
  local fleet, id
  if o.args ~= "" then
    id = o.args
  else
    fleet, id = vim.fn.expand("%:p"):match("/([^/]+)/tasks/([%w_-]+)%.md$")
    if id then vim.cmd("silent update") end
  end
  if not id then
    vim.notify("FleetBump: name a task, or run it from a task note", vim.log.levels.ERROR)
    return
  end
  local args = fleet and { "fleet", "-s", fleet, "bump", id } or { "fleet", "bump", id }
  vim.system(args, { text = true }, function(r)
    vim.schedule(function()
      vim.notify(vim.trim(r.stdout .. r.stderr), r.code == 0 and vim.log.levels.INFO or vim.log.levels.ERROR)
    end)
  end)
end, { nargs = "?", desc = "Tell a fleet task's worker its note has new work" })

vim.keymap.set("n", "<Leader>b", "<cmd>FleetBump<cr>", { desc = "fleet bump for this task note" })

vim.api.nvim_create_user_command("FleetFollowUp", function(o)
  local path = vim.fn.expand("%:p")
  local fleet, from = path:match("/([^/]+)/tasks/([%w_-]+)%.md$")
  if not from then
    vim.notify("FleetFollowUp: run it from a task note", vim.log.levels.ERROR)
    return
  end
  local dir = vim.fn.fnamemodify(path, ":h")
  local id, title = o.fargs[1], table.concat(vim.list_slice(o.fargs, 2), " ")
  if not id then
    -- T3b's follow-up is T3c, not T3bb, when T3 exists
    local root = from
    local stem = from:match("^(.-)%l$")
    if stem and stem ~= "" and vim.fn.filereadable(dir .. "/" .. stem .. ".md") == 1 then root = stem end
    for c = string.byte("b"), string.byte("z") do
      local candidate = root .. string.char(c)
      if vim.fn.filereadable(dir .. "/" .. candidate .. ".md") == 0 then
        id = candidate
        break
      end
    end
  end
  local args = { "fleet", "-s", fleet, "task", id, "--from", from }
  if title ~= "" then table.insert(args, title) end
  local r = vim.system(args, { text = true }):wait()
  if r.code ~= 0 then
    vim.notify(vim.trim(r.stderr), vim.log.levels.ERROR)
    return
  end
  vim.cmd.edit(vim.fn.fnameescape(vim.trim(r.stdout)))
end, { nargs = "*", desc = "Create a follow-up to this fleet task and open it" })

-- A note lives in <notes root>/<fleet>/tasks/<id>.md, so the path names both
-- the fleet and the task, and this works from any nvim, inside a fleet or not.
vim.api.nvim_create_autocmd("BufWritePost", {
  pattern = "*/tasks/*.md",
  callback = function(ev)
    local path = vim.fn.fnamemodify(ev.file, ":p")
    local fleet, id = path:match("/([^/]+)/tasks/([%w_-]+)%.md$")
    if not fleet or vim.fn.executable("fleet") == 0 then return end
    vim.system({ "fleet", "-s", fleet, "answer", id }, { text = true }, function(r)
      if r.code == 0 then
        vim.schedule(function() vim.notify(vim.trim(r.stdout)) end)
      end
    end)
  end,
})
