-- nvim commands for fleet task review.
--
--   :FleetDiff[!] [task | seat]
--                       open changes as a unified diff, `fleet diff` in a
--                       terminal tab: a task's, or a worker's whole branch
--                       through its working tree. With !, side by side in
--                       diffview. With no argument, the branch of the worker
--                       the current buffer belongs to: a file in its
--                       worktree, or a task note whose frontmatter names it
--                       as worker.
--   <Leader>d           :FleetDiff
--   :FleetBump [task]   tell the task's worker its note has new work. With
--                       no task, uses the task note in the current buffer.
--   <Leader>b           :FleetBump
--   :FleetFollowUp[!] [id] [title]
--                       from a task note, create a follow-up task with
--                       `fleet task --from` and open it. The id defaults to
--                       the next free number, such as T3-2 after T3 and
--                       T3-3 after T3-2. With no id, a follow-up no worker
--                       has taken yet opens instead; ! creates another.
--   :FleetAssign [seat] from a task note with its Todo filled in, run
--                       `fleet assign`. The seat defaults to the worker of
--                       the task the note follows.
--   :FleetBoard [fleet] list a fleet's tasks, with keys to open, diff, bump
--                       and follow up; see fleet/board.lua.
--   :[range]FleetComment [text]
--                       add a review comment on the line or range under the
--                       cursor to the task's note, as a "Review <path>:<line>"
--                       todo; from :FleetDiff! or a file in a worker's
--                       worktree. See fleet/review.lua.
--   :FleetReview [task] send the task's review comments to its worker, with
--                       `fleet bump`.
--   <Leader>m           :FleetComment, on the line or the visual selection
--   :FleetShell [seat] [cmd]
--                       `fleet shell`: open or switch to a tmux window in a
--                       worker's worktree, running cmd or a shell. With no
--                       seat, the worker the current buffer belongs to.
--
-- Saving a task note runs `fleet answer` for it. fleet answers only when the
-- note's worker is waiting in state `question` and no question is left open,
-- so most saves do nothing, and those are silent.
--
-- For diffview, `fleet diff --rev` picks the folder and revision: the
-- worker's worktree from Base while the task is in progress, or the repo with
-- Base..End once `fleet clear` has recorded End.

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
  local actions = require("fleet.actions")
  if o.bang then actions.diffview(fleet, target) else actions.diff(fleet, target) end
end, {
  nargs = "?",
  bang = true,
  desc = "Open a fleet task's or worker branch's changes, unified or with ! in diffview",
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

vim.keymap.set("n", "<Leader>d", "<cmd>FleetDiff<cr>", { desc = "fleet diff: this buffer's worker branch" })

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

-- The tasks folder of the note in the current buffer: the nearest folder
-- named tasks above it, which reaches it from tasks/archive/<month>/; else
-- the note's own folder
local function tasks_dir()
  local here = vim.fn.expand("%:p:h")
  local dir = here
  while vim.fn.fnamemodify(dir, ":t") ~= "tasks" and dir ~= "/" do dir = vim.fn.fnamemodify(dir, ":h") end
  return dir == "/" and here or dir
end

vim.api.nvim_create_user_command("FleetFollowUp", function(o)
  local meta = note.buffer()
  if not meta then
    vim.notify("FleetFollowUp: run it from a task note", vim.log.levels.ERROR)
    return
  end
  local fleet, from = meta.fleet, meta.task
  local dir = tasks_dir()
  -- a follow-up nobody has taken yet is the one to fill in, so running this
  -- twice opens the first one again
  if #o.fargs == 0 and not o.bang then
    for _, f in ipairs(vim.fn.glob(dir .. "/*.md", false, true)) do
      local s = note.summary(f)
      if s and s.follows == from and (s.worker or "") == "" then
        vim.cmd.edit(vim.fn.fnameescape(f))
        vim.notify(("FleetFollowUp: %s already follows %s and has no worker; :FleetFollowUp! creates another"):format(s.task, from))
        return
      end
    end
  end
  -- an id is taken if a note by that name is in tasks/ or anywhere under
  -- tasks/archive/
  local function taken(name)
    return vim.fn.filereadable(dir .. "/" .. name .. ".md") == 1
      or vim.fn.glob(dir .. "/archive/**/" .. name .. ".md") ~= ""
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
end, { nargs = "*", bang = true, desc = "Create a follow-up to this fleet task and open it" })

-- Assigning a note whose Todo is still the template's blank item starts a
-- worker with nothing to do, so this refuses one. It saves first: the worker
-- reads the note from disk.
vim.api.nvim_create_user_command("FleetAssign", function(o)
  local meta = note.buffer()
  if not meta then
    vim.notify("FleetAssign: run it from a task note", vim.log.levels.ERROR)
    return
  end
  local section, items = nil, 0
  for _, line in ipairs(vim.api.nvim_buf_get_lines(0, 0, -1, false)) do
    local h = line:match("^## (.+)")
    if h then section = h elseif section == "Todo" and line:match("^%- %[ %]%s+%S") then items = items + 1 end
  end
  if items == 0 then
    vim.notify("FleetAssign: " .. meta.task .. " has no unchecked todos; fill in its Todo list first", vim.log.levels.ERROR)
    return
  end
  local seat = o.args ~= "" and o.args or nil
  if not seat and (meta.follows or "") ~= "" then
    local dir = tasks_dir()
    local prev = dir .. "/" .. meta.follows .. ".md"
    if vim.fn.filereadable(prev) == 0 then prev = vim.fn.glob(dir .. "/archive/**/" .. meta.follows .. ".md", false, true)[1] end
    seat = prev and ((note.summary(prev) or {}).worker or ""):match("%-(w%d+)$")
  end
  if not seat then
    vim.notify("FleetAssign: name a seat; " .. meta.task .. " follows no task with a worker", vim.log.levels.ERROR)
    return
  end
  vim.cmd("silent update")
  require("fleet.actions").run(meta.fleet, "assign", seat, meta.task)
end, {
  nargs = "?",
  desc = "Assign this fleet task note to a worker seat",
  complete = function(lead)
    local seats = {}
    for seat in vim.fn.system({ "tmux", "list-panes", "-s", "-F", "#{@agent_seat}" }):gmatch("(w%d+)") do
      if vim.startswith(seat, lead) then table.insert(seats, seat) end
    end
    return seats
  end,
})

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

vim.api.nvim_create_user_command("FleetComment", function(o) require("fleet.review").comment(o) end, {
  nargs = "*",
  range = true,
  desc = "Add a review comment on this line to the fleet task's note",
})
vim.api.nvim_create_user_command("FleetReview", function(o) require("fleet.review").send(o) end, {
  nargs = "?",
  desc = "Send a fleet task's review comments to its worker",
})
vim.keymap.set("n", "<Leader>m", "<cmd>FleetComment<cr>", { desc = "fleet review comment on this line" })
vim.keymap.set("x", "<Leader>m", ":FleetComment<cr>", { desc = "fleet review comment on these lines" })

-- A first argument shaped like a seat names the worker; everything else is
-- the command, so `:FleetShell nvim .` runs nvim in the current buffer's
-- worker's worktree.
vim.api.nvim_create_user_command("FleetShell", function(o)
  local fleet, seat = nil, o.fargs[1]
  local cmd = vim.list_slice(o.fargs, 2)
  if not (seat and seat:match("^w%d+$")) then
    fleet, seat = buffer_worker()
    cmd = o.fargs
    if not seat then
      vim.notify("FleetShell: name a seat, or run it from a worker's file or an assigned task note", vim.log.levels.ERROR)
      return
    end
  end
  require("fleet.actions").run(fleet, "shell", seat, unpack(cmd))
end, {
  nargs = "*",
  desc = "Open a tmux window in a fleet worker's worktree",
  complete = function(lead, line)
    -- seats complete only as the first argument
    if line:match("^%S+%s+%S+%s") then return {} end
    local seats = {}
    for seat in vim.fn.system({ "tmux", "list-panes", "-s", "-F", "#{@agent_seat}" }):gmatch("(w%d+)") do
      if vim.startswith(seat, lead) then table.insert(seats, seat) end
    end
    return seats
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
