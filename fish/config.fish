set --erase fish_greeting
set --export PATH $HOME/bin \
                  /usr/local/bin \
                  /usr/local/sbin \
                  $HOME/.rbenv/shims \
                  $HOME/.rbenv/bin \
                  $PATH
set --export JAVA_HOME (/usr/libexec/java_home)

function fish_prompt
  set -l last_status $status
  set_color 6666FF
  echo -n (date +"%I:%M %p ")

  set_color 66FFFF
  echo -n "|"
  set_color 6666FF
  echo -n " "(pwd | sed s:$HOME:~:)" "

  if git branch ^&- >&-
    set_color 66FFFF
    echo -n "|"
    set_color 6666FF

    echo -n (git branch --no-color ^ /dev/null | sed -e '/^[^*]/d' -e 's/* \(.*\)/ \1 /')
    set_color --background normal

    if not git diff --quiet HEAD 2> /dev/null
      set_color yellow
      echo -n "✗"
    end
  end

  if [ $last_status = 0 ]
    set_color 66FFFF
  else
    set_color red
  end
  echo -n \n"➜  "
  set_color normal
  set_color --background normal
end

function bi
  bundle install $argv
end

function be
  bundle exec $argv
end
