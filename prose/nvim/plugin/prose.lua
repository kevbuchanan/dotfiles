-- Commands for the prose markdown review server. `prose start` decides which
-- Claude Code session gets the comments; see bin/prose-start.
--
--   :Prose [session]   review the current file; the optional session name
--                      completes from running Claude sessions
--   :Prose!            review it in a new Claude pane, even when the tmux
--                      window already has a Claude session
--   :ProseStop         stop the server serving the current file
--   :ProseList         list running prose servers
--   :ProseDiff[!] [git diff args]
--                      review a diff of the current file's checkout in the
--                      browser, with line comments for Claude: its changes
--                      since the default branch, or what git diff shows for
--                      the arguments, such as main...HEAD. ! opens a new
--                      Claude pane, as :Prose! does. Refs complete.

local function run(args, on_done)
  vim.system(args, { text = true }, function(r)
    vim.schedule(function()
      local out = vim.trim((r.stdout or "") .. (r.stderr or ""))
      if on_done then
        on_done(r.code, out)
      elseif out ~= "" then
        vim.notify(out, r.code == 0 and vim.log.levels.INFO or vim.log.levels.ERROR)
      end
    end)
  end)
end

local function current_file()
  local file = vim.fn.expand("%:p")
  if file == "" then
    vim.notify("prose: buffer has no file", vim.log.levels.ERROR)
    return nil
  end
  -- the server reads the file from disk
  vim.cmd("silent update")
  return file
end

vim.api.nvim_create_user_command("Prose", function(o)
  local file = current_file()
  if not file then return end
  local args = { "prose", "start", file }
  if o.bang then
    table.insert(args, "--new")
  elseif o.args ~= "" then
    vim.list_extend(args, { "--to", o.args })
  end
  run(args)
end, {
  nargs = "?",
  bang = true,
  desc = "Review the current file in prose",
  complete = function(lead)
    local names = {}
    for line in vim.gsplit(vim.fn.system({ "prose", "sessions", "--list" }), "\n", { trimempty = true }) do
      local name = line:match("^[^\t]+")
      if name and vim.startswith(name, lead) then table.insert(names, name) end
    end
    return names
  end,
})

vim.api.nvim_create_user_command("ProseStop", function()
  local file = current_file()
  if not file then return end
  -- prose stop finds the file's server itself
  run({ "prose", "stop", file })
end, { desc = "Stop the prose server for the current file" })

vim.api.nvim_create_user_command("ProseList", function()
  run({ "prose", "ls" }, function(_, out)
    vim.notify(out ~= "" and out or "prose: no servers running")
  end)
end, { desc = "List running prose servers" })

-- The current file's checkout, or the working directory's
local function checkout()
  local file = vim.fn.expand("%:p")
  local dir = file ~= "" and vim.fn.fnamemodify(file, ":h") or vim.fn.getcwd()
  local top = vim.trim(vim.fn.system({ "git", "-C", dir, "rev-parse", "--show-toplevel" }))
  return vim.v.shell_error == 0 and top or nil
end

vim.api.nvim_create_user_command("ProseDiff", function(o)
  local top = checkout()
  if not top then
    vim.notify("prose: not in a git checkout", vim.log.levels.ERROR)
    return
  end
  local args = { "prose", "diff", "-C", top }
  if o.bang then table.insert(args, "--new") end
  if #o.fargs > 0 then
    table.insert(args, "--")
    vim.list_extend(args, o.fargs)
  end
  run(args)
end, {
  nargs = "*",
  bang = true,
  desc = "Review a diff of the current checkout in prose",
  complete = function(lead)
    local top = checkout()
    if not top then return {} end
    local refs = vim.fn.systemlist({ "git", "-C", top, "for-each-ref", "--format=%(refname:short)", "refs/heads", "refs/remotes", "refs/tags" })
    return vim.tbl_filter(function(r) return vim.startswith(r, lead) end, refs)
  end,
})
