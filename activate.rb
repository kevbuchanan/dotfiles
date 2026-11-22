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
  # agents: Claude Code and OpenCode read one instructions file. Claude
  # Code expands its @~/.claude/writing.md import. OpenCode ignores the
  # import and loads writing.md through the instructions key that
  # ensure_opencode_instruction adds. OpenCode reads ~/.claude/skills.
  ["agents/AGENTS.md", ".claude/CLAUDE.md"],
  ["agents/AGENTS.md", ".config/opencode/AGENTS.md"],
  ["claude/writing.md", ".claude/writing.md"],
  ["claude/skills/memory-audit", ".claude/skills/memory-audit"],
  # fleet
  ["fleet/bin/fleet", ".local/bin/fleet"],
  ["fleet/nvim/plugin/fleet.lua", ".config/nvim/plugin/fleet.lua"],
  ["fleet/nvim/lua/fleet", ".config/nvim/lua/fleet"],
  # mise
  ["mise/config.toml", ".config/mise/config.toml"],
  # prose
  ["prose/bin/prose", ".local/bin/prose"],
  ["prose/skill", ".claude/skills/prose"],
  ["prose/nvim/plugin/prose.lua", ".config/nvim/plugin/prose.lua"],
  # helix, linked by entry: ~/.config/helix can already exist as a folder
  ["helix/config.toml", ".config/helix/config.toml"],
  ["helix/themes", ".config/helix/themes"]
]

OPENCODE_INSTRUCTION = "~/.claude/writing.md"

# Links target to source. A run against a finished setup changes nothing.
# A file or folder already at target moves aside to target.<time>.bak,
# unless it is a file identical to source. FileUtils.ln_s(force: true)
# is avoided: when target is a link to a folder, it nests the new link
# inside that folder.
def link(source, target)
  return if File.symlink?(target) && File.readlink(target) == source

  FileUtils.mkdir_p(File.dirname(target))
  if File.symlink?(target)
    File.delete(target)
  elsif File.file?(target) && File.file?(source) && FileUtils.compare_file(source, target)
    File.delete(target)
  elsif File.exist?(target)
    backup = "#{target}.#{Time.now.strftime('%Y%m%d%H%M%S')}.bak"
    File.rename(target, backup)
    puts "moved #{target} to #{backup}"
  end
  File.symlink(source, target)
end

# Adds OPENCODE_INSTRUCTION to the instructions list in OpenCode's global
# config, creating opencode.json when no config exists. The config stays
# a real file because OpenCode users keep providers and models there. A
# JSONC config is left for a manual edit, since rewriting it drops its
# comments.
def ensure_opencode_instruction(config_dir)
  require 'json'

  jsonc = File.join(config_dir, "opencode.jsonc")
  json = File.join(config_dir, "opencode.json")
  path = [json, jsonc].find { |p| File.exist?(p) }

  unless path
    FileUtils.mkdir_p(config_dir)
    config = {
      "$schema" => "https://opencode.ai/config.json",
      "instructions" => [OPENCODE_INSTRUCTION]
    }
    File.write(json, JSON.pretty_generate(config) + "\n")
    return
  end

  manual = "add #{OPENCODE_INSTRUCTION.inspect} to \"instructions\" in #{path}"
  begin
    config = JSON.parse(File.read(path))
  rescue JSON::ParserError
    puts manual
    return
  end
  instructions = config["instructions"] || []
  return if instructions.include?(OPENCODE_INSTRUCTION)

  if path == jsonc
    puts manual
    return
  end

  config["instructions"] = instructions + [OPENCODE_INSTRUCTION]
  File.write(path, JSON.pretty_generate(config) + "\n")
end

working_dir = File.expand_path(File.dirname(__FILE__))
home_dir = File.expand_path("~")

LINKS.each do |source_file, config_file|
  link(File.join(working_dir, source_file), File.join(home_dir, config_file))
end

ensure_opencode_instruction(File.join(home_dir, ".config/opencode"))
