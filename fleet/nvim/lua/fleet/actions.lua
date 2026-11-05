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
