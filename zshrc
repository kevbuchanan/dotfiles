PATH=/usr/local/bin:/usr/local/sbin:$PATH

zstyle ':completion:*:*:git:*' script ~/.zsh/git-completion.bash
fpath=(~/.zsh $fpath)
autoload -U compinit && compinit

alias tmux='tmux -2'
alias be="bundle exec "
alias bi="bundle install"
alias resetdb="RAILS_ENV=test be rake environment db:drop db:create db:migrate"
alias reload="source ~/.zshrc"
alias config="vim ~/.zshrc"
alias mongodb="mongod --config /usr/local/etc/mongod.conf"
alias postgres="postgres -D /usr/local/var/postgres"
PGDATA=/usr/local/var/postgres

bindkey "^H" beginning-of-line
bindkey "^L" end-of-line
bindkey "^J" history-incremental-search-backward
bindkey "^K" history-search-backward

eval "$(rbenv init -)"

autoload colors; colors;
export LSCOLORS="Gxfxcxdxbxegedabagacad"
setopt prompt_subst

ZSH_THEME_GIT_PROMPT_PREFIX="git:(%{$fg[red]%}"
ZSH_THEME_GIT_PROMPT_SUFFIX="%{$reset_color%}"
ZSH_THEME_GIT_PROMPT_DIRTY="%{$fg[blue]%}) %{$fg[yellow]%}✗%{$reset_color%}"
ZSH_THEME_GIT_PROMPT_CLEAN="%{$fg[blue]%})"

local ret_status="%(?:%{$fg_bold[green]%}➜ :%{$fg_bold[red]%}➜ %s)"

PROMPT='${ret_status}%{$fg_bold[green]%}%p %{$fg[cyan]%}%c %{$fg_bold[blue]%}$(git_prompt_info)%{$fg_bold[blue]%} % %{$reset_color%}'

function git_prompt_info() {
  ref=$(command git symbolic-ref HEAD 2> /dev/null) || \
  ref=$(command git rev-parse --short HEAD 2> /dev/null) || return
  echo "$ZSH_THEME_GIT_PROMPT_PREFIX${ref#refs/heads/}$(parse_git_dirty)$ZSH_THEME_GIT_PROMPT_SUFFIX"
}

function parse_git_dirty() {
  if command git diff --quiet HEAD 2> /dev/null; then
    echo "$ZSH_THEME_GIT_PROMPT_CLEAN"
  else
    echo "$ZSH_THEME_GIT_PROMPT_DIRTY"
  fi
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

# watch for changes in files with $1 extension and run $2 command on change, watch <extension> <command>
function watch() {
  pattern="./**/*.$1"
  command=$2

  time=0
  while true; do
    newtime=$(find $~pattern | xargs stat -f %m | sort -n -r | head -1)
    if [ "$newtime" -gt "$time" ]; then
      clear
      eval $command
    fi
    time=$newtime;
    sleep 1
  done
}
