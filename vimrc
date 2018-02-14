set nocompatible
filetype off
call plug#begin('~/.vim/plugged')

Plug 'jelera/vim-javascript-syntax'
Plug 'mustache/vim-mustache-handlebars'
Plug 'tpope/vim-markdown'
Plug 'vim-ruby/vim-ruby'
Plug 'vim-scripts/ruby-matchit'
Plug 'tpope/vim-bundler'
Plug 'mattn/emmet-vim'
Plug 'gregsexton/MatchTag'
Plug 'vim-scripts/VimClojure'
Plug 'scrooloose/nerdtree'
Plug 'tpope/vim-fugitive'
Plug 'tpope/vim-fireplace'
Plug 'kchmck/vim-coffee-script'
Plug 'nelstrom/vim-visual-star-search'
Plug 'Keithbsmiley/swift.vim'
Plug 'dag/vim2hs'
Plug 'jimenezrick/vimerl'
Plug 'hdima/python-syntax'
Plug 'junegunn/vim-easy-align'
Plug 'elixir-lang/vim-elixir'
Plug 'fatih/vim-go'
Plug 'leafgarland/typescript-vim'
Plug 'Quramy/tsuquyomi'
Plug 'Shougo/vimproc.vim'
Plug 'mxw/vim-jsx'
Plug 'rust-lang/rust.vim'
Plug 'elmcast/elm-vim'
Plug '/usr/local/opt/fzf' | Plug 'junegunn/fzf.vim'
Plug 'hashivim/vim-terraform'

call plug#end()

filetype plugin indent on
syntax on
filetype detect
set clipboard=unnamed

autocmd BufRead,BufNewFile *.cljs setlocal filetype=clojure
autocmd BufRead,BufNewFile *.clj setlocal filetype=clojure
autocmd BufRead,BufNewFile *.hiccup setlocal filetype=clojure
autocmd FileType clojure setlocal lispwords+=describe,it,context,around,deftest,testing,with-redefs,defspec,facts,fact,defproject

autocmd BufRead,BufNewFile *.erl,*.es.*.hrl,*.yaws,*.xrl,*.src set tabstop=4 shiftwidth=4
au BufNewFile,BufRead *.erl,*.es,*.hrl,*.yaws,*.xrl,*.src setf erlang

autocmd BufRead,BufNewFile *.java set tabstop=4 shiftwidth=4

autocmd BufRead,BufNewFile Capfile setlocal filetype=ruby

autocmd BufRead,BufNewFile *.fodt.eex setlocal filetype=xml

vmap <Enter> <Plug>(EasyAlign)
nmap ga <Plug>(EasyAlign)

let g:typescript_compiler_binary = 'tsc'
let g:typescript_compiler_options = '--experimentalDecorators'

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

let g:tsuquyomi_completion_detail=1
let g:tsuquyomi_single_quote_import=1

set backspace=indent,eol,start
set nocompatible
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

set t_Co=256
colorscheme tomorrow-night

let mapleader = "\\"

nmap <Leader>v :set paste!<CR>
nmap <Leader>t :Files<CR>
nmap <Leader>r :Tags<CR>
nmap <Leader>a :Ag<CR>

map <C-H> <C-W>h
map <C-L> <C-W>l
map <C-J> <C-W>j
map <C-K> <C-W>k

:command W w

map <C-n> :NERDTreeToggle<CR>

if filereadable(".vimrc.local")
  source .vimrc.local
endif
