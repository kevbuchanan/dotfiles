-- Review comments on a fleet task's code, written into the task's note as
-- todos. :FleetComment adds one for the line or range under the cursor, and
-- :FleetBump sends the batch. The note stays the record, and the todo
-- machinery does the rest: the Stop hook sends the worker back to unchecked
-- items, `fleet report done` refuses while any are open, and the board
-- counts them.
--
-- A comment's place is the file path, the line, and the line's text quoted,
-- so the worker finds it after edits move the line. Comments come from a file
-- in a worker's worktree, or from either side of :FleetDiff!, whose tab
-- records the fleet and target it opened.

local note = require("fleet.note")
local actions = require("fleet.actions")

local M = {}

-- The current buffer's file, relative to its checkout, and the revision it
-- shows when it is a diffview revision buffer:
--   diffview://<git dir>/<11-character sha>/<path>
--   <repo>/.claude/worktrees/<fleet>-w<n>/<path>
local function place()
  local name = vim.api.nvim_buf_get_name(0)
  local rev, path = name:match("^diffview://.-/(%x%x%x%x%x%x%x%x%x%x%x)/(.+)$")
  if rev then return path, rev:sub(1, 7) end
  path = name:match("/%.claude/worktrees/[^/]+%-w%d+/(.+)$")
  return path, nil
end

-- fleet and task for the current buffer, from actions.target. place() has
-- already refused a note, so this is the :FleetDiff! tab's target, or the
-- task of the worker whose worktree holds the file.
local function target()
  local fleet, t = actions.target()
  fleet = fleet or actions.session_fleet()
  return fleet, actions.task(fleet, t)
end

-- The note a review can still go to: open in tasks/, with no end
local function open_note(fleet, task)
  local path = actions.notes_dir(fleet) .. "/tasks/" .. task .. ".md"
  local s = note.summary(path)
  if not s then return nil, task .. " has no open note in tasks/; review a closed task with :FleetFollowUp" end
  if (s["end"] or "") ~= "" then return nil, task .. " is closed; put the review in a follow-up with :FleetFollowUp" end
  return path, nil
end

local function quote(text)
  text = vim.trim(text):gsub("%s+", " "):gsub("`", "'")
  if vim.fn.strchars(text) > 60 then text = vim.fn.strcharpart(text, 0, 59) .. "…" end
  return text
end

-- Appends lines after the last item of a note's ## Todo section, below the
-- indented lines under it, such as a worker's `- reply:`, which belong to it
local function append_todo(path, item)
  local lines = vim.fn.readfile(path)
  local section, last = nil, nil
  for i, line in ipairs(lines) do
    local h = line:match("^## (.+)")
    if h then section = h elseif section == "Todo" and line:match("^%- %[") then last = i end
  end
  while last and lines[last + 1] and lines[last + 1]:match("^%s+%S") do last = last + 1 end
  if not last then
    for i, line in ipairs(lines) do
      if line == "## Todo" then last = i + 1; table.insert(lines, last, "") end
    end
  end
  if not last then return false end
  table.insert(lines, last + 1, item)
  vim.fn.writefile(lines, path)
  return true
end

local function pending(path)
  local n = 0
  for _, line in ipairs(vim.fn.readfile(path)) do
    if line:match("^%- %[ %] Review ") then n = n + 1 end
  end
  return n
end

local function err(msg) vim.notify("fleet: " .. msg, vim.log.levels.ERROR) end

function M.comment(o)
  local path, rev = place()
  if not path then return err("run :FleetComment from a file in a worker's worktree, or from :FleetDiff!") end
  local fleet, task = target()
  if not (fleet and task) then return err("this file's worker holds no task; open it with :FleetDiff! <task> to comment") end
  local notepath, why = open_note(fleet, task)
  if not notepath then return err(why) end
  local buf = vim.fn.bufnr(notepath)
  if buf ~= -1 and vim.bo[buf].modified then return err(task .. "'s note has unsaved changes; save it first") end

  local text = o.args ~= "" and o.args or vim.fn.input("Review " .. task .. ": ")
  if vim.trim(text) == "" then return end
  local first = o.range > 0 and o.line1 or vim.fn.line(".")
  local last = o.range > 0 and o.line2 or first
  local at = path .. ":" .. first .. (last > first and ("-" .. last) or "") .. (rev and (" at " .. rev) or "")
  local q = quote(vim.fn.getline(first))
  local item = ("- [ ] Review %s%s: %s"):format(at, q ~= "" and (" `" .. q .. "`") or "", vim.trim(text))
  if not append_todo(notepath, item) then return err(task .. "'s note has no ## Todo section") end
  if buf ~= -1 then vim.cmd("checktime " .. buf) end
  vim.notify(("fleet: %s has %d review comments to send; :FleetBump sends them"):format(task, pending(notepath)))
end

return M
