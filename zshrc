PATH=/usr/local/bin:/usr/local/sbin:$PATH

fpath=(~/.zsh $fpath)

autoload -U compinit && compinit

export EDITOR="vim"
bindkey -e

alias tmux="tmux -2"
alias tma="tmux attach -t"

if [ "$OSTYPE" "==" "linux-gnu" ]; then
  alias ls="ls -AF --color"
  alias lsl="ls -l"
else
  alias ls="ls -AFG"
  alias lsl="ls -hl"
fi

alias be="bundle exec "
alias bi="bundle install"
alias clj="drip -cp ~/.m2/repository/org/clojure/clojure/1.8.0/clojure-1.8.0.jar clojure.main"
alias pst="pstree"
alias reload="source ~/.zshrc && source ~/.zshenv"
alias config="vim ~/.zshrc"

alias mongodb="mongod --config /usr/local/etc/mongod.conf"
alias postgres="postgres -D /usr/local/var/postgres"
if [ "$OSTYPE" "==" "linux-gnu" ]; then
  alias postgres="sudo /etc/init.d/postgresql start"
fi
export PGDATA=/usr/local/var/postgres

bindkey "^J" history-incremental-search-backward
bindkey "^K" history-search-backward

PATH=$PATH:$HOME/.cabal/bin

# Set JAVA_HOME from asdf java version
. ~/.asdf/plugins/java/set-java-home.zsh

if [ -e /usr/local/opt/fzf/shell/completion.zsh ]; then
  source /usr/local/opt/fzf/shell/key-bindings.zsh
  source /usr/local/opt/fzf/shell/completion.zsh
fi

export FZF_DEFAULT_COMMAND='ag --nocolor -g ""'
export FZF_CTRL_T_COMMAND="$FZF_DEFAULT_COMMAND"
export FZF_ALT_C_COMMAND="$FZF_DEFAULT_COMMAND"
export FZF_DEFAULT_OPTS='
--color fg:242,bg:236,hl:65,fg+:15,bg+:239,hl+:108
--color info:108,prompt:109,spinner:108,pointer:168,marker:168
'

# prompt
autoload colors; colors;
export LSCOLORS="Gxfxcxdxbxegedabagacad"
setopt prompt_subst

ZSH_THEME_GIT_PROMPT_PREFIX=" %{$fg[red]%}❯❯ "
ZSH_THEME_GIT_PROMPT_SUFFIX="%{$reset_color%}"
ZSH_THEME_GIT_PROMPT_DIRTY="%{$fg[yellow]%} +"
ZSH_THEME_GIT_PROMPT_CLEAN=""

local ret_status="%(?:%{$fg_bold[green]%}❯❯:%{$fg_bold[red]%}❯❯%s)"
PROMPT='%{$fg_bold[blue]%}❯❯ %n %{$fg[cyan]%}❯❯ %1d%{$fg_bold[blue]%}$(git_prompt_info)%{$fg_bold[blue]%} ${ret_status} %{$reset_color%}'

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
# end prompt

function mkcd() {
  mkdir -p $1
  cd $1
}

function ip() {
  curl ipecho.net/plain
}

function utcdate() {
  TZ=UTC date '+%Y.%m.%d_%H.%M'
}

function uuid() {
  ruby -e 'require "securerandom"; puts SecureRandom.uuid'
}

# get public keys from github, ssh_key_for <github username>
function ssh_key_for() {
  curl -i https://api.github.com/users/${1}/keys
}

# one time setup to add pair alias and only allow public key authentication through ssh pair@<localhostname>.local
function set_pair_config() {
  sudo dscl . -append /Users/$USER RecordName Pair pair
  sudo sed -E -i.bak 's/^#?(PasswordAuthentication|ChallengeResponseAuthentication).*$/\1 no/' /etc/ssh/sshd_config
}

# authorize a public key to attach to the pair tmux session, add_pair <public key>
function add_pair() {
  command="command=\"/usr/local/bin/tmux attach -t pair\" "
  command+=${1}
  echo $command >> ~/.ssh/authorized_keys
}

# watch for changes in files with $1 pattern and run $2 command on change, watch <extension> <command>
function wchange() {
  pattern=$1
  shift
  command=$@

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

function git-open {
  git remote -v | grep ${1=origin} | grep push | \
  awk '{ print $2 }' | \
  sed 's/git@/https:\/\//' | sed 's/\.git//' | sed 's/\.com:/\.com\//' | \
  xargs open
}

function docker-clean {
  docker rm $(docker ps -a -q)
  docker rmi $(docker images | grep '^<none>' | awk '{ print $3 }')
}

export GOPATH=$HOME/code/go
export PATH=$PATH:$GOPATH/bin

function replace() {
  find_this="$1"
  shift
  replace_with="$1"
  shift

  temp="${TMPDIR:-/tmp}/replace_temp_file.$$"
  IFS=$'\n'
  for item in $(ag -l --nocolor "$find_this" "$@"); do
    sed "s/$find_this/$replace_with/g" "$item" > "$temp" && mv "$temp" "$item"
  done
}

function remove() {
  find_this="$1"
  shift

  temp="${TMPDIR:-/tmp}/remove_temp_file.$$"
  IFS=$'\n'
  for item in $(ag -l --nocolor "$find_this" "$@"); do
    sed "/$find_this/d" "$item" > "$temp" && mv "$temp" "$item"
  done
}

function rename() {
  replace="$1"
  shift
  with="$2"
  shift
  for file in "$@"; do
    mv "$file" "${file%replace}$with"
  done
}

function highlight() {
  grep --color "$1\|$"
}

function find_largest() {
  du -sh *  | grep -E "\d[M|G]"
}

function find_largest_in() {
  du -k "$1" | awk '$1 > 100000' | sort -nr
}

source ~/.zsh/tmuxinator.zsh
source ~/.asdf/asdf.sh
source /opt/homebrew/opt/asdf/libexec/asdf.sh
source ~/.cargo/env
source ~/.poetry/env

export ERL_AFLAGS="-kernel shell_history enabled"

function air() {
  curl -s "http://www.airnowapi.org/aq/observation/zipCode/current/?format=application/json&zipCode=$1&API_KEY=57A93924-AE07-44F4-8EB3-EF834610F42D" | jq 'map({ "type": .ParameterName, "value": .AQI, "category": .Category.Name })'
}
