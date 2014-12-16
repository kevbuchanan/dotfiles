PATH=/usr/local/bin:/usr/local/sbin:$PATH

fpath=(~/.zsh $fpath)

autoload -U compinit && compinit

alias tmux='tmux -2'
if [ "$OSTYPE" "==" "linux-gnu" ]; then
  alias ls="ls -AF --color"
  alias lsl="ls -l"
else
  alias ls="ls -AFG"
  alias lsl="ls -hl"
fi
alias be="bundle exec "
alias bi="bundle install"
alias reload="source ~/.zshrc"
alias config="vim ~/.zshrc"
alias mongodb="mongod --config /usr/local/etc/mongod.conf"
alias postgres="postgres -D /usr/local/var/postgres"
if [ "$OSTYPE" "==" "linux-gnu" ]; then
  alias postgres="sudo /etc/init.d/postgresql start"
fi
PGDATA=/usr/local/var/postgres

bindkey "^H" beginning-of-line
bindkey "^L" end-of-line
bindkey "^J" history-incremental-search-backward
bindkey "^K" history-search-backward

eval "$(rbenv init -)"

PATH=$HOME/.rbenv/shims:$PATH
PATH=$PATH:$HOME/.rbenv/bin

PATH=$PATH:$HOME/.cabal/bin

export JAVA_HOME=$(/usr/libexec/java_home)

autoload colors; colors;
export LSCOLORS="Gxfxcxdxbxegedabagacad"
setopt prompt_subst

zstyle ':completion:*:*:git:*' script ~/.zsh/git-completion.bash
ZSH_THEME_GIT_PROMPT_PREFIX="git:(%{$fg[red]%}"
ZSH_THEME_GIT_PROMPT_SUFFIX="%{$reset_color%}"
ZSH_THEME_GIT_PROMPT_DIRTY="%{$fg[blue]%}) %{$fg[yellow]%}✗%{$reset_color%}"
ZSH_THEME_GIT_PROMPT_CLEAN="%{$fg[blue]%})"

local ret_status="%(?:%{$fg_bold[green]%}➜ :%{$fg_bold[red]%}➜ %s)"

PROMPT='${ret_status}%{$fg_bold[green]%}%p %{$fg[cyan]%}%c %{$fg_bold[blue]%}$(git_prompt_info)%{$fg_bold[blue]%} % %{$reset_color%}'

function parse_git_dirty() {
  if command git diff --quiet HEAD 2> /dev/null; then
    echo "$ZSH_THEME_GIT_PROMPT_CLEAN"
  else
    echo "$ZSH_THEME_GIT_PROMPT_DIRTY"
  fi
}

function git_prompt_info() {
  ref=$(command git symbolic-ref HEAD 2> /dev/null) || \
  ref=$(command git rev-parse --short HEAD 2> /dev/null) || return
  echo "$ZSH_THEME_GIT_PROMPT_PREFIX${ref#refs/heads/}$(parse_git_dirty)$ZSH_THEME_GIT_PROMPT_SUFFIX"
}

function ip() {
  ifconfig | grep "broadcast"
}

# get public keys from github, ssh_key_for <github username>
function ssh_key_for() {
  curl -i https://api.github.com/users/${1}/keys
}

# one time setup to add pair alias and only allow public key authentication through ssh pair@<localhostname>.local
function set_pair_config() {
  sudo dscl . -append /Users/$USER RecordName Pair pair
  sudo sed -E -i.bak 's/^#?(PasswordAuthentication|ChallengeResponseAuthentication).*$/\1 no/' /etc/sshd_config
}

# authorize a public key to attach to the pair tmux session, add_pair <public key>
function add_pair() {
  command="command=\"/usr/local/bin/tmux attach -t pair\" "
  command+=${1}
  echo $command >> ~/.ssh/authorized_keys
}

# watch for changes in files with $1 pattern and run $2 command on change, watch <extension> <command>
function watch() {
  pattern=$1
  command=$2

  time=0
  time_format="-f %m"
  if [ "$OSTYPE" "==" "linux-gnu" ]; then
    time_format="--format %X"
  fi
  while true; do
    newtime=$(find $~pattern | eval "xargs stat ${time_format}" | sort -n -r | head -1)
    if [ "$newtime" -gt "$time" ]; then
      clear
      eval $command
    fi
    time=$newtime;
    sleep 1
  done
}

# export key for <email>
function export-pgp() {
  gpg --armor --export $1
}

# encrypt message for <email> from clipboard
function encrypt-to() {
  echo $2 | gpg --encrypt --armor --recipient $1 | pbcopy
  echo "Message encrypted to $1 and copied to clipboard"
}

# decrypt from clipboard
function decrypt() {
  pbpaste | gpg --decrypt
}

# find pgp key for <name or email>
function find-pgp() {
  gpg --keyserver hkp://pgp.mit.edu --search-keys $1
}
