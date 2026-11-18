import { locate, parsePatch } from "./patch.ts"

function assert(value: unknown, message = "Assertion failed"): asserts value {
  if (!value) throw new Error(message)
}

const PATCH = `diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,4 +1,5 @@
 import { a } from "./a"
-const port = 80
+const port = 8080
+const host = "localhost"

 export { port }
diff --git a/old.txt b/new.txt
similarity index 90%
rename from old.txt
rename to new.txt
diff --git a/gone.md b/gone.md
deleted file mode 100644
index 3333333..0000000
--- a/gone.md
+++ /dev/null
@@ -1,2 +0,0 @@
-# Gone
-bye
`

Deno.test("splits files and maps each side's lines", () => {
  const files = parsePatch(PATCH)
  assert(files.map((f) => f.path).join() === "src/app.ts,new.txt,gone.md")
  const app = files[0]
  assert(app.new.get(2) === "const port = 8080")
  assert(app.new.get(3) === 'const host = "localhost"')
  assert(app.old.get(2) === "const port = 80")
  assert(app.new.get(5) === "export { port }" && app.old.get(4) === "export { port }")
  assert(app.added === 2 && app.removed === 1)
  assert(files[1].oldPath === "old.txt")
  assert(files[2].path === "gone.md" && files[2].old.get(2) === "bye")
  assert(app.text.startsWith("diff --git a/src/app.ts") && app.text.endsWith("export { port }"))
})

Deno.test("an anchor follows its quoted line and goes outdated when it is gone", () => {
  const files = parsePatch(PATCH)
  const anchor = { path: "src/app.ts", side: "new" as const, line: 3, end: 3, quote: 'const host = "localhost"' }
  assert(JSON.stringify(locate(files, anchor)) === '{"line":3,"end":3}')
  const moved = parsePatch(PATCH.replace(" import { a }", "+// header\n import { a }").replace("@@ -1,4 +1,5 @@", "@@ -1,4 +1,6 @@"))
  assert(JSON.stringify(locate(moved, { ...anchor, end: 4 })) === '{"line":4,"end":5}')
  assert(locate(files, { ...anchor, quote: "const host = 1" }) === null)
  assert(locate(files, { ...anchor, path: "missing.ts" }) === null)
  // a blank line moved by the inserted header: too common a line to follow
  assert(locate(moved, { ...anchor, line: 4, end: 4, quote: "" }) === null)
})

Deno.test("quoted and spaced paths parse", () => {
  const patch = [
    'diff --git "a/q\\"x.ts" "b/q\\"x.ts"',
    "index 1..2 100644",
    '--- "a/q\\"x.ts"',
    '+++ "b/q\\"x.ts"',
    "@@ -1 +1 @@",
    "-a",
    "+b",
    "diff --git a/my b/file.md b/my b/file.md",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/my b/file.md",
    "@@ -0,0 +1 @@",
    "+hi",
    'diff --git "a/tab\\there" "b/caf\\303\\251"',
    "similarity index 100%",
    'rename from "tab\\there"',
    'rename to "caf\\303\\251"',
  ].join("\n") + "\n"
  const files = parsePatch(patch)
  assert(files.map((f) => f.path).join("|") === 'q"x.ts|my b/file.md|café', files.map((f) => f.path).join("|"))
  assert(files[0].new.get(1) === "b" && files[1].new.get(1) === "hi")
  assert(files[2].oldPath === "tab\there")
})
