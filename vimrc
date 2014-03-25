set rtp+=~/.vim/bundle/vundle/
call vundle#rc()

Bundle 'gmarik/vundle'
Bundle 'pangloss/vim-javascript'
Bundle 'tpope/vim-markdown'
Bundle 'tpope/vim-rails'
Bundle 'thoughtbot/vim-rspec'
Bundle 'kien/ctrlp.vim'
Bundle 'https://github.com/vim-ruby/vim-ruby'
Bundle 'https://github.com/vim-scripts/ruby-matchit'
Bundle 'https://github.com/mattn/emmet-vim'
Bundle 'https://github.com/gregsexton/MatchTag'
Bundle 'https://github.com/guns/vim-clojure-static'
Bundle 'https://github.com/scrooloose/nerdtree'
Bundle "https://github.com/tpope/vim-fugitive"
Bundle "https://github.com/tpope/vim-fireplace"

filetype plugin indent on
filetype detect

syntax enable

runtime macros/matchit.vim

let vimclojure#HightlightBuiltins=0
let vimclojure#ParenRainbow=1

let g:paredit_matchlines=200
let g:paredit_mode=0

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

:command W w

" Highlight trailing whitespace
autocmd InsertEnter * match ExtraWhitespace /\s\+\%#\@<!$/
autocmd BufRead,InsertLeave * match ExtraWhitespace /\s\+$/

" Autoremove trailing spaces when saving the buffer
autocmd FileType c,cpp,clj,eruby,html,java,javascript,php,ruby autocmd BufWritePre <buffer> :%s/\s\+$//e

" Highlight too-long lines
autocmd BufRead,InsertEnter,InsertLeave * 2match LineLengthError /\%126v.*/
highlight LineLengthError ctermbg=black guibg=black
autocmd ColorScheme * highlight LineLengthError ctermbg=black guibg=black

" Set up highlight group & retain through colorscheme changes
highlight ExtraWhitespace ctermbg=red guibg=red
autocmd ColorScheme * highlight ExtraWhitespace ctermbg=red guibg=red

let &t_Co=256
colorscheme tomorrow-night

autocmd BufWritePre * :%s/\s\+$//e

let mapleader = "\\"

map <C-H> <C-W>h
map <C-L> <C-W>l
map <C-J> <C-W>j
map <C-K> <C-W>k

map <C-n> :NERDTreeToggle<CR>

if filereadable(".vimrc.local")
  source .vimrc.local
endif

"Rspec.vim mappings
map <Leader>. :call RunCurrentSpecFile()<CR>
map <Leader>s :call RunNearestSpec()<CR>
map <Leader>l :call RunLastSpec()<CR>
map <Leader>a :call RunAllSpecs()<CR>
