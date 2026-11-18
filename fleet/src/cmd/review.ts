// Review comments on a task's code. A comment is a todo in the task's note,
// so the worker gets it through the todo machinery: the Stop hook sends it
// back to unchecked items, `fleet report done` refuses while any are open,
// and the board counts them. nvim's :FleetComment writes the same line;
// `fleet comment` is the form for other tools, such as prose's diff page,
// which `fleet review` opens.

import { join } from "@std/path"
import { Fleet, isWorker, needId, opt } from "../fleet.ts"
import * as note from "../note.ts"
import { die, isFile, passthrough, print, readText, writeAtomic } from "../run.ts"

// The note a review can still go to: open in tasks/, with no end
function openNote(fleet: Fleet, id: string): string {
  const path = join(fleet.notes, "tasks", `${id}.md`)
  if (!isFile(path)) die(`${id} has no open note in tasks/; review a closed task in a follow-up`)
  if (note.get(path, "end")) die(`${id} is closed; put the review in a follow-up with fleet task <new id> --from ${id}`)
  return path
}

// The quoted line lets the worker find the code after its edits move it.
// One line, no backticks, and short, as :FleetComment quotes it.
export function quote(text: string): string {
  const one = text.trim().replace(/\s+/g, " ").replaceAll("`", "'")
  const chars = [...one]
  return chars.length > 60 ? chars.slice(0, 59).join("") + "…" : one
}

// Inserts a line after the last item of the note's ## Todo section, below
// the indented lines under it, such as a worker's `- reply:`, which belong to
// that item; or at the top of an empty section
export function appendTodo(text: string, item: string): string | null {
  const lines = text.split("\n")
  let section = ""
  let last = -1
  let heading = -1
  lines.forEach((line, i) => {
    const h = /^## (.+)/.exec(line)
    if (h) {
      section = h[1]
      if (section === "Todo") heading = i
    } else if (section === "Todo" && /^- \[/.test(line)) last = i
  })
  if (last >= 0) {
    while (last + 1 < lines.length && /^\s+\S/.test(lines[last + 1])) last++
    lines.splice(last + 1, 0, item)
  }
  else if (heading >= 0) lines.splice(heading + 1, 0, "", item)
  else return null
  return lines.join("\n")
}

const USAGE = "usage: fleet comment <id> <path>:<line>[-<end>] [--at <sha>] [--quote <text>] [--] <comment>"

export function comment(fleet: Fleet, args: string[]) {
  const id = args[0] || die(USAGE)
  needId(id)
  const place = args[1] ?? ""
  const where = /^(.+):(\d+)(?:-(\d+))?$/.exec(place) ?? die(USAGE)
  let at = ""
  let quoted = ""
  const words: string[] = []
  for (let i = 2; i < args.length; i++) {
    if (args[i] === "--at") at = args[++i] || die("--at needs a commit")
    else if (args[i] === "--quote") quoted = args[++i] ?? die("--quote needs the line's text")
    else if (args[i] === "--") {
      words.push(...args.slice(i + 1))
      break
    } else words.push(args[i])
  }
  const text = words.join(" ").replace(/\s*\n\s*/g, " ").trim()
  if (!text) die(USAGE)
  const [, path, line, end] = where
  const range = `${path}:${line}${end && Number(end) > Number(line) ? `-${end}` : ""}${at ? ` at ${at}` : ""}`
  const item = `- [ ] Review ${range}${quoted.trim() ? ` \`${quote(quoted)}\`` : ""}: ${text}`
  const notePath = openNote(fleet, id)
  const updated = appendTodo(readText(notePath), item)
  if (updated === null) die(`${id}'s note has no ## Todo section`)
  writeAtomic(notePath, updated)
  // the line as written, so a caller can find it in the note again
  print(item)
}

// Opens the task's changes in prose's diff page, whose comments come here.
// A seat names the task it holds; a task note by that name wins.
export async function review(fleet: Fleet, args: string[]) {
  let id = args[0] || die("usage: fleet review <task id | seat> [--no-open] [--port N]")
  needId(id)
  if (isWorker(id) && !isFile(note.path(fleet.notes, id))) {
    id = await opt(await fleet.pane(id), "@agent_task") || die(`${id} holds no task`)
  }
  openNote(fleet, id)
  const code = await passthrough("prose", ["diff", "--task", id, "-s", fleet.name, ...args.slice(1)])
  if (code !== 0) Deno.exit(code)
}
