// Git lookups shared by fleet's commands.

import { join } from "@std/path"
import { output, run, test } from "./run.ts"

// The default branch as seen from checkout <dir>: origin's HEAD when the repo
// has one, else main or master. Empty when none exists.
export async function defaultBranch(dir: string): Promise<string> {
  const origin = await output("git", ["-C", dir, "symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"])
  for (const ref of [...(origin ? [origin] : []), "main", "master"]) {
    if (await test("git", ["-C", dir, "rev-parse", "-q", "--verify", `${ref}^{commit}`])) return ref
  }
  return ""
}

// Adds the worktree <repo>/.claude/worktrees/<name> on branch
// worktree-<name>: the existing branch when there is one, else a new one from
// the repo's default branch. Returns the branch.
export async function addWorktree(repo: string, name: string): Promise<string> {
  const wt = join(repo, ".claude", "worktrees", name)
  const branch = `worktree-${name}`
  if (await test("git", ["-C", repo, "rev-parse", "-q", "--verify", `refs/heads/${branch}`])) {
    await run("git", ["-C", repo, "worktree", "add", "-q", wt, branch])
  } else {
    const start = (await defaultBranch(repo)) || "HEAD"
    await run("git", ["-C", repo, "worktree", "add", "-q", "-b", branch, wt, start])
  }
  return branch
}
