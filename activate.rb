#!/usr/bin/env ruby

require 'fileutils'

LINKS = [
  # vim
  ["vim", ".vim"],
  ["vimrc", ".vimrc"],
  # nvim
  ["vim/colors", ".config/nvim/colors"],
  ["vim/autoload", ".config/nvim/autoload"],
  ["vimrc", ".config/nvim/init.vim"],
  # zsh
  ["zsh", ".zsh"],
  ["zshrc", ".zshrc"],
  # etc
  ["tmux.conf", ".tmux.conf"],
  ["gitconfig", ".gitconfig"],
  ["fish", ".config/fish"],
  ["rspec", ".rspec"]
]

working_dir = File.expand_path(File.dirname(__FILE__))
home_dir = File.expand_path("~")

LINKS.each do |source_file, config_file|
  source_file_path = File.join(working_dir, source_file)
  config_file_path = File.join(home_dir, config_file)

  FileUtils.mkdir_p(File.dirname(config_file_path))
  FileUtils.ln_s(source_file_path, config_file_path, force: true)
end
