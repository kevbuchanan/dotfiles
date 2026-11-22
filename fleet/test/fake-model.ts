// A scripted OpenAI-compatible chat model for test/opencode-run, so opencode
// runs with no credentials or cost. The last user text drives it: "RUN:
// <cmd>" calls the shell tool, "SKILL: <id>" calls the skill tool, "SLOW"
// waits 8 s first, and anything else gets "OK: <text>". After a tool result
// it says DONE. Every request is appended to the log file, as JSON lines.
//
//   deno run --allow-net=127.0.0.1 --allow-write=<log> fake-model.ts <log> <port>
const log = Deno.args[0]
const port = Number(Deno.args[1])
const text = (c: unknown) =>
  typeof c === "string" ? c : Array.isArray(c) ? c.map((p) => p?.text ?? "").join("") : ""

Deno.serve({ port, hostname: "127.0.0.1" }, async (req) => {
  const url = new URL(req.url)
  if (url.pathname.endsWith("/models")) return Response.json({ data: [{ id: "fake", object: "model" }] })
  const body = await req.json()
  await Deno.writeTextFile(log, JSON.stringify(body) + "\n", { append: true })
  const msgs = body.messages ?? []
  const last = msgs[msgs.length - 1]
  const users = msgs.filter((m: { role: string }) => m.role === "user")
  const said = text(users[users.length - 1]?.content)
  const tools = (body.tools ?? []).map((
    t: { function: { name: string; parameters: { properties?: Record<string, unknown> } } },
  ) => t.function)
  let call: { name: string; args: Record<string, string> } | null = null
  let reply = ""
  if (last?.role === "tool") reply = "DONE"
  else {
    if (said.includes("SLOW")) await new Promise((r) => setTimeout(r, 8000))
    const run = said.match(/RUN: (.+)/)
    const skill = said.match(/SKILL: (\S+)/)
    if (run) {
      const t = tools.find((f: { name: string }) => /bash|shell/i.test(f.name))
      const args: Record<string, string> = {}
      for (const k of Object.keys(t?.parameters?.properties ?? {})) {
        if (/command/i.test(k)) args[k] = run[1]
        else if (/description/i.test(k)) args[k] = "spike"
      }
      call = { name: t?.name ?? "bash", args }
    } else if (skill) {
      const t = tools.find((f: { name: string }) => /skill/i.test(f.name))
      const args: Record<string, string> = {}
      for (const k of Object.keys(t?.parameters?.properties ?? { id: 1 })) args[k] = skill[1]
      call = { name: t?.name ?? "skill", args }
    } else reply = "OK: " + said.slice(0, 60).replace(/\s+/g, " ")
  }
  const base = { id: "c1", object: "chat.completion.chunk", created: 0, model: "fake" }
  const delta = call
    ? {
      role: "assistant",
      tool_calls: [{
        index: 0,
        id: "call_" + crypto.randomUUID().slice(0, 8),
        type: "function",
        function: { name: call.name, arguments: JSON.stringify(call.args) },
      }],
    }
    : { role: "assistant", content: reply }
  const finish = call ? "tool_calls" : "stop"
  if (!body.stream) {
    return Response.json({
      id: "c1",
      object: "chat.completion",
      created: 0,
      model: "fake",
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: call ? null : reply,
          tool_calls: call ? delta.tool_calls : undefined,
        },
        finish_reason: finish,
      }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    })
  }
  const chunks = [
    { ...base, choices: [{ index: 0, delta, finish_reason: null }] },
    {
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: finish }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    },
  ]
  const sse = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n"
  return new Response(sse, { headers: { "content-type": "text/event-stream" } })
})
