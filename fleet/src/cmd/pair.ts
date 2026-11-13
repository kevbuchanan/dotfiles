// `fleet pair`: a window for working with an agent yourself, nvim on the left
// and an interactive claude on the right, both in one checkout. The session
// is not a seat: it has no @agent_seat, runs without fleet's settings and
// hooks, loads the fleet plugin for the fleet:pair skill, and starts from a
// prompt that says what it is pairing on and where its checkout came from.
// It runs under the fleet's config folder, taken from the orchestrator's
// launch line.
//
// The checkout is one of:
//   - a task's, at the state its note records (the default with a task)
//   - --branch <ref>: a worktree of its own at a branch, tag or commit
//   - --dir <path>: an existing folder, used as it is
//   - --pr <ref>: a worktree of its own at a pull or merge request's branch

import { basename, join } from "@std/path"
import { Fleet, isWorker, needId, opt, root, tmux } from "../fleet.ts"
import { defaultBranch } from "../git.ts"
import * as note from "../note.ts"
import { die, isDir, isFile, output, print, run, shq, test, warn } from "../run.ts"
import * as wip from "../wip.ts"
import { borders } from "./lifecycle.ts"

const env = (name: string) => Deno.env.get(name) ?? ""
const usage = "usage: fleet pair [<task id | seat>] [--branch <ref> | --dir <path> | --pr [<ref>]]"

type Checkout = { dir: string; where: string }

export async function pair(fleet: Fleet, args: string[]) {
  let target = ""
  let branch = ""
  let dirArg = ""
  let prRef: string | undefined
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === "--branch") branch = args[++i] || die("--branch needs a ref")
    else if (arg === "--dir") dirArg = args[++i] || die("--dir needs a path")
    else if (arg === "--pr") prRef = args[i + 1] && !args[i + 1].startsWith("--") ? args[++i] : ""
    else if (!target && !arg.startsWith("--")) target = arg
    else die(usage)
  }
  if ([branch !== "", dirArg !== "", prRef !== undefined].filter(Boolean).length > 1) {
    die("use one of --branch, --dir and --pr")
  }

  // the task, when one is named: by id, or by the seat that holds it
  let id = ""
  let path = ""
  if (target) {
    id = target
    if (isWorker(id) && !isFile(note.path(fleet.notes, id))) {
      id = await opt(await fleet.pane(id), "@agent_task") || die(`${id} holds no task`)
    }
    needId(id)
    path = note.path(fleet.notes, id)
    if (!isFile(path)) die(`no task note ${path}`)
  } else if (!branch && !dirArg && prRef === undefined) {
    die(usage)
  }
  if (prRef === "") {
    prRef = (path && note.get(path, "pr")) || die("--pr needs a reference, or a task whose note has pr:")
  }
  const pr = prRef !== undefined ? parsePr(prRef) : undefined
  const repo = path ? fleet.repoOf(path) : fleet.repo

  const name = id || (pr ? `pr-${pr.number}` : branch ? slug(branch) : basename(realPath(dirArg)))
  const win = `${name}-pair`
  const windows = (await run("tmux", ["list-windows", "-t", fleet.target, "-F", "#{window_name}"])).split(
    "\n",
  )
  if (!windows.includes(win)) {
    let checkout: Checkout
    let about = ""
    if (pr) {
      const found = await prCheckout(fleet, pr, path ? repo : "", name)
      checkout = found.checkout
      about = found.about
    } else if (branch) {
      if (!repo) die(`${fleet.name} has no repo to check ${branch} out from`)
      checkout = await refCheckout(
        repo,
        join(repo, ".claude", "worktrees", `${fleet.name}-pair-${name}`),
        branch,
      )
    } else if (dirArg) {
      checkout = await dirCheckout(fleet, realPath(dirArg))
    } else {
      checkout = await taskCheckout(fleet, id, path)
    }

    const prompt = [
      id
        ? `You are pairing with the user on task ${id} of fleet ${fleet.name}. Its note is ${path}.`
        : `You are pairing with the user in fleet ${fleet.name}, whose notes folder is ${fleet.notes}.`,
      about,
      "Use the /fleet:pair skill for how this session works with the fleet's notes.",
      checkout.where,
      id ? "Read the note first: Goal, Scope, Verify, Todo, Questions, Handoff and Log." : "",
      `Then say in a few lines where ${
        id ? "the task" : "the work"
      } stands and wait for the user's direction.`,
    ].filter(Boolean).join(" ")
    await open(fleet, win, name, checkout.dir, prompt)
  }
  if (env("TMUX")) await tmux("switch-client", "-t", `=${fleet.name}:${win}`)
  else print(`opened ${fleet.name}:${win}; fleet attach ${fleet.name} to use it`)
}

// The window, its two panes and the claude launch line
async function open(fleet: Fleet, win: string, name: string, dir: string, prompt: string) {
  // --add-dir takes any number of folders, so -- ends the options and keeps
  // the prompt from being read as one
  const claude = `claude -n ${fleet.name}-${name}-pair --plugin-dir ${shq(root)}/plugin --add-dir ${
    shq(fleet.notes)
  } -- ${shq(prompt)}`
  // The fleet's config folder, from the orchestrator's launch line, is set in
  // the panes' environment, so a claude started there again by hand gets it
  // too
  const orchCmd = await opt(await fleet.pane("orch"), "@agent_cmd")
  const configDir = orchCmd.match(/^CLAUDE_CONFIG_DIR=('(?:[^']|'\\'')*'|\S+) claude /)?.[1]
  const paneEnv = configDir ? ["-e", `CLAUDE_CONFIG_DIR=${unquote(configDir)}`] : []
  const editor = await run("tmux", [
    "new-window",
    "-d",
    "-t",
    fleet.target,
    "-n",
    win,
    "-c",
    dir,
    ...paneEnv,
    "-P",
    "-F",
    "#{pane_id}",
  ])
  const agent = await run("tmux", [
    "split-window",
    "-h",
    "-d",
    "-t",
    editor,
    "-c",
    dir,
    ...paneEnv,
    "-P",
    "-F",
    "#{pane_id}",
  ])
  await borders(`=${fleet.name}:${win}`)
  for (const [pane, title] of [[editor, `${fleet.name}-${name}`], [agent, `${fleet.name}-${name}-claude`]]) {
    await tmux("set", "-p", "-t", pane, "allow-set-title", "off")
    await tmux("select-pane", "-t", pane, "-T", title)
  }
  await tmux("send-keys", "-t", editor, "nvim .", "Enter")
  await tmux("send-keys", "-t", agent, claude, "Enter")
  await tmux("select-pane", "-t", agent)
}

// A value shq quoted, as it was typed into a launch line
function unquote(value: string): string {
  return value.startsWith("'") ? value.slice(1, -1).replaceAll(`'\\''`, "'") : value
}

function realPath(path: string): string {
  try {
    return Deno.realPathSync(path)
  } catch {
    return die(`no such folder: ${path}`)
  }
}

const slug = (ref: string) => ref.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "")

async function describe(dir: string): Promise<string> {
  const head = await run("git", ["-C", dir, "rev-parse", "--short", "HEAD"])
  const branch = await output("git", ["-C", dir, "symbolic-ref", "-q", "--short", "HEAD"])
  return branch ? `on branch ${branch} at ${head}` : `detached at ${head}`
}

// Whether a local branch exists and no worktree has it checked out
async function freeBranch(repo: string, branch: string): Promise<boolean> {
  if (!(await test("git", ["-C", repo, "rev-parse", "-q", "--verify", `refs/heads/${branch}`]))) return false
  const list = (await output("git", ["-C", repo, "worktree", "list", "--porcelain"])).split("\n")
  return !list.includes(`branch refs/heads/${branch}`)
}

// A task's checkout. While the task's worker holds it, the worker's worktree,
// where the work is in progress. Otherwise a worktree of its own,
// .claude/worktrees/<fleet>-pair-<id>, at the state the note records: the
// task's end, or for a follow-up nobody has started, the end of the task it
// follows, or else the default branch. It checks out the note's branch when
// that branch contains the end and no other worktree has it, so new commits
// continue the branch; otherwise it is detached at that commit. A worktree an
// earlier pair made is reused as it is, since it may hold the user's work.
async function taskCheckout(fleet: Fleet, id: string, path: string): Promise<Checkout> {
  const repo = fleet.repoOf(path)
  const seat = fleet.seatOf(note.get(path, "worker"))
  // the worker's worktree holds the task's state only while the worker holds
  // the task; after that the worker moves on there
  if (seat && (await opt(await fleet.pane(seat), "@agent_task")) === id) {
    const dir = fleet.checkout(seat, repo) || repo || fleet.notes
    warn(`${seat} still holds ${id} and may be editing ${dir} too`)
    return {
      dir,
      where:
        `This folder is ${seat}'s worktree, where ${seat}, the fleet's worker on this task, may be working ` +
        "too, so check git status before editing.",
    }
  }
  if (!repo) return { dir: fleet.notes, where: "The fleet has no repo, and this folder is its notes folder." }

  const dir = join(repo, ".claude", "worktrees", `${fleet.name}-pair-${id}`)
  let applied = ""
  const closed = (p: string) => {
    const end = note.get(p, "end")
    return end && end !== "-" ? end : ""
  }
  let source = path
  let end = closed(path)
  const follows = note.get(path, "follows")
  if (!end && follows) {
    const prev = note.path(fleet.notes, follows)
    if (isFile(prev) && closed(prev)) {
      source = prev
      end = closed(prev)
    }
  }
  if (!isDir(dir)) {
    const rev = end || (await defaultBranch(repo)) || "HEAD"
    const branch = end ? note.get(source, "branch") : ""
    const free = branch !== "" && await freeBranch(repo, branch) &&
      await test("git", ["-C", repo, "merge-base", "--is-ancestor", rev, branch])
    if (free) await run("git", ["-C", repo, "worktree", "add", "-q", dir, branch])
    else await run("git", ["-C", repo, "worktree", "add", "-q", "--detach", dir, rev])
    // the work the worker left uncommitted at the close, as uncommitted changes
    const saved = note.get(source, "wip").split(" ")[1]
    if (saved) applied = await wip.apply(dir, saved) ? "applied" : "failed"
  }
  let where = `This folder is a worktree made for this session, ${await describe(dir)}.`
  if (end) {
    const what = source === path
      ? `this task's end, ${end.slice(0, 12)}`
      : `${end.slice(0, 12)}, the end of ${basename(source).replace(/\.md$/, "")}, which this task follows`
    const past = Number(await output("git", ["-C", dir, "rev-list", "--count", `${end}..HEAD`])) || 0
    where += past ? ` It is ${past} commits past ${what}.` : ` That is ${what}.`
  } else {
    where += " The note records no end, so it starts from the default branch."
  }
  const savedRef = note.get(source, "wip").split(" ")[0]
  if (applied === "applied") {
    where +=
      ` The work the worker left uncommitted when the task closed, saved in ${savedRef}, is applied here as uncommitted changes.`
  } else if (applied === "failed") {
    where +=
      ` The work the worker left uncommitted when the task closed is saved in ${savedRef}, and it did not apply cleanly to this checkout.`
  }
  return { dir, where }
}

// A worktree of its own at a ref: the local branch when no other worktree has
// it, a new branch tracking origin's when only origin has it, or else
// detached at the ref. An existing worktree is reused only when it is already
// at that ref, since switching it could lose the user's work.
async function refCheckout(repo: string, dir: string, ref: string): Promise<Checkout> {
  if (isDir(dir)) {
    const at = await output("git", ["-C", dir, "symbolic-ref", "-q", "--short", "HEAD"])
    const same = at === ref ||
      (await output("git", ["-C", dir, "rev-parse", "HEAD"])) ===
        (await output("git", ["-C", repo, "rev-parse", "-q", "--verify", `${ref}^{commit}`]))
    if (!same) {
      die(`${dir} exists ${await describe(dir)}; close its window and remove it, or pair on ${at || "it"}`)
    }
  } else if (await freeBranch(repo, ref)) {
    await run("git", ["-C", repo, "worktree", "add", "-q", dir, ref])
  } else if (
    !(await test("git", ["-C", repo, "rev-parse", "-q", "--verify", `refs/heads/${ref}`])) &&
    await test("git", ["-C", repo, "rev-parse", "-q", "--verify", `refs/remotes/origin/${ref}`])
  ) {
    await run("git", ["-C", repo, "worktree", "add", "-q", "--track", "-b", ref, dir, `origin/${ref}`])
  } else if (await test("git", ["-C", repo, "rev-parse", "-q", "--verify", `${ref}^{commit}`])) {
    await run("git", ["-C", repo, "worktree", "add", "-q", "--detach", dir, ref])
  } else {
    die(`no branch, tag or commit ${ref} in ${repo}`)
  }
  return { dir, where: `This folder is a worktree made for this session, ${await describe(dir)}.` }
}

// An existing folder, used as it is
async function dirCheckout(fleet: Fleet, dir: string): Promise<Checkout> {
  if (!isDir(dir)) die(`not a folder: ${dir}`)
  const seat = dir.match(new RegExp(`/\\.claude/worktrees/${fleet.name}-(w\\d+)$`))?.[1]
  if (seat) {
    const task = await opt(await fleet.pane(seat), "@agent_task")
    if (task) warn(`${dir} is ${seat}'s worktree, and ${seat} holds ${task}`)
  }
  const inGit = await test("git", ["-C", dir, "rev-parse", "--is-inside-work-tree"])
  return {
    dir,
    where:
      `This folder is ${dir}, an existing ${
        inGit ? `checkout ${await describe(dir)}` : "folder"
      }, used as it is.` +
      (seat ? ` It is ${seat}'s worktree, so check git status before editing.` : ""),
  }
}

// A pull or merge request reference: a URL, owner/repo#N, group/project!N,
// or a bare #N, !N or N for the fleet's repo
type PrRef = { number: string; kind?: "github" | "gitlab"; host?: string; project?: string }

function parsePr(ref: string): PrRef {
  let m = ref.match(/^https?:\/\/([^/]+)\/(.+?)\/pull\/(\d+)/)
  if (m) return { host: m[1].toLowerCase(), project: m[2], number: m[3], kind: "github" }
  m = ref.match(/^https?:\/\/([^/]+)\/(.+?)\/-\/merge_requests\/(\d+)/)
  if (m) return { host: m[1].toLowerCase(), project: m[2], number: m[3], kind: "gitlab" }
  m = ref.match(/^([\w.-]+\/[\w./-]+)#(\d+)$/)
  if (m) return { project: m[1], number: m[2], kind: "github" }
  m = ref.match(/^([\w.-]+(?:\/[\w.-]+)+)!(\d+)$/)
  if (m) return { project: m[1], number: m[2], kind: "gitlab" }
  m = ref.match(/^([#!]?)(\d+)$/)
  if (m) return { number: m[2], kind: m[1] === "#" ? "github" : m[1] === "!" ? "gitlab" : undefined }
  return die(`not a pull or merge request: ${ref}`)
}

// host/path of a remote URL, for comparing remotes however they are written:
// git@host:group/proj.git, ssh://git@host:22/group/proj, https://host/group/proj
export function remoteKey(url: string): string {
  let m = url.match(/^[\w.-]+@([^:/]+):(.+)$/)
  if (!m) m = url.match(/^(?:ssh|https?|git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/)
  if (!m) return ""
  return `${m[1].toLowerCase()}/${m[2].replace(/\.git$/, "").replace(/\/+$/, "")}`
}

// Git checkouts in a folder, two levels deep: <dir>/<repo> and <dir>/<group>/<repo>
function clonesUnder(dir: string): string[] {
  const out: string[] = []
  const children = (d: string) => {
    try {
      return [...Deno.readDirSync(d)].filter((e) => e.isDirectory && !e.name.startsWith(".")).map((e) =>
        join(d, e.name)
      )
    } catch {
      return []
    }
  }
  for (const a of children(dir)) {
    if (isDir(join(a, ".git"))) out.push(a)
    else for (const b of children(a)) if (isDir(join(b, ".git"))) out.push(b)
  }
  return out
}

// The local clone a reference's project lives in: the task's repo, then the
// fleet's repos, then the checkouts under $FLEET_REPO_DIRS (colon-separated,
// default ~/code), matched by origin's URL as configured. `git remote get-url` would
// apply url.<base>.insteadOf rewrites and hide the host.
async function findClone(fleet: Fleet, pr: PrRef, taskRepo: string): Promise<string> {
  if (!pr.project) return taskRepo || fleet.repo || die(`${fleet.name} has no repo for ${pr.number}`)
  const dirs = (env("FLEET_REPO_DIRS") || join(env("HOME"), "code")).split(":").filter(Boolean)
  const candidates = [...new Set([taskRepo, ...fleet.repos, ...dirs.flatMap(clonesUnder)].filter(Boolean))]
  const want = pr.project.replace(/\.git$/, "").toLowerCase()
  for (const repo of candidates) {
    const key = remoteKey(await output("git", ["-C", repo, "config", "--get", "remote.origin.url"]))
      .toLowerCase()
    if (!key) continue
    const [host, ...rest] = key.split("/")
    if (
      rest.join("/") === want && (!pr.host || host === pr.host) &&
      (pr.host || pr.kind !== "github" || host === "github.com")
    ) {
      return repo
    }
  }
  return die(
    `no local clone of ${pr.host ? `${pr.host}/` : ""}${pr.project} in ${fleet.name}'s repos or under ${
      dirs.join(", ")
    }; ` +
      "clone it, or pass --dir <its checkout>",
  )
}

// A worktree of its own at a pull or merge request's branch. A request from
// the same repo checks out its branch tracking origin's, so commits pushed
// from the session update it; one from a fork, or whose branch another
// worktree has, is detached at the request's head.
async function prCheckout(fleet: Fleet, pr: PrRef, taskRepo: string, name: string) {
  const clone = await findClone(fleet, pr, taskRepo)
  const origin = remoteKey(await output("git", ["-C", clone, "config", "--get", "remote.origin.url"]))
  const kind = pr.kind ?? (origin.startsWith("github.com/") ? "github" : "gitlab")
  const n = pr.number
  let branch: string
  let title: string
  let url: string
  let cross: boolean
  if (kind === "github") {
    const info = JSON.parse(
      await run("gh", ["pr", "view", n, "--json", "headRefName,isCrossRepository,title,url"], { cwd: clone }),
    )
    ;({ headRefName: branch, title, url, isCrossRepository: cross } = info)
  } else {
    const info = JSON.parse(await run("glab", ["mr", "view", n, "-F", "json"], { cwd: clone }))
    branch = info.source_branch
    title = info.title
    url = info.web_url
    cross = info.source_project_id !== info.target_project_id
  }
  const what = kind === "github" ? `pull request #${n}` : `merge request !${n}`
  const read = kind === "github" ? `gh pr view ${n} --comments` : `glab mr view ${n} --comments`
  const dir = join(clone, ".claude", "worktrees", `${fleet.name}-pair-${name}`)
  if (!isDir(dir)) {
    const headRef = kind === "github" ? `pull/${n}/head` : `merge-requests/${n}/head`
    if (!cross && await test("git", ["-C", clone, "fetch", "-q", "origin", branch], { quiet: false })) {
      const local = await test("git", ["-C", clone, "rev-parse", "-q", "--verify", `refs/heads/${branch}`])
      if (!local) {
        await run("git", [
          "-C",
          clone,
          "worktree",
          "add",
          "-q",
          "--track",
          "-b",
          branch,
          dir,
          `origin/${branch}`,
        ])
      } else if (await freeBranch(clone, branch)) {
        await run("git", ["-C", clone, "worktree", "add", "-q", dir, branch])
        if (!(await test("git", ["-C", dir, "merge", "-q", "--ff-only", `origin/${branch}`]))) {
          warn(`the local ${branch} has commits origin's doesn't; left it as is`)
        }
      } else {
        await run("git", ["-C", clone, "worktree", "add", "-q", "--detach", dir, `origin/${branch}`])
      }
    } else {
      await run("git", ["-C", clone, "fetch", "-q", "origin", headRef])
      await run("git", ["-C", clone, "worktree", "add", "-q", "--detach", dir, "FETCH_HEAD"])
    }
  }
  const attached = (await output("git", ["-C", dir, "symbolic-ref", "-q", "--short", "HEAD"])) === branch
  const about = `The work is ${what}, "${title}", ${url}, from branch ${branch}. ` +
    `Read its description and review threads with \`${read}\` in this folder.`
  const where = `This folder is a worktree made for this session in ${clone}, ${await describe(dir)}.` +
    (attached
      ? ` Pushing this branch updates the ${
        kind === "github" ? "pull" : "merge"
      } request, so push only when the user asks.`
      : ` It is detached, so pushing from here does not update the ${
        kind === "github" ? "pull" : "merge"
      } request.`)
  return { checkout: { dir, where }, about }
}
