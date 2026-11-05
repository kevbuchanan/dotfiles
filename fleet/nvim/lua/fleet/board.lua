-- :FleetBoard, a buffer listing one fleet's tasks from their frontmatter:
-- status, id, worker with its live seat state, todos, PR and title, with the
-- tasks that need attention first. It is a plain buffer fleet owns, so it
-- depends on no nvim-tree internals. It refreshes when a fleet note is saved
-- and every few seconds while visible, for the seat states, which live in
-- tmux and change without a file write.

local note = require("fleet.note")
local actions = require("fleet.actions")
local status = require("fleet.tree").status

local M = {}

local ns = vim.api.nvim_create_namespace("FleetBoard")
local REFRESH_MS = 5000

-- needs attention first, finished last
local rank = { error = 1, blocked = 2, review = 2, progress = 3, assigned = 4, [""] = 5, done = 6, abandoned = 6 }

-- A running fleet records its notes folder on its tmux session; a stopped
-- one is found under $FLEET_HOME.
local function notes_dir(fleet)
  local out = vim.trim(vim.fn.system({ "tmux", "show", "-qv", "-t", "=" .. fleet .. ":", "@fleet_notes" }))
  if vim.v.shell_error == 0 and out ~= "" then return out end
  return (vim.env.FLEET_HOME or (vim.env.HOME .. "/agents")) .. "/" .. fleet
end

-- task id -> { seat, state } for the fleet's seats that hold a task
local function seat_states(fleet)
  local states = {}
  local out = vim.fn.system({ "tmux", "list-panes", "-s", "-t", "=" .. fleet .. ":", "-F", "#{@agent_task}\t#{@agent_seat}\t#{@agent_state}" })
  if vim.v.shell_error ~= 0 then return states end
  for line in vim.gsplit(out, "\n", { trimempty = true }) do
    local task, seat, state = unpack(vim.split(line, "\t"))
    if task and task ~= "" then states[task] = { seat = seat, state = state } end
  end
  return states
end

local function collect(fleet, archived)
  local dir = notes_dir(fleet)
  local paths = vim.fn.glob(dir .. "/tasks/*.md", false, true)
  if archived then vim.list_extend(paths, vim.fn.glob(dir .. "/tasks/archive/**/*.md", false, true)) end
  local tasks = {}
  for _, path in ipairs(paths) do
    local s = note.summary(path)
    if s then
      s.path = path
      s.archived = path:find("/archive/", 1, true) ~= nil
      table.insert(tasks, s)
    end
  end
  table.sort(tasks, function(a, b)
    local ra, rb = rank[a.status or ""] or 5, rank[b.status or ""] or 5
    if ra ~= rb then return ra < rb end
    return a.task < b.task
  end)
  return tasks
end

-- Days since a note's created: date, as "3d"; empty for notes without one
local function age(created)
  local y, m, d = (created or ""):match("^(%d+)-(%d+)-(%d+)")
  if not y then return "" end
  local days = math.floor((os.time() - os.time({ year = y, month = m, day = d, hour = 12 })) / 86400 + 0.5)
  return math.max(days, 0) .. "d"
end

local function pad(text, width)
  return text .. string.rep(" ", math.max(0, width - vim.fn.strdisplaywidth(text)))
end

local function render(buf)
  local b = vim.b[buf]
  local tasks = collect(b.fleet_board, b.fleet_board_archived)
  local seats = seat_states(b.fleet_board)
  local idw = 4
  for _, t in ipairs(tasks) do idw = math.max(idw, #t.task) end

  local lines = {
    "fleet " .. b.fleet_board .. "  " .. #tasks .. " tasks" .. (b.fleet_board_archived and " (with archived)" or ""),
    "<CR> open  d diff  D side by side  b bump  f follow-up  a archived  r refresh  q close   (age from created)",
    "",
  }
  local marks = {}
  for _, t in ipairs(tasks) do
    local st = status[t.status or ""]
    local live = seats[t.task]
    local seat = (t.worker or ""):match("%-(w%d+)$") or ""
    local who = live and (live.seat .. " " .. (live.state ~= "" and live.state or "-")) or seat
    local todos = t.total > 0 and (t.done .. "/" .. t.total .. (t.open > 0 and (" ?" .. t.open) or "")) or ""
    local row = table.concat({
      pad((st and st.icon or " ") .. " " .. (t.status ~= "" and t.status or "-"), 11),
      pad(t.task, idw + 2),
      pad(who, 13),
      pad(todos, 8),
      pad(age(t.created), 5),
      pad((t.pr or "") ~= "" and "PR" or "", 4),
      (t.archived and "[archived] " or "") .. (t.title or ""),
    })
    table.insert(lines, row)
    table.insert(marks, { #lines - 1, st and st.hl or "Comment", (t.open > 0 or t.status == "blocked" or t.status == "review") })
  end
  if #tasks == 0 then table.insert(lines, "  no task notes in " .. notes_dir(b.fleet_board) .. "/tasks") end

  vim.bo[buf].modifiable = true
  vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines)
  vim.bo[buf].modifiable = false
  vim.api.nvim_buf_clear_namespace(buf, ns, 0, -1)
  vim.api.nvim_buf_set_extmark(buf, ns, 0, 0, { end_col = #lines[1], hl_group = "Title" })
  vim.api.nvim_buf_set_extmark(buf, ns, 1, 0, { end_col = #lines[2], hl_group = "Comment" })
  for _, m in ipairs(marks) do
    vim.api.nvim_buf_set_extmark(buf, ns, m[1], 0, { end_col = 11, hl_group = m[2] })
  end
  vim.b[buf].fleet_board_tasks = vim.tbl_map(function(t) return { task = t.task, path = t.path } end, tasks)
end

-- The task on the cursor's line, or nil on the header
local function task_at_cursor(buf)
  local i = vim.api.nvim_win_get_cursor(0)[1] - 3
  return (vim.b[buf].fleet_board_tasks or {})[i]
end

local function open_note(buf, t)
  local from = vim.b[buf].fleet_board_from
  if from and vim.api.nvim_win_is_valid(from) and from ~= vim.api.nvim_get_current_win() then
    vim.api.nvim_set_current_win(from)
  else
    vim.cmd("wincmd p")
  end
  vim.cmd.edit(vim.fn.fnameescape(t.path))
end

function M.open(fleet)
  local name = "fleet-board://" .. fleet
  local existing = vim.fn.bufnr(name)
  if existing ~= -1 and vim.fn.bufwinid(existing) ~= -1 then
    vim.api.nvim_set_current_win(vim.fn.bufwinid(existing))
    render(existing)
    return
  end
  local from = vim.api.nvim_get_current_win()
  vim.cmd("botright split")
  local buf = existing ~= -1 and existing or vim.api.nvim_create_buf(false, true)
  vim.api.nvim_win_set_buf(0, buf)
  vim.api.nvim_buf_set_name(buf, name)
  vim.bo[buf].buftype = "nofile"
  vim.bo[buf].bufhidden = "wipe"
  vim.bo[buf].swapfile = false
  vim.bo[buf].filetype = "fleetboard"
  vim.wo.wrap = false
  vim.wo.cursorline = true
  vim.wo.number = false
  vim.wo.relativenumber = false
  vim.wo.signcolumn = "no"
  vim.b[buf].fleet_board = fleet
  vim.b[buf].fleet_board_from = from
  render(buf)
  vim.api.nvim_win_set_height(0, math.min(math.max(#vim.api.nvim_buf_get_lines(buf, 0, -1, false), 6), 20))
  vim.api.nvim_win_set_cursor(0, { math.min(4, vim.api.nvim_buf_line_count(buf)), 0 })

  local function map(key, fn)
    vim.keymap.set("n", key, function()
      local t = task_at_cursor(buf)
      if t then fn(t) end
    end, { buffer = buf, nowait = true, silent = true })
  end
  map("<CR>", function(t) open_note(buf, t) end)
  map("d", function(t) actions.diff(fleet, t.task) end)
  map("D", function(t) actions.diffview(fleet, t.task) end)
  map("b", function(t) actions.run(fleet, "bump", t.task) end)
  map("f", function(t)
    open_note(buf, t)
    vim.cmd("FleetFollowUp")
  end)
  vim.keymap.set("n", "a", function()
    vim.b[buf].fleet_board_archived = not vim.b[buf].fleet_board_archived
    render(buf)
  end, { buffer = buf, nowait = true, silent = true })
  vim.keymap.set("n", "r", function() render(buf) end, { buffer = buf, nowait = true, silent = true })
  vim.keymap.set("n", "q", "<cmd>close<cr>", { buffer = buf, nowait = true, silent = true })

  -- seat states change without file writes, so poll while the board shows
  local timer = vim.uv.new_timer()
  timer:start(REFRESH_MS, REFRESH_MS, vim.schedule_wrap(function()
    if vim.api.nvim_buf_is_valid(buf) and vim.fn.bufwinid(buf) ~= -1 then render(buf) end
  end))
  local group = vim.api.nvim_create_augroup("FleetBoard" .. buf, { clear = true })
  vim.api.nvim_create_autocmd("BufWritePost", {
    group = group,
    pattern = "*.md",
    callback = function(ev)
      local meta = note.buffer(ev.buf)
      if meta and meta.fleet == fleet and vim.api.nvim_buf_is_valid(buf) then render(buf) end
    end,
  })
  vim.api.nvim_create_autocmd("BufWipeout", {
    group = group,
    buffer = buf,
    callback = function()
      timer:stop()
      timer:close()
      vim.api.nvim_del_augroup_by_id(group)
    end,
  })
end

return M
