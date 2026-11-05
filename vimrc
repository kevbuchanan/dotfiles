set nocompatible
filetype plugin indent on

" nvim-tree opens directories, so netrw must not load first
if has('nvim')
  let g:loaded_netrw = 1
  let g:loaded_netrwPlugin = 1
endif

call plug#begin('~/.vim/plugged')

Plug 'mustache/vim-mustache-handlebars'
Plug 'tpope/vim-markdown'
Plug 'vim-ruby/vim-ruby'
Plug 'tpope/vim-bundler'
Plug 'mattn/emmet-vim'
if has('nvim')
  Plug 'nvim-tree/nvim-tree.lua'
  Plug 'lewis6991/gitsigns.nvim', { 'branch': 'main' }
  Plug 'sindrets/diffview.nvim', { 'branch': 'main' }
  Plug 'MeanderingProgrammer/render-markdown.nvim', { 'branch': 'main' }
else
  Plug 'scrooloose/nerdtree'
endif
Plug 'tpope/vim-fugitive'
Plug 'tpope/vim-fireplace'
Plug 'pangloss/vim-javascript'
Plug 'leafgarland/typescript-vim'
Plug 'maxmellon/vim-jsx-pretty'
Plug 'jparise/vim-graphql'
Plug 'nelstrom/vim-visual-star-search'
Plug 'Keithbsmiley/swift.vim'
Plug 'dag/vim2hs'
Plug 'jimenezrick/vimerl'
Plug 'junegunn/vim-easy-align'
Plug 'elixir-lang/vim-elixir'
Plug 'rust-lang/rust.vim'
Plug 'elmcast/elm-vim'
Plug 'junegunn/fzf', { 'do': { -> fzf#install() } }
Plug 'junegunn/fzf.vim'
Plug 'hashivim/vim-terraform'
Plug 'udalov/kotlin-vim'
Plug 'cespare/vim-toml'
Plug 'neoclide/coc.nvim', {'branch': 'release'}
Plug 'vim-test/vim-test'
Plug 'kassio/neoterm'
Plug 'slim-template/vim-slim'
Plug 'iamcco/markdown-preview.nvim', { 'do': 'cd app && npx --yes yarn install' }

call plug#end()

nnoremap <silent><leader>1 :source ~/.vimrc \| :PlugInstall<CR>

let g:coc_global_extensions = [
      \ 'coc-rust-analyzer',
      \ 'coc-tsserver',
      \ 'coc-deno',
      \ 'coc-java',
      \ ]
let g:coc_disable_transparent_cursor = 1

syntax on
set clipboard=unnamed

let test#strategy = "neoterm"
let g:neoterm_default_mod = "botright vertical"
let g:neoterm_shell = "zsh"
let g:neoterm_keep_term_open = 0

autocmd BufRead,BufNewFile *.cljs setlocal filetype=clojure
autocmd BufRead,BufNewFile *.clj setlocal filetype=clojure
autocmd BufRead,BufNewFile *.hiccup setlocal filetype=clojure
autocmd FileType clojure setlocal lispwords+=describe,it,context,around,deftest,testing,with-redefs,defspec,facts,fact,defproject

autocmd BufRead,BufNewFile *.erl,*.es.*.hrl,*.yaws,*.xrl,*.src set tabstop=4 shiftwidth=4
au BufNewFile,BufRead *.erl,*.es,*.hrl,*.yaws,*.xrl,*.src setf erlang

autocmd BufRead,BufNewFile *.java set tabstop=4 shiftwidth=4

autocmd BufRead,BufNewFile Capfile setlocal filetype=ruby

autocmd BufRead,BufNewFile *.fodt.eex setlocal filetype=xml

runtime macros/matchit.vim

autocmd FileType python setlocal tabstop=8 expandtab shiftwidth=4 softtabstop=4
let python_highlight_all=1

let NERDTreeShowHidden=1
let NERDTreeCascadeSingleChildDir=0

if has('nvim')
lua << EOF
-- agents edit files while this pane is unfocused, so autoread never gets a
-- focus event to act on; checktime reloads every unmodified buffer whose file
-- changed on disk
vim.uv.new_timer():start(1000, 1000, vim.schedule_wrap(function()
  if vim.fn.mode() ~= 'c' then vim.cmd('silent! checktime') end
end))

-- pcall keeps startup clean before :PlugInstall has fetched the plugins
local ok, tree = pcall(require, 'nvim-tree')
if ok then
  -- nvim-tree's default decorators, plus fleet's note-state decorator after
  -- Git when the fleet module is installed (see fleet/nvim/lua/fleet/tree.lua)
  local decorators = { "Git", "Open", "Hidden", "Modified", "Bookmark", "Diagnostics", "Copied", "Cut" }
  local ok_fleet, fleet_tree = pcall(require, 'fleet.tree')
  if ok_fleet then table.insert(decorators, 2, fleet_tree.Decorator) end
  -- show dotfiles and ignored files and never fold single-child folders,
  -- matching the NERDTree settings above
  tree.setup({
    filters = { dotfiles = false, git_ignored = false },
    renderer = { group_empty = false, decorators = decorators },
    -- The tree redraws when files change, and agents change files in fleet
    -- notes folders often. A key pressed mid-redraw can land on a line with
    -- no node, and nvim-tree 1.19's open actions index that nil. The open
    -- keys here skip a line with no node; every other key is the default.
    on_attach = function(bufnr)
      local api = require('nvim-tree.api')
      api.map.on_attach.default(bufnr)
      local open = {
        ['<CR>'] = api.node.open.edit,
        ['o'] = api.node.open.edit,
        ['<2-LeftMouse>'] = api.node.open.edit,
        ['<Tab>'] = api.node.open.preview,
        ['<C-t>'] = api.node.open.tab,
        ['<C-v>'] = api.node.open.vertical,
        ['<C-x>'] = api.node.open.horizontal,
      }
      for key, fn in pairs(open) do
        vim.keymap.set('n', key, function()
          if api.tree.get_node_under_cursor() then fn() end
        end, { buffer = bufnr, noremap = true, silent = true, nowait = true, desc = 'nvim-tree: open' })
      end
    end,
  })
  -- fleet's status lines under each note; see fleet/nvim/lua/fleet/tree.lua
  if ok_fleet then fleet_tree.attach() end
end

local ok_gs, gitsigns = pcall(require, 'gitsigns')
if ok_gs then gitsigns.setup() end

-- file icons need nvim-web-devicons, which is not installed
local ok_dv, diffview = pcall(require, 'diffview')
-- q closes diffview from its diff buffers and file panels, as q quits the
-- pager in :FleetDiff's unified view
local dv_close = { "n", "q", "<cmd>DiffviewClose<cr>", { desc = "Close diffview" } }
if ok_dv then
  diffview.setup({
    use_icons = false,
    keymaps = { view = { dv_close }, file_panel = { dv_close }, file_history_panel = { dv_close } },
  })
end

-- breakindent indents a wrapped list item by its raw prefix, six columns for
-- "- [ ] ". render-markdown hides the bullet and draws the checkbox in three,
-- so padding brings the drawn prefix back to six and wrapped text lines up
-- under the item's text.
-- A checked box is the filled checkbox-marked glyph, which reads larger than
-- the default outline one at the same cell size, in tomorrow-night's green;
-- glyphs are escapes because private-use characters don't survive every tool.
local ok_rm, render_markdown = pcall(require, 'render-markdown')
if ok_rm then
  render_markdown.setup({
    checkbox = {
      left_pad = 2,
      right_pad = 2,
      unchecked = { icon = '\u{f0131} ' },
      checked = { icon = '\u{f0132} ' },
    },
  })
  local function checked_color()
    vim.api.nvim_set_hl(0, 'RenderMarkdownChecked', { fg = '#b5bd68', ctermfg = 143 })
  end
  checked_color()
  vim.api.nvim_create_autocmd('ColorScheme', { callback = checked_color })
end

-- Markdown: treesitter highlighting, which render-markdown.nvim builds on
-- (nvim ships the parsers), and soft wrapping. Lines wrap at word boundaries
-- and continue at their own indentation; list items continue under their
-- text, past the bullet and any checkbox, which formatlistpat matches.
vim.api.nvim_create_autocmd('FileType', {
  pattern = 'markdown',
  callback = function()
    pcall(vim.treesitter.start)
    vim.opt_local.wrap = true
    vim.opt_local.linebreak = true
    vim.opt_local.breakindent = true
    vim.opt_local.breakindentopt = 'list:-1'
    vim.opt_local.formatlistpat = [[^\s*\d\+\.\s\+\|^\s*[-*+]\s\+\(\[[ xX]\]\s\+\)\=]]
  end,
})
EOF
endif

let g:haskell_conceal=0
set nofoldenable

let g:terraform_fmt_on_save=1

let g:mkdp_theme = 'light'

set backspace=indent,eol,start
set visualbell
set ruler
set wildmenu
set tabstop=2
set shiftwidth=2
set expandtab
set laststatus=2
set showcmd
set hlsearch
set incsearch
set history=1000
set undolevels=1000
set autoread
set nobackup
set noswapfile
set number
set numberwidth=5
set list
set listchars=tab:>-,trail:.
set ignorecase
set smartcase
set nowrap
set completeopt=longest,menu
set wildmode=list:longest,list:full
set scrolloff=4

" Highlight trailing whitespace
autocmd InsertEnter * match ExtraWhitespace /\s\+\%#\@<!$/
autocmd BufRead,InsertLeave * match ExtraWhitespace /\s\+$/

" Autoremove trailing spaces when saving the buffer
autocmd FileType c,cpp,clj,eruby,html,java,javascript,php,ruby autocmd BufWritePre <buffer> :%s/\s\+$//e
autocmd BufWritePre * :%s/\s\+$//e

" Highlight too-long lines
autocmd BufRead,InsertEnter,InsertLeave * 2match LineLengthError /\%126v.*/
highlight LineLengthError ctermbg=black guibg=black
autocmd ColorScheme * highlight LineLengthError ctermbg=black guibg=black

" Set up highlight group & retain through colorscheme changes
highlight ExtraWhitespace ctermbg=red guibg=red
autocmd ColorScheme * highlight ExtraWhitespace ctermbg=red guibg=red

autocmd FileType swift setlocal tabstop=2
autocmd FileType swift setlocal softtabstop=2
autocmd FileType swift setlocal shiftwidth=2

" Diff mode tints only the background, so changed lines keep their syntax
" colors. nvim's default diff groups also set a foreground, which paints over
" syntax, and tomorrow-night defines none of them.
function! s:DiffColors()
  highlight DiffAdd    ctermbg=22  guibg=#1e3a28 ctermfg=NONE guifg=NONE cterm=NONE gui=NONE
  highlight DiffDelete ctermbg=52  guibg=#3a1e22 ctermfg=NONE guifg=NONE cterm=NONE gui=NONE
  highlight DiffChange ctermbg=236 guibg=#262a33 ctermfg=NONE guifg=NONE cterm=NONE gui=NONE
  highlight DiffText   ctermbg=24  guibg=#2c4a6e ctermfg=NONE guifg=NONE cterm=NONE gui=NONE
endfunction
autocmd ColorScheme * call s:DiffColors()
" histogram aligns moved blocks, and indent-heuristic keeps a re-indented
" block in one hunk
set diffopt+=algorithm:histogram,indent-heuristic

if !has('nvim')
  set t_Co=256
endif
colorscheme tomorrow-night

let mapleader = "\\"

nmap <Leader>v :set paste!<CR>
nmap <Leader>t :Files<CR>
nmap <Leader>g :Rg<CR>
vmap <Enter> <Plug>(EasyAlign)
nmap ga <Plug>(EasyAlign)

" toggle the first markdown checkbox on the line, for answering fleet questions
nnoremap <silent> <Leader>x :s/\[\([ xX]\)\]/\=submatch(1) == ' ' ? '[x]' : '[ ]'/e<CR>:noh<CR>
nnoremap <Leader>s :!fleet status<CR>

nmap <silent> t<C-n> :TestNearest<CR>
nmap <silent> t<C-f> :TestFile<CR>
nmap <silent> t<C-s> :TestSuite<CR>
nmap <silent> t<C-l> :TestLast<CR>
nmap <silent> t<C-g> :TestVisit<CR>

map <C-H> <C-W>h
map <C-L> <C-W>l
map <C-J> <C-W>j
map <C-K> <C-W>k
if has('nvim')
  map <C-n> :NvimTreeToggle<CR>
else
  map <C-n> :NERDTreeToggle<CR>
endif

:command W w

:set statusline=%f

if filereadable(".vimrc.local")
  source .vimrc.local
endif

if filereadable(expand("~/.vimrc.coc"))
  source ~/.vimrc.coc
endif

if filereadable(expand("~/.config/nvim/coc.vim"))
  source ~/.config/nvim/coc.vim
  set statusline=%f\ %{coc#status()}
endif

set statusline+=%=                      " Right side
set statusline+=ln\ %02l/%L\ :\ %02v\  " ln <line number> / <total lines> : <column number>
