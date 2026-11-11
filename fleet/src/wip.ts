// Work a worker leaves uncommitted when its task closes. A worker's worktree
// is reused for its next task, so files left there are lost to the next
// assign's sync or to whoever cleans the worktree. When `fleet clear` or
// `fleet abandon` closes a task, they are committed to refs/fleet/<fleet>/<id>,
// a ref outside refs/heads that `git push --all` and branch lists skip and that
// keeps the commit from garbage collection, and the worktree goes back to its
// last commit. The note records the ref as `wip:` and lists the files in its
// Log. The commit is built in a temporary index, so the worker's branch and
// index are untouched until the reset.

import { join } from "@std/path"
import type { Fleet } from "./fleet.ts"
import * as note from "./note.ts"
import { die, print, run, stamp, test } from "./run.ts"

// A top-level untracked folder with more files than this, such as an
// unignored node_modules, is install or build output: it stays in place and
// the Log names it
const FOLDER_FILES = 100
const MAX_BYTES = 50 * 1024 * 1024

type Entry = { code: string; path: string }

// `git status --porcelain -z`: "XY path", with a second field after a rename
function parse(status: string): Entry[] {
  const parts = status.split("\0").filter((p) => p !== "")
  const entries: Entry[] = []
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i].slice(0, 2)
    entries.push({ code, path: parts[i].slice(3) })
    if (code[0] === "R" || code[0] === "C") i++
  }
  return entries
}

const top = (path: string) => path.includes("/") ? path.split("/")[0] : ""
const listed = (files: string[]) =>
  files.slice(0, 8).join(", ") + (files.length > 8 ? `, and ${files.length - 8} more` : "")

export async function save(fleet: Fleet, worktree: string, id: string, path: string, verb: string) {
  const entries = parse(
    await run("git", ["-C", worktree, "status", "--porcelain", "-z", "--untracked-files=all"]),
  )
  if (!entries.length) return
  const untracked = entries.filter((e) => e.code === "??").map((e) => e.path)
  const perFolder = new Map<string, number>()
  for (const p of untracked) if (top(p)) perFolder.set(top(p), (perFolder.get(top(p)) ?? 0) + 1)
  const skipped = [...perFolder].filter(([, n]) => n > FOLDER_FILES)
  const skip = new Set(skipped.map(([dir]) => dir))
  const kept = untracked.filter((p) => !skip.has(top(p)))
  const files = [...entries.filter((e) => e.code !== "??").map((e) => e.path), ...kept]
  const left = skipped.map(([dir, n]) => `${dir}/ (${n} files)`).join(", ")
  if (!files.length) {
    note.appendLog(path, `${stamp()} ${verb}: left untracked in ${worktree}: ${left}`)
    return
  }
  let bytes = 0
  for (const p of kept) {
    try {
      bytes += Deno.statSync(join(worktree, p)).size
    } catch {
      // a file removed since git status listed it
    }
  }
  if (bytes > MAX_BYTES) {
    die(
      `${id}'s uncommitted files in ${worktree} come to ${Math.round(bytes / 1048576)} MB; ` +
        `commit or remove them, then run fleet ${verb} again`,
    )
  }

  const tmp = Deno.makeTempDirSync()
  const ref = `refs/fleet/${fleet.name}/${id}`
  let commit: string
  try {
    const env = { GIT_INDEX_FILE: join(tmp, "index") }
    await run("git", ["-C", worktree, "read-tree", "HEAD"], { env })
    await run("git", ["-C", worktree, "add", "-A", "--", ...files], { env })
    const tree = await run("git", ["-C", worktree, "write-tree"], { env })
    commit = await run("git", [
      "-C",
      worktree,
      "commit-tree",
      tree,
      "-p",
      "HEAD",
      "-m",
      `Uncommitted work at the close of ${id}`,
    ])
    await run("git", ["-C", worktree, "update-ref", ref, commit])
  } finally {
    Deno.removeSync(tmp, { recursive: true })
  }
  // back to the last commit; the skipped folders stay
  await run("git", ["-C", worktree, "reset", "-q", "--hard", "HEAD"])
  if (kept.length) await run("git", ["-C", worktree, "clean", "-f", "-q", "--", ...kept])

  note.set(path, "wip", `${ref} ${commit}`, fleet.name)
  note.appendLog(
    path,
    `${stamp()} ${verb}: saved uncommitted work to ${ref} (${commit.slice(0, 12)}): ${listed(files)}` +
      (left ? `; left untracked in place: ${left}` : ""),
  )
  print(
    `saved ${files.length} uncommitted files from ${worktree} to ${ref}; git checkout ${
      commit.slice(0, 12)
    } -- <path> restores one`,
  )
}

// Applies a saved commit's changes to checkout <dir> as uncommitted changes,
// for a pairing session on the task. Returns whether they applied cleanly.
export async function apply(dir: string, commit: string): Promise<boolean> {
  const patch = await run("git", ["-C", dir, "diff", "--binary", `${commit}^`, commit])
  if (!patch) return true
  return await test("git", ["-C", dir, "apply", "--whitespace=nowarn", "-"], { stdin: patch + "\n" })
}
