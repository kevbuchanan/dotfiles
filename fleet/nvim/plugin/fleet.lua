-- nvim commands for fleet task review.
--
--   :FleetDiff [task | seat]
--                       open changes in diffview: a task's, or a worker's
--                       whole branch through its working tree. With no
--                       argument, the branch of the worker the current buffer
--                       belongs to: a file in its worktree, or a task note
--                       whose frontmatter names it as worker.
--   <Leader>d           :FleetDiff
--   :FleetBump [task]   tell the task's worker its note has new work. With
--                       no task, uses the task note in the current buffer.
--   <Leader>b           :FleetBump
--   :FleetFollowUp [id] [title]
--                       from a task note, create a follow-up task with
--                       `fleet task --from` and open it. The id defaults to
--                       the next free number, such as T3-2 after T3 and
--                       T3-3 after T3-2.
--   :FleetBoard [fleet] list a fleet's tasks, with keys to open, diff, bump
--                       and follow up; see fleet/board.lua.
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

local note = require("fleet.note")

-- The fleet and worker seat the current buffer belongs to, if any: a file in
-- a worktree named <fleet>-w<n>, or a task note whose frontmatter names its
-- worker.
local function buffer_worker()
  local fleet, seat = vim.fn.expand("%:p"):match("/%.claude/worktrees/([^/]+)%-(w%d+)/")
  if fleet then return fleet, seat end
  local meta = note.buffer()
  if not meta then return nil end
  return meta.fleet, (meta.worker or ""):match("%-(w%d+)$")
end

vim.api.nvim_create_user_command("FleetDiff", function(o)
  local target, fleet = o.args, nil
  if target == "" then
    fleet, target = buffer_worker()
    if not target then
      vim.notify("FleetDiff: name a task or seat, or run it from a worker's file or an assigned task note", vim.log.levels.ERROR)
      return
    end
  end
  require("fleet.actions").diff(fleet, target)
end, {
  nargs = "?",
  desc = "Open a fleet task's or worker branch's changes in diffview",
  complete = function(lead)
    local notes = fleet_notes()
    if not notes then return {} end
    local ids = {}
    local seats = vim.fn.system({ "tmux", "list-panes", "-s", "-F", "#{@agent_seat}" })
    for seat in seats:gmatch("(w%d+)") do
      if vim.startswith(seat, lead) then table.insert(ids, seat) end
    end
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
    local meta = note.buffer()
    if meta then
      fleet, id = meta.fleet, meta.task
      vim.cmd("silent update")
    end
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
  local meta = note.buffer()
  if not meta then
    vim.notify("FleetFollowUp: run it from a task note", vim.log.levels.ERROR)
    return
  end
  local fleet, from = meta.fleet, meta.task
  -- the tasks folder, from a note in it or in its archive/
  local dir = vim.fn.expand("%:p:h")
  if vim.fn.fnamemodify(dir, ":t") == "archive" then dir = vim.fn.fnamemodify(dir, ":h") end
  -- an id is taken if a note by that name is in tasks/ or tasks/archive/
  local function taken(name)
    return vim.fn.filereadable(dir .. "/" .. name .. ".md") == 1
      or vim.fn.filereadable(dir .. "/archive/" .. name .. ".md") == 1
  end
  local id, title = o.fargs[1], table.concat(vim.list_slice(o.fargs, 2), " ")
  if not id then
    -- a follow-up to T3-2 is T3-3, not T3-2-2, when T3 exists; a numbered
    -- suffix reads the same on short ids like T3 and slugs like fix-login
    local root, n = from, 2
    local stem, num = from:match("^(.+)%-(%d+)$")
    if stem and taken(stem) then root, n = stem, tonumber(num) + 1 end
    while taken(root .. "-" .. n) do n = n + 1 end
    id = root .. "-" .. n
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

-- A note's frontmatter names its fleet and task, so this works from any
-- nvim, inside a fleet or not, and ignores markdown that isn't a fleet note.
vim.api.nvim_create_autocmd("BufWritePost", {
  pattern = "*.md",
  callback = function(ev)
    local meta = note.buffer(ev.buf)
    if not meta or vim.fn.executable("fleet") == 0 then return end
    vim.system({ "fleet", "-s", meta.fleet, "answer", meta.task }, { text = true }, function(r)
      if r.code == 0 then
        vim.schedule(function() vim.notify(vim.trim(r.stdout)) end)
      end
    end)
  end,
})

-- :FleetBoard [fleet] lists a fleet's tasks; see fleet.board. With no name,
-- the fleet of the note in the current buffer, or of this tmux session.
vim.api.nvim_create_user_command("FleetBoard", function(o)
  local fleet = o.args ~= "" and o.args or (note.buffer() or {}).fleet
  if not fleet and vim.env.TMUX_PANE then
    local session = vim.trim(vim.fn.system({ "tmux", "display", "-p", "-t", vim.env.TMUX_PANE, "#S" }))
    if vim.trim(vim.fn.system({ "tmux", "show", "-qv", "-t", "=" .. session .. ":", "@fleet" })) == "1" then fleet = session end
  end
  if not fleet then
    vim.notify("FleetBoard: name a fleet, or run it from a fleet note or a fleet's tmux session", vim.log.levels.ERROR)
    return
  end
  require("fleet.board").open(fleet)
end, {
  nargs = "?",
  desc = "List a fleet's tasks",
  complete = function(lead)
    local names = {}
    for line in vim.gsplit(vim.fn.system({ "fleet", "ls" }), "\n", { trimempty = true }) do
      local name = line:match("^(%S+)")
      if name and name ~= "FLEET" and vim.startswith(name, lead) then table.insert(names, name) end
    end
    return names
  end,
})
