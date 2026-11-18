// What a diff page shows, re-read on every request so the page sees new
// commits and edits. Three kinds:
//
//   default    a checkout's changes since it left the default branch,
//              uncommitted edits and untracked files included:
//              git diff $(git merge-base <default> HEAD)
//   git args   any git diff arguments, such as main...HEAD or --cached
//   task       a fleet task's changes, the revision `fleet diff --rev` names

export type DiffSpec =
  | { kind: "git"; dir: string; args: string[] }
  | { kind: "task"; fleet: string; task: string }

export type DiffRead = {
  patch: string
  hash: string
  // the checkout the paths are relative to
  dir: string
  label: string
  // the commits the two sides were read at: base for the old side, empty
  // when git diff arguments leave it unclear, and head for the new side,
  // with "+" when it includes uncommitted edits
  base: string
  head: string
}

async function cmd(name: string, args: string[], cwd?: string) {
  const out = await new Deno.Command(name, { args, cwd, stdout: "piped", stderr: "piped" }).output()
  const text = new TextDecoder().decode(out.stdout)
  if (!out.success) {
    throw new Error(`${name} ${args.join(" ")}: ${new TextDecoder().decode(out.stderr).trim() || `exit ${out.code}`}`)
  }
  return text
}
const git = (dir: string, args: string[]) => cmd("git", ["-C", dir, ...args])
const ok = (p: Promise<unknown>) => p.then(() => true, () => false)

// origin's HEAD when the repo has one, else main or master, as fleet finds it
async function defaultBranch(dir: string): Promise<string> {
  const origin = (await git(dir, ["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"]).catch(() => "")).trim()
  for (const ref of [...(origin ? [origin] : []), "main", "master"]) {
    if (await ok(git(dir, ["rev-parse", "-q", "--verify", `${ref}^{commit}`]))) return ref
  }
  return ""
}

async function sha1(text: string) {
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")
}

// Paths come unquoted unless they hold control characters, and a user's
// external diff tool or textconv filter stays out of the patch the page parses
const diffArgs = ["-c", "core.quotePath=false", "diff", "--no-color", "--no-ext-diff"]

// git diff leaves out untracked files, so a diff that runs to the working
// tree adds them as new files, each through git diff --no-index against
// /dev/null, which exits 1 when it finds a difference. .gitignore'd files
// stay out, and past MAX_UNTRACKED the rest are left out and named.
const MAX_UNTRACKED = 200

async function untracked(dir: string): Promise<{ patch: string; skipped: number }> {
  const list = (await git(dir, ["ls-files", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean)
  let patch = ""
  for (const path of list.slice(0, MAX_UNTRACKED)) {
    const out = await new Deno.Command("git", {
      args: ["-C", dir, ...diffArgs, "--no-index", "--", "/dev/null", path],
      stdout: "piped",
      stderr: "null",
    }).output()
    if (out.code === 1) patch += new TextDecoder().decode(out.stdout)
  }
  return { patch, skipped: Math.max(0, list.length - MAX_UNTRACKED) }
}

export class DiffSource {
  // a task's checkout and revision move when its worker commits or fleet
  // clears it, but not every few seconds; `fleet diff --rev` takes a moment
  #taskRev: { dir: string; rev: string; at: number } | null = null

  constructor(readonly spec: DiffSpec) {}

  // Names the review in logs and state file names
  get key(): string {
    const s = this.spec
    return s.kind === "task" ? `task:${s.fleet}:${s.task}` : `git:${s.dir}:${s.args.join(" ")}`
  }

  async read(): Promise<DiffRead> {
    const s = this.spec
    if (s.kind === "task") return await this.#task(s.fleet, s.task)
    const dir = s.dir
    const short = async (rev: string) => (await git(dir, ["rev-parse", "--short", rev])).trim()
    if (s.args.length) {
      const patch = await git(dir, [...diffArgs, ...s.args])
      const revs = s.args.filter((a) => !a.startsWith("-"))
      const [left = "", right = ""] = revs[0]?.split(/\.{2,3}/) ?? []
      const base = revs[0]?.includes("...")
        ? await git(dir, ["merge-base", left || "HEAD", right || "HEAD"]).then((b) => b.trim().slice(0, 12), () => "")
        : left ? await short(left).catch(() => "") : ""
      const head = right ? await short(right).catch(() => "") : revs.length > 1 ? await short(revs[1]).catch(() => "") : `${await short("HEAD")}+`
      return { patch, hash: await sha1(patch), dir, label: `git diff ${s.args.join(" ")}`, base, head }
    }
    const ref = await defaultBranch(dir)
    const base = ref ? (await git(dir, ["merge-base", ref, "HEAD"])).trim() : "HEAD"
    const branch = (await git(dir, ["branch", "--show-current"])).trim() || "HEAD"
    const extra = await untracked(dir)
    const patch = await git(dir, [...diffArgs, base]) + extra.patch
    const label = (ref && branch !== ref ? `${branch} since ${ref}` : `${branch}, uncommitted`) +
      (extra.skipped ? ` (${extra.skipped} more untracked files not shown)` : "")
    return { patch, hash: await sha1(patch), dir, label, base: await short(base), head: `${await short("HEAD")}+` }
  }

  async #task(fleet: string, task: string): Promise<DiffRead> {
    if (!this.#taskRev || Date.now() - this.#taskRev.at > 30_000) {
      const [dir, rev] = (await cmd("fleet", ["-s", fleet, "diff", "--rev", task])).trim().split("\n")
      this.#taskRev = { dir, rev, at: Date.now() }
    }
    const { dir, rev } = this.#taskRev
    // base..end is closed work; a lone base runs to the working tree
    const [left, right = ""] = rev.split("..")
    const extra = right ? { patch: "", skipped: 0 } : await untracked(dir)
    const patch = await git(dir, [...diffArgs, rev]) + extra.patch
    const short = async (r: string) => (await git(dir, ["rev-parse", "--short", r])).trim()
    const head = right ? await short(right) : `${await short("HEAD")}+`
    const label = `task ${task} in fleet ${fleet}` + (extra.skipped ? ` (${extra.skipped} more untracked files not shown)` : "")
    return { patch, hash: await sha1(patch), dir, label, base: await short(left), head }
  }
}
