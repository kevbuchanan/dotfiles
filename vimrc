set nocompatible
filetype plugin indent on

call plug#begin('~/.vim/plugged')

Plug 'jelera/vim-javascript-syntax'
Plug 'mustache/vim-mustache-handlebars'
Plug 'tpope/vim-markdown'
Plug 'vim-ruby/vim-ruby'
Plug 'vim-scripts/ruby-matchit'
Plug 'tpope/vim-bundler'
Plug 'mattn/emmet-vim'
Plug 'vim-scripts/VimClojure'
Plug 'scrooloose/nerdtree'
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
Plug 'hdima/python-syntax'
Plug 'junegunn/vim-easy-align'
Plug 'elixir-lang/vim-elixir'
Plug 'fatih/vim-go'
Plug 'rust-lang/rust.vim'
Plug 'elmcast/elm-vim'
Plug '/usr/local/opt/fzf' | Plug 'junegunn/fzf.vim'
Plug 'hashivim/vim-terraform'
Plug 'udalov/kotlin-vim'
Plug 'cespare/vim-toml'
Plug 'neoclide/coc.nvim', {'branch': 'release'}
Plug 'vim-test/vim-test'
Plug 'kassio/neoterm'
Plug 'slim-template/vim-slim'

call plug#end()

nnoremap <silent><leader>1 :source ~/.vimrc \| :PlugInstall<CR>

let g:coc_global_extensions = [
      \ 'coc-rust-analyzer',
      \ 'coc-tsserver'
      \ ]

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

let vimclojure#HightlightBuiltins=1
let vimclojure#ParenRainbow=1
let g:paredit_matchlines=200
let g:paredit_mode=0
runtime macros/matchit.vim

autocmd FileType python setlocal tabstop=8 expandtab shiftwidth=4 softtabstop=4
let python_highlight_all=1

let NERDTreeShowHidden=1
let NERDTreeCascadeSingleChildDir=0

let g:haskell_conceal=0
set nofoldenable

set backspace=indent,eol,start
set nocompatible
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

set t_Co=256
colorscheme tomorrow-night

let mapleader = "\\"

nmap <Leader>v :set paste!<CR>
nmap <Leader>t :Files<CR>
nmap <Leader>a :Ag<CR>
vmap <Enter> <Plug>(EasyAlign)
nmap ga <Plug>(EasyAlign)

nmap <silent> t<C-n> :TestNearest<CR>
nmap <silent> t<C-f> :TestFile<CR>
nmap <silent> t<C-s> :TestSuite<CR>
nmap <silent> t<C-l> :TestLast<CR>
nmap <silent> t<C-g> :TestVisit<CR>

map <C-H> <C-W>h
map <C-L> <C-W>l
map <C-J> <C-W>j
map <C-K> <C-W>k
map <C-n> :NERDTreeToggle<CR>

:command W w

if filereadable(".vimrc.local")
  source .vimrc.local
endif

if filereadable(expand("~/.vimrc.coc"))
  source ~/.vimrc.coc
endif

if filereadable(expand("~/.config/nvim/coc.vim"))
  source ~/.config/nvim/coc.vim
endif
