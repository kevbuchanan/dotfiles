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

-- Opens a task's or a worker branch's changes in diffview. `fleet diff --rev`
-- picks the folder and revision; see bin/fleet.
function M.diff(fleet, target)
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
