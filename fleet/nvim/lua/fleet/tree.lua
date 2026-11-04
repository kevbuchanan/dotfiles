-- Fleet note state in nvim-tree, through its public APIs only. A decorator
-- puts each fleet note's status icon in the sign column, which leaves the
-- file name its full width, and tints the name of a note that is blocked,
-- in review or errored. With
-- the cursor on a note, the command line shows the whole status: worker,
-- status, PR and todo progress. Notes are recognized by their frontmatter
-- (see fleet.note), so the folder doesn't matter. fleet.board shows every
-- task at once.
--
-- vimrc registers M.Decorator in nvim-tree's renderer.decorators and calls
-- M.attach() after nvim-tree's setup.

local note = require("fleet.note")
local api = require("nvim-tree.api")

local M = {}

-- Nerd Font glyphs, written as escapes because private-use characters don't
-- survive every editor and tool; each has its own highlight group linked to one every
-- colorscheme defines. nvim-tree names a sign after its icon's highlight
-- group, so the groups must be fleet's own: a sign named DiagnosticWarn
-- collides with nvim's diagnostics.
M.status = {
  assigned = { icon = "\u{f10c}", hl = "FleetTreeAssigned", link = "Comment" },
  progress = { icon = "\u{f110}", hl = "FleetTreeProgress", link = "DiagnosticInfo" },
  blocked = { icon = "\u{f059}", hl = "FleetTreeBlocked", link = "DiagnosticWarn" },
  review = { icon = "\u{f06e}", hl = "FleetTreeReview", link = "DiagnosticWarn" },
  error = { icon = "\u{f057}", hl = "FleetTreeError", link = "DiagnosticError" },
  done = { icon = "\u{f012c}", hl = "FleetTreeDone", link = "DiagnosticOk" },
  abandoned = { icon = "\u{f05e}", hl = "FleetTreeAbandoned", link = "Comment" },
}
for _, st in pairs(M.status) do
  vim.api.nvim_set_hl(0, st.hl, { link = st.link, default = true })
end

local function summary(node)
  if not node or node.type ~= "file" or not node.name:match("%.md$") then return nil end
  return note.summary(node.absolute_path)
end

-- A note's whole status as echo chunks: worker, status, PR and todos
function M.chunks(s)
  local out = {}
  local function add(text, hl)
    if #out > 0 then table.insert(out, { "  " }) end
    table.insert(out, { text, hl })
  end
  local seat = (s.worker or ""):match("%-(w%d+)$")
  add(s.task, "Title")
  if seat then add(seat, "Comment") end
  local st = M.status[s.status or ""]
  if st then add(st.icon .. " " .. s.status, st.hl) end
  if s.total > 0 then
    local todos = s.done .. "/" .. s.total .. " todos"
    if s.open > 0 then todos = todos .. ", " .. s.open .. " open questions" end
    add(todos, s.open > 0 and "DiagnosticWarn" or "Comment")
  end
  if (s.pr or "") ~= "" then add("\u{f407} " .. s.pr, "DiagnosticHint") end
  return out
end

M.Decorator = api.Decorator:extend()

function M.Decorator:new()
  self.enabled = true
  self.highlight_range = "name"
  self.icon_placement = "signcolumn"
  self.icons_by_status = {}
  for name, st in pairs(M.status) do
    local icon = { str = st.icon, hl = { st.hl } }
    self.icons_by_status[name] = icon
    self:define_sign(icon)
  end
end

function M.Decorator:icons(node)
  local s = summary(node)
  local icon = s and self.icons_by_status[s.status or ""]
  return icon and { icon } or nil
end

function M.Decorator:highlight_group(node)
  local s = summary(node)
  if s and (s.status == "blocked" or s.status == "review" or s.status == "error") then return M.status[s.status].hl end
  return nil
end

-- Cut to the command line's free width, so a narrow window never wraps the
-- line into a "Press ENTER" prompt.
local function fit(chunks)
  local room, out = vim.v.echospace, {}
  for _, c in ipairs(chunks) do
    if room <= 0 then break end
    local text = c[1]
    if vim.fn.strdisplaywidth(text) > room then text = vim.fn.strcharpart(text, 0, room - 1) .. "…" end
    room = room - vim.fn.strdisplaywidth(text)
    table.insert(out, { text, c[2] })
  end
  return out
end

-- With the cursor on a fleet note, echo its status; on anything else, clear
-- what an earlier note echoed. api.tree.get_node_under_cursor is public.
local shown = false
local function echo()
  local s = summary(api.tree.get_node_under_cursor())
  if s then
    vim.api.nvim_echo(fit(M.chunks(s)), false, {})
    shown = true
  elseif shown then
    vim.api.nvim_echo({ { "" } }, false, {})
    shown = false
  end
end

function M.attach()
  vim.api.nvim_create_autocmd("FileType", {
    group = vim.api.nvim_create_augroup("FleetTree", { clear = true }),
    pattern = "NvimTree",
    callback = function(ev)
      vim.api.nvim_create_autocmd("CursorMoved", { buffer = ev.buf, callback = echo })
    end,
  })
end

return M
