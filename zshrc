# Homebrew, then compinit, so Homebrew's site-functions are on fpath when the
# completion cache is built
export HOMEBREW_PREFIX="/opt/homebrew";
export HOMEBREW_CELLAR="/opt/homebrew/Cellar";
export HOMEBREW_REPOSITORY="/opt/homebrew";
fpath[1,0]="/opt/homebrew/share/zsh/site-functions";
eval "$(/usr/bin/env PATH_HELPER_ROOT="/opt/homebrew" /usr/libexec/path_helper -s)"
[ -z "${MANPATH-}" ] || export MANPATH=":${MANPATH#:}";
export INFOPATH="/opt/homebrew/share/info:${INFOPATH:-}";

autoload -U compinit && compinit

export EDITOR="vim"
bindkey -e

HISTFILE=~/.zsh_history
HISTSIZE=100000
SAVEHIST=100000
setopt share_history inc_append_history hist_ignore_all_dups hist_reduce_blanks

if [ "$OSTYPE" "==" "linux-gnu" ]; then
  alias ls="ls -AF --color"
  alias lsl="ls -l"
else
  alias ls="ls -AFG"
  alias lsl="ls -hl"
fi

alias be="bundle exec "
alias bi="bundle install"
alias pst="pstree"
alias reload="source ~/.zshrc"
alias config="vim ~/.zshrc"

bindkey "^J" history-incremental-search-backward
bindkey "^K" history-search-backward

source <(fzf --zsh)

export FZF_DEFAULT_COMMAND="rg --files --hidden --glob '!.git'"
export FZF_CTRL_T_COMMAND="$FZF_DEFAULT_COMMAND"
if (( $+commands[fd] )); then
  export FZF_ALT_C_COMMAND="fd --type d --hidden --exclude .git"
fi
export FZF_DEFAULT_OPTS='
--color fg:242,bg:236,hl:65,fg+:15,bg+:239,hl+:108
--color info:108,prompt:109,spinner:108,pointer:168,marker:168
'

eval "$(direnv hook zsh)"
(( $+commands[zoxide] )) && eval "$(zoxide init zsh)"

# prompt
autoload colors; colors;
autoload -Uz add-zsh-hook vcs_info
export LSCOLORS="Gxfxcxdxbxegedabagacad"
setopt prompt_subst

# vcs_info's git backend reports staged (+) and unstaged (*) changes but not
# untracked files, so the git-untracked hook adds the ? marker
zstyle ':vcs_info:*' enable git
zstyle ':vcs_info:git:*' check-for-changes true
zstyle ':vcs_info:git:*' stagedstr "%{$fg[yellow]%} +"
zstyle ':vcs_info:git:*' unstagedstr "%{$fg[yellow]%} *"
zstyle ':vcs_info:git:*' formats " %{$fg[red]%}❯❯ %b%c%u%m%{$reset_color%}"
zstyle ':vcs_info:git:*' actionformats " %{$fg[red]%}❯❯ %b|%a%c%u%m%{$reset_color%}"
zstyle ':vcs_info:git*+set-message:*' hooks git-untracked

function +vi-git-untracked() {
  if [[ -n $(git ls-files --others --exclude-standard --directory --no-empty-directory -- ':/' 2> /dev/null | head -1) ]]; then
    hook_com[misc]="%{$fg[yellow]%} ?"
  fi
}

add-zsh-hook precmd vcs_info

# user@host only over ssh, and a job count only when jobs are suspended
local ret_status="%(?:%{$fg_bold[green]%}❯❯:%{$fg_bold[red]%}❯❯)"
PROMPT='%{$fg_bold[blue]%}${SSH_CONNECTION:+❯❯ %n@%m }%(1j.❯❯ %j& .)%{$fg[cyan]%}❯❯ %1d%{$fg_bold[blue]%}${vcs_info_msg_0_}%{$fg_bold[blue]%} ${ret_status} %{$reset_color%}'
# end prompt
# mise reads the existing ~/.tool-versions. asdf stays as the fallback until
# mise is installed and the java version resolves under it.
if (( $+commands[mise] )); then
  eval "$(mise activate zsh)"
else
  source /opt/homebrew/opt/asdf/libexec/asdf.sh
  . ~/.asdf/plugins/java/set-java-home.zsh
fi

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

function replace() {
  find_this="$1"
  shift
  replace_with="$1"
  shift

  temp="${TMPDIR:-/tmp}/replace_temp_file.$$"
  IFS=$'\n'
  for item in $(rg -l "$find_this" "$@"); do
    sed "s/$find_this/$replace_with/g" "$item" > "$temp" && mv "$temp" "$item"
  done
}

function remove() {
  find_this="$1"
  shift

  temp="${TMPDIR:-/tmp}/remove_temp_file.$$"
  IFS=$'\n'
  for item in $(rg -l "$find_this" "$@"); do
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

export GOPATH=$HOME/code/go
export PATH=$PATH:$GOPATH/bin

source ~/.cargo/env

export ERL_AFLAGS="-kernel shell_history enabled"

# the AirNow key lives in the login keychain:
#   security add-generic-password -a "$USER" -s airnow -w <key>
function air() {
  local key=$(security find-generic-password -s airnow -w)
  curl -s "http://www.airnowapi.org/aq/observation/zipCode/current/?format=application/json&zipCode=$1&API_KEY=$key" | jq 'map({ "type": .ParameterName, "value": .AQI, "category": .Category.Name })'
}

### MANAGED BY RANCHER DESKTOP START (DO NOT EDIT)
export PATH="/Users/kbuchanan/.rd/bin:$PATH"
### MANAGED BY RANCHER DESKTOP END (DO NOT EDIT)

# bun completions
[ -s "/Users/kbuchanan/.bun/_bun" ] && source "/Users/kbuchanan/.bun/_bun"

# bun
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
export PATH="$HOME/.local/bin:$PATH"

# machine-specific aliases and settings, kept out of this public repo
[ -f ~/.zshrc.local ] && source ~/.zshrc.local

# claude in a git worktree of the same name, under .claude/worktrees/<name>
function cw() {
  claude -w "$1" -n "$1" "${@:2}"
}
