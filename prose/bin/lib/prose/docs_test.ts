import { join } from "@std/path"
import { Doc } from "./docs.ts"

function assert(value: unknown, message = "Assertion failed"): asserts value {
  if (!value) throw new Error(message)
}

Deno.test("an editor's unsaved text shows until the file changes on disk", async () => {
  const dir = await Deno.makeTempDir()
  const file = join(dir, "doc.md")
  await Deno.writeTextFile(file, "# Saved\n")
  const doc = await Doc.open(file, dir, { session: null, port: 0 })
  const sent: { type: string; text?: string; live?: boolean; line?: number }[] = []
  doc.clients.add({ send: (m: string) => sent.push(JSON.parse(m)) } as unknown as WebSocket)

  doc.showBuffer("# Typing\n")
  assert(sent.length === 1 && sent[0].text === "# Typing\n" && sent[0].live === true, JSON.stringify(sent))
  doc.showBuffer("# Typing\n")
  assert(sent.length === 1, "the same text again sends nothing")
  assert(JSON.parse(doc.docMessage()).text === "# Typing\n", "a page that connects now gets the unsaved text")

  doc.showLine(3)
  assert(sent[1].type === "cursor" && sent[1].line === 3)

  // a save of the typed text: the file catches up, and the text is no
  // longer unsaved
  await Deno.writeTextFile(file, "# Typing\n")
  await doc.onDiskChange()
  const last = sent[sent.length - 1]
  assert(last.text === "# Typing\n" && last.live === false, JSON.stringify(last))

  // typing back to the saved text is not unsaved either
  doc.showBuffer("# Typed more\n")
  doc.showBuffer("# Typing\n")
  assert(JSON.parse(doc.docMessage()).live === false)
  await Deno.remove(dir, { recursive: true })
})
