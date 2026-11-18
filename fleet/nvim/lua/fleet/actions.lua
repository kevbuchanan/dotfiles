-- fleet actions shared by the commands in plugin/fleet.lua and the board in
-- fleet.board. Each takes a fleet name, so it works from any nvim, inside the
-- fleet's tmux session or not; nil leaves the fleet to `fleet` itself.

local M = {}

local function fleet_cmd(fleet, ...)
  local args = { "fleet" }
  if fleet then vim.list_extend(args, { "-s", fleet }) end
  vim.list_extend(args, { ... })
  return args
end

-- A fleet's notes folder: the one its tmux session records while it runs, or
-- else $FLEET_HOME/<fleet>
function M.notes_dir(fleet)
  local out = vim.trim(vim.fn.system({ "tmux", "show", "-qv", "-t", "=" .. fleet .. ":", "@fleet_notes" }))
  if vim.v.shell_error == 0 and out ~= "" then return out end
  return (vim.env.FLEET_HOME or (vim.env.HOME .. "/agents")) .. "/" .. fleet
end

local function sh(args)
  local r = vim.system(args, { text = true }):wait()
  return r.code == 0 and vim.trim(r.stdout) or nil
end

-- The fleet of the calling tmux session, when it is one
function M.session_fleet()
  local pane = vim.env.TMUX_PANE
  if not pane then return nil end
  local session = sh({ "tmux", "display", "-p", "-t", pane, "#S" })
  if session and sh({ "tmux", "show", "-qv", "-t", "=" .. session .. ":", "@fleet" }) == "1" then return session end
  return nil
end

-- The task a seat holds now, or nil
function M.seat_task(fleet, seat)
  local args = { "tmux", "list-panes", "-s", "-F", "#{@agent_seat}\t#{@agent_task}" }
  if fleet then vim.list_extend(args, { "-t", "=" .. fleet .. ":" }) end
  for line in vim.gsplit(sh(args) or "", "\n", { trimempty = true }) do
    local s, task = unpack(vim.split(line, "\t"))
    if s == seat and task and task ~= "" then return task end
  end
  return nil
end

local note = require("fleet.note")

-- The fleet and the task or seat the current buffer is about, in this order:
-- a task note's own task; the target of the :FleetDiff! tab it is in; the
-- worker seat whose worktree holds the file. nil when none applies. The fleet
-- is nil when only the tmux session can tell.
function M.target()
  local meta = note.buffer()
  if meta and meta.task then return meta.fleet, meta.task end
  if vim.t.fleet_target then return vim.t.fleet_name, vim.t.fleet_target end
  local fleet, seat = vim.api.nvim_buf_get_name(0):match("/%.claude/worktrees/([^/]+)%-(w%d+)/")
  if seat then return fleet, seat end
  return nil, nil
end

-- A target as a task: a seat stands for the task it holds, unless a task note
-- has the seat's name, as in `fleet`
function M.task(fleet, target)
  if not (target and target:match("^w%d+$")) then return target end
  fleet = fleet or M.session_fleet()
  if fleet and vim.fn.filereadable(M.notes_dir(fleet) .. "/tasks/" .. target .. ".md") == 1 then return target end
  return M.seat_task(fleet, target)
end

-- A target as a worker seat: a task note names its worker. The open note
-- wins, saved or not and archived or not; else the note in tasks/
function M.seat(fleet, target)
  if not target or target:match("^w%d+$") then return target end
  local s = note.buffer()
  if not (s and s.task == target) then
    fleet = fleet or M.session_fleet()
    s = fleet and note.summary(M.notes_dir(fleet) .. "/tasks/" .. target .. ".md")
  end
  return s and (s.worker or ""):match("%-(w%d+)$") or nil
end

-- Opens a task's or a worker branch's changes as a unified diff: `fleet diff`
-- in a terminal in a new tab, where git's pager, delta, renders it with
-- syntax colors. Quitting the pager closes the tab. delta's default pager,
-- and git's own less, quit at once on a diff that fits one screen, which
-- would close the tab before it is read, so the pager here waits for q.
function M.diff(fleet, target)
  vim.cmd("tabnew")
  local buf = vim.api.nvim_get_current_buf()
  vim.fn.jobstart(fleet_cmd(fleet, "diff", target), {
    term = true,
    env = { DELTA_PAGER = "less -R", LESS = "R" },
    on_exit = function(_, code)
      vim.schedule(function()
        if code == 0 and vim.api.nvim_buf_is_valid(buf) then vim.api.nvim_buf_delete(buf, { force = true }) end
      end)
    end,
  })
  vim.cmd("startinsert")
end

-- Opens a task's or a worker branch's changes side by side in diffview.
-- `fleet diff --rev` picks the folder and revision; see src/cmd/diff.ts.
function M.diffview(fleet, target)
  if vim.fn.exists(":DiffviewOpen") ~= 2 then
    vim.notify("fleet: diffview.nvim is not installed", vim.log.levels.ERROR)
    return
  end
  local r = vim.system(fleet_cmd(fleet, "diff", "--rev", target), { text = true }):wait()
  if r.code ~= 0 then
    vim.notify(vim.trim(r.stderr), vim.log.levels.ERROR)
    return
  end
  local dir, rev = unpack(vim.split(vim.trim(r.stdout), "\n"))
  -- fleet prints a note on stderr when a task has no end
  if vim.trim(r.stderr) ~= "" then vim.notify(vim.trim(r.stderr), vim.log.levels.WARN) end
  -- -C makes diffview use the worker's repo, not the notes repo
  vim.cmd("DiffviewOpen -C" .. vim.fn.fnameescape(dir) .. " " .. rev)
  -- :FleetComment reads these to find the task a comment belongs to
  vim.t.fleet_name = fleet
  vim.t.fleet_target = target
end

-- Runs a fleet command in the background and reports its output.
function M.run(fleet, ...)
  vim.system(fleet_cmd(fleet, ...), { text = true }, function(r)
    vim.schedule(function()
      local out = vim.trim((r.stdout or "") .. (r.stderr or ""))
      if out ~= "" then vim.notify(out, r.code == 0 and vim.log.levels.INFO or vim.log.levels.ERROR) end
    end)
  end)
end

return M
