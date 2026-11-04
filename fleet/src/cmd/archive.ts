// Moving closed task notes into tasks/archive/<YYYY-MM>/, and converting
// old-format notes to frontmatter.

import { basename, dirname, join, normalize, relative } from "@std/path"
import { Fleet } from "../fleet.ts"
import * as note from "../note.ts"
import { print, readText, today } from "../run.ts"

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
const id = (path: string) => basename(path).replace(/\.md$/, "")

// Rewrites the relative markdown links in the notes repo after the moves,
// old path to new path, both relative to the repo: a link from a moved file
// is resolved from where the file was, a link to a moved file follows it,
// and each changed link is made relative to where its file is now. That
// covers notes in different archive months and archived notes that link the
// note just moved. Links outside the repo, web links and anchors stay as
// written. Only files whose text changes are written, so a note open in nvim
// reloads only when one of its links moved.
export function relink(notes: string, moves: Map<string, string>) {
  const back = new Map([...moves].map(([from, to]) => [to, from]))
  const names = [...moves.keys()].map((p) => basename(p))
  for (const file of note.markdown(notes)) {
    const now = relative(notes, file)
    const moved = back.has(now)
    const text = readText(file)
    if (!moved && !names.some((n) => text.includes(n))) continue
    const was = back.get(now) ?? now
    const fromDir = dirname(was)
    const toDir = dirname(now)
    const out = text.replace(/\]\(([^)\s#]+)(#[^)\s]*)?\)/g, (whole, target: string, frag = "") => {
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("/")) return whole
      const abs = normalize(join(fromDir, target))
      if (abs.startsWith("../") || abs === "..") return whole
      if (!moved && !moves.has(abs)) return whole
      return `](${relative(toDir, moves.get(abs) ?? abs)}${frag})`
    })
    if (out !== text) Deno.writeTextFileSync(file, out)
  }
}

// Moves task notes out of tasks/ once nothing needs them there: closed by
// fleet clear (end set), shipped or not meant to ship (pr set, or ship no),
// no worker still on them, and no note staying in tasks/ that links or
// follows them. The commit records each move as a rename, so history
// follows.
export async function archive(fleet: Fleet, args: string[]) {
  const dry = args[0] === "--dry-run"
  const open = note.open(fleet.notes)
  const held = new Set((await fleet.seats()).map((s) => s.task).filter(Boolean))
  let moved = open.filter((f) => {
    if (!note.get(f, "end")) return false
    // pr and draft ship through a PR the note records; no and push have none,
    // and an abandoned task ships nothing
    const ship = note.get(f, "ship")
    if (["pr", "draft"].includes(ship) && !note.get(f, "pr") && note.get(f, "status") !== "abandoned") {
      return false
    }
    return !held.has(id(f))
  })
  // A note stays while a link to it, or a follows: line naming it, sits in a
  // note that stays. Notes moving together don't hold each other back, and
  // each note dropped here can hold back others, so this runs until nothing
  // changes.
  for (let changed = true; changed;) {
    changed = false
    const staying = open.filter((f) => !moved.includes(f)).map(readText)
    for (const f of moved) {
      const t = escape(id(f))
      const linked = new RegExp(`\\]\\(${t}\\.md\\)|\\(tasks/${t}\\.md\\)|^[Ff]ollows: *${t}$`, "m")
      if (staying.some((text) => linked.test(text))) {
        moved = moved.filter((m) => m !== f)
        changed = true
      }
    }
  }
  if (!moved.length) return print("nothing to archive")
  const ids = moved.map(id)
  if (dry) return print("would archive:", ...ids)

  // Each note goes into the month it closed, tasks/archive/<YYYY-MM>/, or
  // this month for a note closed before notes recorded `closed:`
  const moves = new Map<string, string>()
  for (const f of moved) {
    let month = note.get(f, "closed").slice(0, 7)
    if (!/^\d+-\d+$/.test(month)) month = today().slice(0, 7)
    const dir = join(fleet.notes, "tasks", "archive", month)
    Deno.mkdirSync(dir, { recursive: true })
    Deno.renameSync(f, join(dir, basename(f)))
    moves.set(relative(fleet.notes, f), relative(fleet.notes, join(dir, basename(f))))
  }
  relink(fleet.notes, moves)
  await fleet.commit(`archive ${ids.join(", ")}`)
  print("archived:", ...ids)
}

// Converts every old-format note, in tasks/ and tasks/archive/, to
// frontmatter and commits. note.set converts a note the first time it
// writes one, so this only hurries the rest along.
export async function migrate(fleet: Fleet, args: string[]) {
  const dry = args[0] === "--dry-run"
  const archived = note.markdown(join(fleet.notes, "tasks", "archive"))
  const old = [...note.open(fleet.notes), ...archived].filter((f) => !note.hasFrontmatter(f))
  if (!old.length) return print("every note has frontmatter")
  if (dry) return print("would migrate:", ...old.map(id))
  for (const f of old) note.migrate(f, fleet.name)
  await fleet.commit(`migrate ${old.length} notes to frontmatter`)
  print("migrated:", ...old.map(id))
}
