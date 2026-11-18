-- Commands for the prose markdown review server. `prose start` decides which
-- Claude Code session gets the comments; see bin/prose-start.
--
--   :Prose [session]   review the current file; the optional session name
--                      completes from running Claude sessions
--   :Prose!            review it in a new Claude pane, even when the tmux
--                      window already has a Claude session
--   :ProsePreview      preview the current file in the browser with no
--                      Claude session, `prose preview`: the page shows the
--                      buffer's unsaved text as you type and scrolls to the
--                      cursor line. It reuses a server already serving the
--                      file.
--   :ProseStop[!]      stop the server serving the current file. With !,
--                      also close the Claude pane :Prose opened for it, if
--                      that pane still runs the session it started there.
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

-- A live preview sends the buffer to its server after each pause in typing,
-- and the cursor line after each pause in moving, so the page shows unsaved
-- text and follows the cursor. It ends when the server stops answering or
-- the buffer goes away.
local PAUSE_MS = 150

local function encode(s)
  return (s:gsub("[^%w%-%._~]", function(c) return ("%%%02X"):format(c:byte()) end))
end

local previews = {}

local function preview(buf, port, file)
  if previews[buf] then previews[buf]() end
  local group = vim.api.nvim_create_augroup("ProsePreview" .. buf, { clear = true })
  local query = "?file=" .. encode(file)
  local timers = {}

  local function stop(why)
    if previews[buf] ~= stop then return end
    previews[buf] = nil
    pcall(vim.api.nvim_del_augroup_by_id, group)
    for _, t in pairs(timers) do t:close() end
    timers = {}
    if why then vim.notify("prose: preview stopped: " .. why, vim.log.levels.WARN) end
  end

  local function post(route, body)
    vim.system({
      "curl", "-sf", "-X", "POST", "-H", "content-type: application/json",
      "--data-binary", "@-", ("http://127.0.0.1:%d/%s%s"):format(port, route, query),
    }, { stdin = vim.json.encode(body) }, function(r)
      if r.code ~= 0 then vim.schedule(function() stop("the server on port " .. port .. " is gone") end) end
    end)
  end

  local function later(name, fn)
    local t = timers[name]
    if not t then
      t = vim.uv.new_timer()
      timers[name] = t
    end
    t:stop()
    t:start(PAUSE_MS, 0, vim.schedule_wrap(function()
      if vim.api.nvim_buf_is_valid(buf) then fn() end
    end))
  end

  local function send_text()
    post("buffer", { text = table.concat(vim.api.nvim_buf_get_lines(buf, 0, -1, false), "\n") .. "\n" })
  end
  -- the line where the cursor stopped, read when it moved: by the time the
  -- timer fires, another window may be current
  local function send_line(line)
    post("cursor", { line = line })
  end

  vim.api.nvim_create_autocmd({ "TextChanged", "TextChangedI" }, {
    group = group,
    buffer = buf,
    callback = function() later("text", send_text) end,
  })
  vim.api.nvim_create_autocmd({ "CursorMoved", "CursorMovedI" }, {
    group = group,
    buffer = buf,
    callback = function()
      local line = vim.api.nvim_win_get_cursor(0)[1]
      later("line", function() send_line(line) end)
    end,
  })
  vim.api.nvim_create_autocmd({ "BufWipeout", "BufDelete" }, {
    group = group,
    buffer = buf,
    callback = function() stop() end,
  })
  previews[buf] = stop
  send_text()
  local win = vim.fn.bufwinid(buf)
  if win ~= -1 then send_line(vim.api.nvim_win_get_cursor(win)[1]) end
end

vim.api.nvim_create_user_command("ProsePreview", function()
  local file = vim.fn.expand("%:p")
  if file == "" then
    vim.notify("prose: buffer has no file", vim.log.levels.ERROR)
    return
  end
  local buf = vim.api.nvim_get_current_buf()
  run({ "prose", "preview", file }, function(code, out)
    local port = code == 0 and tonumber(out:match("(%d+)%s*$"))
    if not port then
      vim.notify(out ~= "" and out or "prose: preview failed", vim.log.levels.ERROR)
      return
    end
    if vim.api.nvim_buf_is_valid(buf) then preview(buf, port, file) end
  end)
end, { desc = "Preview the current file in the browser, live, with no Claude session" })

vim.api.nvim_create_user_command("ProseStop", function(o)
  local file = current_file()
  if not file then return end
  -- prose stop finds the file's server itself
  run(o.bang and { "prose", "stop", file, "--pane" } or { "prose", "stop", file })
end, { bang = true, desc = "Stop the prose server for the current file; ! also closes its Claude pane" })

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
