// Git lookups shared by fleet's commands.

import { output, test } from "./run.ts"

// The default branch as seen from checkout <dir>: origin's HEAD when the repo
// has one, else main or master. Empty when none exists.
export async function defaultBranch(dir: string): Promise<string> {
  const origin = await output("git", ["-C", dir, "symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"])
  for (const ref of [...(origin ? [origin] : []), "main", "master"]) {
    if (await test("git", ["-C", dir, "rev-parse", "-q", "--verify", `${ref}^{commit}`])) return ref
  }
  return ""
}
