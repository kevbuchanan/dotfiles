#!/usr/bin/env ruby

require 'fileutils'

LINKS = [
  # vim
  ["vim", ".vim"],
  ["vimrc", ".vimrc"],
  ["vimrc.coc", ".vimrc.coc"],
  # nvim
  ["vim/colors", ".config/nvim/colors"],
  ["vim/autoload", ".config/nvim/autoload"],
  ["vimrc", ".config/nvim/init.vim"],
  ["vimrc.coc", ".config/nvim/coc.vim"],
  # zsh
  ["zshrc", ".zshrc"],
  # etc
  ["tmux.conf", ".tmux.conf"],
  ["gitconfig", ".gitconfig"],
  ["fish", ".config/fish"],
  ["rspec", ".rspec"],
  # fleet
  ["fleet/bin/fleet", ".local/bin/fleet"],
  ["fleet/nvim/plugin/fleet.lua", ".config/nvim/plugin/fleet.lua"],
  # prose
  ["prose/bin/prose", ".local/bin/prose"],
  ["prose/bin/prose-bg", ".local/bin/prose-bg"],
  ["prose/bin/prose-post", ".local/bin/prose-post"],
  ["prose/bin/prose-start", ".local/bin/prose-start"],
  ["prose/bin/prose-session", ".local/bin/prose-session"],
  ["prose/skill", ".claude/skills/prose"],
  ["prose/nvim/plugin/prose.lua", ".config/nvim/plugin/prose.lua"]
]

working_dir = File.expand_path(File.dirname(__FILE__))
home_dir = File.expand_path("~")

LINKS.each do |source_file, config_file|
  source_file_path = File.join(working_dir, source_file)
  config_file_path = File.join(home_dir, config_file)

  FileUtils.mkdir_p(File.dirname(config_file_path))
  FileUtils.ln_s(source_file_path, config_file_path, force: true)
end
