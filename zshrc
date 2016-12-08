PATH=/usr/local/bin:/usr/local/sbin:$PATH

fpath=(~/.zsh $fpath)

autoload -U compinit && compinit

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
alias reload="source ~/.zshrc"
alias config="vim ~/.zshrc"
alias mongodb="mongod --config /usr/local/etc/mongod.conf"
alias postgres="postgres -D /usr/local/var/postgres"
if [ "$OSTYPE" "==" "linux-gnu" ]; then
  alias postgres="sudo /etc/init.d/postgresql start"
fi
PGDATA=/usr/local/var/postgres

bindkey "^J" history-incremental-search-backward
bindkey "^K" history-search-backward

eval "$(rbenv init -)"

PATH=$HOME/.rbenv/shims:$PATH
PATH=$PATH:$HOME/.rbenv/bin

PATH=$PATH:$HOME/.cabal/bin

export JAVA_HOME=$(/usr/libexec/java_home)

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

export DOCKER_HOST=tcp://192.168.59.103:2376
export DOCKER_CERT_PATH=/Users/kevinbuchanan/.boot2docker/certs/boot2docker-vm
export DOCKER_TLS_VERIFY=1

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
