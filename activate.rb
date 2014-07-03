#!/usr/bin/env ruby

require 'fileutils'

LINKS = ["vim",
         "vimrc",
         "rspec",
         "zsh",
         "zshrc",
         "tmux.conf",
         "gitconfig"]

working_dir = File.expand_path(File.dirname(__FILE__))
home_dir = File.expand_path("~")
dot_files = LINKS.map { |link| File.join(working_dir, link) }

dot_files.each do |filename|
  sym_link = File.join(home_dir, ".#{File.basename(filename)}")

  FileUtils.rm sym_link if File.symlink?(sym_link) || File.exist?(sym_link)
  FileUtils.ln_s filename, sym_link
end
