import type { Event } from "./events.ts"
import { InputError, parseUser } from "./events.ts"
import { noteThreads } from "./review.ts"

function assert(value: unknown, message = "Assertion failed"): asserts value {
  if (!value) throw new Error(message)
}

const anchor = { path: "src/app.ts", side: "new", line: 3, end: 4, quote: "const host = 1", rev: "abc1234+" }

Deno.test("a diff comment needs text and an anchor with a side and ordered lines", () => {
  const input = parseUser({ kind: "diff-comment", text: "Rename", anchor })
  assert(input.anchor?.path === "src/app.ts" && input.anchor.rev === "abc1234+")
  for (const bad of [{ ...anchor, side: "left" }, { ...anchor, end: 2 }, { ...anchor, line: 0 }, { ...anchor, path: "" }]) {
    let threw = false
    try {
      parseUser({ kind: "diff-comment", text: "x", anchor: bad })
    } catch (error) {
      threw = error instanceof InputError
    }
    assert(threw, `accepted ${JSON.stringify(bad)}`)
  }
})

Deno.test("a task review reads each todo's checkbox and the worker's replies", () => {
  const event = (id: string, todo: string) =>
    ({ id, seq: 1, ts: "", file: "k", kind: "diff-comment", text: "t", anchor, todo }) as Event
  const note = [
    "## Todo",
    "",
    "- [x] Review src/app.ts:3-4 `const host = 1`: rename",
    "  - reply: renamed to HOST",
    "  - a nested note",
    "  - reply: and exported it",
    "- [ ] Review src/app.ts:9: why?",
    "",
    "## Log",
  ].join("\n")
  const out = noteThreads(note, [
    event("a", "- [ ] Review src/app.ts:3-4 `const host = 1`: rename"),
    event("b", "- [ ] Review src/app.ts:9: why?"),
    event("c", "- [ ] Review gone.ts:1: removed by the worker"),
  ])
  assert(JSON.stringify(out.a) === '{"checked":true,"replies":["renamed to HOST","and exported it"]}')
  assert(JSON.stringify(out.b) === '{"checked":false,"replies":[]}')
  assert(JSON.stringify(out.c) === '{"missing":true}')
})
