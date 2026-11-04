// Task notes. A note's fields live in YAML frontmatter, one `key: value` per
// line between `---` lines at the top. `fleet:` and `task:` mark a file as a
// fleet note, which nvim's tree decorator and commands rely on, so they never
// guess from a path. Values are single plain lines. They are read and
// written as lines, without a YAML library, because nvim/lua/fleet/note.lua
// and the hooks read the same lines: a YAML dumper would quote or reflow a
// value, such as a URL, that those readers take as written.

import { basename, join } from "@std/path"
import { isDir, isFile, readText, run, writeAtomic } from "./run.ts"

// Notes from before frontmatter kept "Key: value" lines under the title
const LEGACY_FIELDS = ["Guidance", "Follows", "Ship", "PR", "Worker", "Branch", "Base", "End", "Status"]
const FIELD_ORDER = ["guidance", "ship", "follows", "pr", "worker", "branch", "base", "end", "status"]

// Lines of a file as awk sees them: a final newline ends the last line
function lines(text: string): string[] {
  const all = text.split("\n")
  if (all.at(-1) === "") all.pop()
  return all
}
const join_ = (all: string[]) => all.map((line) => line + "\n").join("")

export function hasFrontmatter(note: string): boolean {
  return lines(readText(note))[0] === "---"
}

export function get(note: string, key: string): string {
  const all = lines(readText(note))
  if (all[0] === "---") {
    for (const line of all.slice(1)) {
      if (line === "---") break
      if (line.startsWith(`${key}:`)) return line.replace(/^[^:]*: */, "")
    }
    return ""
  }
  const legacy = key === "pr" ? "PR" : key[0].toUpperCase() + key.slice(1)
  for (const line of all) {
    if (line.startsWith(`${legacy}:`)) return line.replace(new RegExp(`^${legacy}: *`), "")
  }
  return ""
}

// Sets one field, adding it at the end of the frontmatter when it is new.
// An old-format note is converted first.
export function set(note: string, key: string, value: string, fleet: string) {
  if (!hasFrontmatter(note)) migrate(note, fleet)
  const all = lines(readText(note))
  const out = [all[0]]
  let done = false
  let wasSet = false
  for (const line of all.slice(1)) {
    if (!done && line === "---") {
      if (!wasSet) out.push(`${key}: ${value}`)
      out.push(line)
      done = true
    } else if (!done && line.startsWith(`${key}:`)) {
      out.push(`${key}: ${value}`)
      wasSet = true
    } else {
      out.push(line)
    }
  }
  writeAtomic(note, join_(out))
}

// Rewrites an old-format note's "Key: value" header lines as frontmatter,
// with the fleet and task marker keys, and keeps everything else. Runs of
// blank lines the removed fields leave in the header collapse to one.
export function migrate(note: string, fleet: string) {
  const id = basename(note).replace(/\.md$/, "")
  const pattern = new RegExp(`^(${LEGACY_FIELDS.join("|")}): *`)
  const fields: Record<string, string> = {}
  const kept: string[] = []
  let body = false
  let blank = false
  for (const line of lines(readText(note))) {
    if (!body && line.startsWith("## ")) body = true
    if (!body && pattern.test(line)) {
      const key = line.replace(/:.*/, "")
      fields[key === "PR" ? "pr" : key.toLowerCase()] = line.replace(/^[^:]*: */, "")
      continue
    }
    if (!body && line === "" && blank) continue
    blank = line === ""
    kept.push(line)
  }
  const out = ["---", `fleet: ${fleet}`, `task: ${id}`]
  for (const key of FIELD_ORDER) if (key in fields) out.push(`${key}: ${fields[key]}`)
  out.push("---", "", ...kept)
  writeAtomic(note, join_(out))
}

// The body of section "## <name>", up to the next "## " heading
export function section(note: string, name: string): string[] {
  const out: string[] = []
  let on = false
  for (const line of lines(readText(note))) {
    if (line === `## ${name}`) {
      on = true
      continue
    }
    if (on && line.startsWith("## ")) break
    if (on) out.push(line)
  }
  return out
}

export function setSection(note: string, name: string, body: string[]) {
  const out: string[] = []
  let skip = false
  for (const line of lines(readText(note))) {
    if (line === `## ${name}`) {
      out.push(line, ...body)
      skip = true
      continue
    }
    if (skip && line.startsWith("## ")) skip = false
    if (!skip) out.push(line)
  }
  writeAtomic(note, join_(out))
}

export function appendLog(note: string, entry: string) {
  let text = readText(note)
  if (!lines(text).includes("## Log")) {
    text += "\n## Log\n\n"
  }
  Deno.writeTextFileSync(note, `${text}- ${entry}\n`)
}

// [checked todos, total todos, open questions], counted by hooks/task-progress,
// the one definition the hooks and fleet share
export async function progress(root: string, note: string): Promise<[number, number, number]> {
  const out = await run(join(root, "hooks", "task-progress"), [note])
  const [done, total, open] = out.split(/\s+/).map(Number)
  return [done, total, open]
}

// Task <id>'s note: tasks/<id>.md, or wherever fleet archive moved it under
// tasks/archive/, by month (archive/2026-11/<id>.md) or, for notes archived
// before months, flat. With none, the tasks/ path, for creating it.
export function path(notes: string, id: string): string {
  const open = join(notes, "tasks", `${id}.md`)
  if (isFile(open)) return open
  return archived(join(notes, "tasks", "archive"), `${id}.md`) ?? open
}

// the first match in sorted path order, as zsh's archive/**/<id>.md glob
function archived(dir: string, name: string): string | undefined {
  return markdown(dir).filter((p) => basename(p) === name).sort()[0]
}

// Every .md file under a folder, recursively, sorted, skipping .git
export function markdown(dir: string): string[] {
  const out: string[] = []
  if (!isDir(dir)) return out
  for (const e of [...Deno.readDirSync(dir)].sort((a, b) => a.name < b.name ? -1 : 1)) {
    if (e.name === ".git") continue
    const p = join(dir, e.name)
    if (e.isDirectory) out.push(...markdown(p))
    else if (e.isFile && e.name.endsWith(".md")) out.push(p)
  }
  return out
}

// tasks/*.md, the open notes
export function open(notes: string): string[] {
  const dir = join(notes, "tasks")
  if (!isDir(dir)) return []
  return [...Deno.readDirSync(dir)]
    .filter((e) => e.isFile && e.name.endsWith(".md"))
    .map((e) => join(dir, e.name))
    .sort()
}
