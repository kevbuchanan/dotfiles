-- Reads fleet task notes. A note is a markdown file whose YAML frontmatter
-- has `fleet:` and `task:` keys, which name its fleet and task id, so nothing
-- here guesses from a path. Shared by plugin/fleet.lua and fleet.tree.

local M = {}

-- The frontmatter of a note's lines as a table of strings, or nil when the
-- lines don't start with a fleet note's frontmatter.
function M.parse(lines)
  if lines[1] ~= "---" then return nil end
  local meta = {}
  for i = 2, #lines do
    local line = lines[i]
    if line == "---" then
      if (meta.fleet or "") ~= "" and (meta.task or "") ~= "" then return meta end
      return nil
    end
    local key, value = line:match("^([%w_]+):%s*(.-)%s*$")
    if key then meta[key] = value end
  end
  return nil
end

-- The current buffer's note frontmatter, from its unsaved text.
function M.buffer(buf)
  return M.parse(vim.api.nvim_buf_get_lines(buf or 0, 0, 40, false))
end

-- Counts as hooks/task-progress does: top-level checkboxes under ## Todo,
-- and unchecked top-level checkboxes under ## Questions.
local function progress(lines)
  local section, done, total, open = nil, 0, 0, 0
  for _, line in ipairs(lines) do
    local heading = line:match("^## (.+)")
    if heading then
      section = heading
    elseif section == "Todo" and line:match("^%- %[[ xX]%]") then
      total = total + 1
      if line:match("^%- %[[xX]%]") then done = done + 1 end
    elseif section == "Questions" and line:match("^%- %[ %]") then
      open = open + 1
    end
  end
  return done, total, open
end

-- A note file's frontmatter plus todo progress, cached by size and
-- modification time, so redrawing a tree costs a stat per markdown file.
-- Files that aren't fleet notes cost one short read, then a stat.
local cache = {}
function M.summary(path)
  local stat = vim.uv.fs_stat(path)
  if not stat or stat.type ~= "file" then return nil end
  local stamp = stat.mtime.sec .. "." .. stat.mtime.nsec .. ":" .. stat.size
  local hit = cache[path]
  if hit and hit.stamp == stamp then return hit.summary end
  local summary = nil
  local fd = io.open(path, "r")
  if fd then
    local first = fd:read("*l")
    if first == "---" then
      local lines = { first }
      for line in fd:lines() do table.insert(lines, line) end
      local meta = M.parse(lines)
      if meta then
        meta.done, meta.total, meta.open = progress(lines)
        -- the note's title, the first "# " heading, without its "<id>: "
        for _, line in ipairs(lines) do
          local title = line:match("^# (.+)")
          if title then
            meta.title = title:gsub("^" .. vim.pesc(meta.task) .. ":%s*", "")
            break
          end
        end
        summary = meta
      end
    end
    fd:close()
  end
  cache[path] = { stamp = stamp, summary = summary }
  return summary
end

return M
