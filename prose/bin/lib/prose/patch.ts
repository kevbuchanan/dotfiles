// Unified diffs as `git diff` prints them, split per file with each side's
// line numbers mapped to their text. The diff page and the server both use
// it: the page to quote the lines a comment covers and to find a comment's
// lines again after the diff changes, the server to describe a comment to
// the session.

export type Side = "old" | "new"

export type PatchFile = {
  // the new path, or the old one for a deleted file
  path: string
  oldPath: string
  // this file's section of the patch, from its `diff --git` line
  text: string
  old: Map<number, string>
  new: Map<number, string>
  added: number
  removed: number
}

// Where a comment points: lines line..end of one side of one file, and the
// first of those lines as it read when the comment was written. rev names
// the commit that side was read at, with "+" on the new side when it
// includes uncommitted edits.
export type Anchor = {
  path: string
  side: Side
  line: number
  end: number
  quote: string
  rev?: string
}

// git C-quotes a path holding a quote, backslash or control character:
// "a/q\"x". The escapes are \\, \", \a \b \t \n \v \f \r, and \NNN octal for
// any other byte. The server runs git with core.quotePath off, so other
// non-ASCII paths come unquoted.
const ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 }

// Reads one path token from the start of text: a quoted one, or the rest of
// the text. Returns the path and the text after it.
function token(text: string): [string, string] {
  if (!text.startsWith('"')) return [text, ""]
  const bytes: number[] = []
  const utf8 = new TextEncoder()
  let i = 1
  for (; i < text.length && text[i] !== '"'; i++) {
    if (text[i] !== "\\") {
      bytes.push(...utf8.encode(text[i]))
      continue
    }
    const next = text[++i]
    if (/[0-7]/.test(next)) {
      bytes.push(parseInt(text.slice(i, i + 3), 8))
      i += 2
    } else {
      bytes.push(ESCAPES[next] ?? next.charCodeAt(0))
    }
  }
  return [new TextDecoder().decode(new Uint8Array(bytes)), text.slice(i + 1).trimStart()]
}
const strip = (name: string) => token(name)[0].replace(/^[ab]\//, "")

// The two paths of a `diff --git` line. Unquoted, a path may hold " b/",
// so the split takes the last one; the ---, +++ and rename lines that
// follow name the paths without that ambiguity when the file has content.
function gitPaths(names: string): [string, string] {
  if (names.startsWith('"')) {
    const [first, rest] = token(names)
    return [first.replace(/^a\//, ""), strip(rest)]
  }
  const quoted = names.indexOf(' "b/')
  const split = quoted >= 0 ? quoted : names.lastIndexOf(" b/")
  if (split < 0) return [strip(names), strip(names)]
  return [strip(names.slice(0, split)), strip(names.slice(split + 1))]
}

export function parsePatch(patch: string): PatchFile[] {
  const files: PatchFile[] = []
  const lines = patch.split("\n")
  let file: PatchFile | null = null
  let start = 0
  let oldLine = 0
  let newLine = 0
  const finish = (endIndex: number) => {
    if (file) file.text = lines.slice(start, endIndex).join("\n")
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.startsWith("diff --git ")) {
      finish(i)
      start = i
      // a/<old> b/<new>; the ---/+++ lines below replace these when present
      const [oldPath, newPath] = gitPaths(line.slice("diff --git ".length))
      file = { path: newPath, oldPath, text: "", old: new Map(), new: new Map(), added: 0, removed: 0 }
      files.push(file)
      oldLine = newLine = 0
      continue
    }
    if (!file) continue
    if (line.startsWith("--- ") && oldLine === 0 && newLine === 0) {
      const name = line.slice(4)
      if (name !== "/dev/null") file.oldPath = strip(name)
      continue
    }
    if (line.startsWith("+++ ") && oldLine === 0 && newLine === 0) {
      const name = line.slice(4)
      file.path = name === "/dev/null" ? file.oldPath : strip(name)
      continue
    }
    if (line.startsWith("rename from ") && oldLine === 0 && newLine === 0) {
      file.oldPath = token(line.slice("rename from ".length))[0]
      continue
    }
    if (line.startsWith("rename to ") && oldLine === 0 && newLine === 0) {
      file.path = token(line.slice("rename to ".length))[0]
      continue
    }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (hunk) {
      oldLine = Number(hunk[1])
      newLine = Number(hunk[2])
      continue
    }
    if (oldLine === 0 && newLine === 0) continue
    // the split leaves an empty string after the patch's last newline
    if (line === "" && i === lines.length - 1) continue
    // a blank context line is " ", which a copy through an editor or a mail
    // client can lose to trailing-space trimming
    const mark = line === "" ? " " : line[0]
    const text = line.slice(1)
    if (mark === " ") {
      file.old.set(oldLine++, text)
      file.new.set(newLine++, text)
    } else if (mark === "-") {
      file.old.set(oldLine++, text)
      file.removed++
    } else if (mark === "+") {
      file.new.set(newLine++, text)
      file.added++
    }
  }
  finish(lines.at(-1) === "" ? lines.length - 1 : lines.length)
  return files
}

// The lines an anchor points at in the current diff: where they were, or
// the nearest place on the same side of the same file whose line reads as
// the quote did, with the range shifted to match. Null when the quoted line
// is gone, so the comment is outdated. A quote without three letters or
// digits, such as "}" or a blank line, matches too many lines to follow, so
// such a comment stays put or goes outdated.
export function locate(files: PatchFile[], anchor: Anchor): { line: number; end: number } | null {
  const file = files.find((f) => f.path === anchor.path)
  if (!file) return null
  const lines = file[anchor.side]
  const want = anchor.quote.trim()
  if (lines.get(anchor.line)?.trim() === want) return { line: anchor.line, end: anchor.end }
  if ((want.match(/[\p{L}\p{N}]/gu)?.length ?? 0) < 3) return null
  let best: number | null = null
  for (const [n, text] of lines) {
    if (text.trim() !== want) continue
    if (best === null || Math.abs(n - anchor.line) < Math.abs(best - anchor.line)) best = n
  }
  if (best === null) return null
  return { line: best, end: anchor.end + (best - anchor.line) }
}

// path:line or path:line-end, as a reviewer and the fleet notes write it
export const anchorLabel = (a: Anchor) =>
  `${a.path}:${a.line}${a.end > a.line ? `-${a.end}` : ""}${a.side === "old" ? " (old side)" : ""}`
