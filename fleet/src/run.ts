// Subprocesses. fleet is mostly tmux and git calls, so these keep each one a
// line: run() returns trimmed stdout and stops fleet when the command fails,
// test() answers whether it succeeded, and passthrough() hands the terminal
// to it, for attach and diff.

export class FleetError extends Error {
  constructor(message: string, readonly code = 1) {
    super(message)
  }
}

export function die(message: string, code = 1): never {
  throw new FleetError(message, code)
}

// A template with each {{KEY}} replaced by its value. A replacement string
// would read $&, $' and $$ in a value as patterns, so a title such as
// "charge $$5" goes through a function.
export function fill(template: string, values: Record<string, string>): string {
  let text = template
  for (const [key, value] of Object.entries(values)) text = text.replaceAll(`{{${key}}}`, () => value)
  return text
}

// git's subcommand comes after -C <dir>
const subcommand = (args: string[]) => args[0] === "-C" ? args[2] ?? "" : args[0] ?? ""

type Options = {
  cwd?: string
  stdin?: string
  // the command's stderr, shown by default, as a shell would
  quiet?: boolean
  env?: Record<string, string>
  // environment variables the command must not inherit
  unset?: string[]
}

function command(cmd: string, args: string[], opts: Options, stdout: "piped" | "inherit") {
  let env = opts.env
  let clearEnv = false
  if (opts.unset?.length) {
    env = { ...Deno.env.toObject(), ...opts.env }
    for (const name of opts.unset) delete env[name]
    clearEnv = true
  }
  return new Deno.Command(cmd, {
    args,
    cwd: opts.cwd,
    env,
    clearEnv,
    stdin: opts.stdin === undefined ? (stdout === "inherit" ? "inherit" : "null") : "piped",
    stdout,
    stderr: opts.quiet ? "null" : "inherit",
  })
}

async function exec(cmd: string, args: string[], opts: Options) {
  const child = command(cmd, args, opts, "piped").spawn()
  if (opts.stdin !== undefined) {
    const writer = child.stdin.getWriter()
    await writer.write(new TextEncoder().encode(opts.stdin))
    await writer.close()
  }
  const { code, stdout } = await child.output()
  return { code, out: new TextDecoder().decode(stdout).replace(/\n+$/, "") }
}

export async function run(cmd: string, args: string[], opts: Options = {}): Promise<string> {
  const { code, out } = await exec(cmd, args, opts)
  // exits with the command's own status, as the shell did; its stderr has
  // already shown why
  if (code !== 0) die(`${cmd} ${subcommand(args)} exited ${code}`, code)
  return out
}

// stdout whether or not the command succeeds, for lookups whose failure means
// "none", such as an unset tmux option
export async function output(cmd: string, args: string[], opts: Options = {}): Promise<string> {
  return (await exec(cmd, args, { quiet: true, ...opts })).out
}

export async function test(cmd: string, args: string[], opts: Options = {}): Promise<boolean> {
  return (await exec(cmd, args, { quiet: true, ...opts })).code === 0
}

// Whether the command succeeds, with its output shown, for steps whose output
// the user reads, such as git's "Deleted branch"
export async function succeeds(cmd: string, args: string[], opts: Options = {}): Promise<boolean> {
  return (await passthrough(cmd, args, opts)) === 0
}

export async function passthrough(cmd: string, args: string[], opts: Options = {}): Promise<number> {
  return (await command(cmd, args, opts, "inherit").spawn().status).code
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// A value quoted for the shell line a seat's pane runs, the way zsh's (q)
// flag does it: bare when it is plain, single-quoted otherwise.
export function shq(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value
  return `'${value.replaceAll("'", `'\\''`)}'`
}

export const print = (...lines: string[]) => {
  for (const line of lines) console.log(line)
}
export const warn = (message: string) => console.error(`fleet: ${message}`)

export function isFile(path: string): boolean {
  try {
    return Deno.statSync(path).isFile
  } catch {
    return false
  }
}

export function isDir(path: string): boolean {
  try {
    return Deno.statSync(path).isDirectory
  } catch {
    return false
  }
}

export function exists(path: string): boolean {
  try {
    Deno.lstatSync(path)
    return true
  } catch {
    return false
  }
}

export function isSocket(path: string): boolean {
  if (!path) return false
  try {
    return Deno.statSync(path).isSocket === true
  } catch {
    return false
  }
}

export function readText(path: string): string {
  return Deno.readTextFileSync(path)
}

// The first line of a one-line record file, such as state/<fleet>/repo
export function readRecord(path: string): string {
  return readText(path).replace(/\n.*$/s, "")
}

// Writes beside the target and renames it into place, so a reader never sees
// half a file
export function writeAtomic(path: string, text: string) {
  Deno.writeTextFileSync(`${path}.tmp`, text)
  Deno.renameSync(`${path}.tmp`, path)
}

const pad2 = (n: number) => String(n).padStart(2, "0")

// local date as YYYY-MM-DD, like date +%F
export function today(): string {
  const d = new Date()
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

// local time as YYYY-MM-DD HH:MM, for note Log lines
export function stamp(): string {
  const d = new Date()
  return `${today()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

// rm -f
export function removeIfAny(path: string) {
  try {
    Deno.removeSync(path, { recursive: true })
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e
  }
}
