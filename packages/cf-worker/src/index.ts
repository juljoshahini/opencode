import { Hono } from "hono"
import { cors } from "hono/cors"
import { type Env, r2PrefixFor } from "./env"
import { bearerAuth } from "./auth"
import { OpenCodeSession } from "./session"

export { OpenCodeSession }

const app = new Hono<{ Bindings: Env }>()

app.use("*", cors({ origin: "*", allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"], allowHeaders: ["Authorization", "Content-Type"], maxAge: 86400 }))

app.get("/", (c) =>
  c.json({
    name: "opencode-cf",
    purpose: "static landing-page generation via opencode",
    routes: {
      "POST /sessions": "create session",
      "PUT /sessions/:id/files/*path": "upload file (raw bytes)",
      "GET /sessions/:id/files": "list files",
      "GET /sessions/:id/files/*path": "read file",
      "DELETE /sessions/:id/files/*path": "delete file",
      "POST /sessions/:id/prompt": "run a prompt (SSE) — body: { prompt, agent?, model?, title?, system? }",
      "DELETE /sessions/:id": "tear down session",
    },
  }),
)

app.use("*", bearerAuth())

function randomId(): string {
  return crypto.randomUUID().replace(/-/g, "")
}

app.post("/sessions", (c) => {
  const id = randomId()
  return c.json({ id })
})

app.put("/sessions/:id/files/:path{.+}", async (c) => {
  const id = c.req.param("id")
  const rel = c.req.param("path")
  const key = `${r2PrefixFor(id)}${rel}`
  const body = await c.req.arrayBuffer()
  await c.env.FILES.put(key, body, {
    httpMetadata: { contentType: c.req.header("content-type") ?? "application/octet-stream" },
  })
  return c.json({ ok: true, bytes: body.byteLength, path: rel })
})

app.get("/sessions/:id/files", async (c) => {
  const id = c.req.param("id")
  const prefix = r2PrefixFor(id)
  const out: { path: string; size: number; uploaded: string }[] = []
  let cursor: string | undefined
  do {
    const list = await c.env.FILES.list({ prefix, cursor })
    cursor = list.truncated ? list.cursor : undefined
    for (const obj of list.objects) {
      out.push({
        path: obj.key.slice(prefix.length),
        size: obj.size,
        uploaded: obj.uploaded.toISOString(),
      })
    }
  } while (cursor)
  return c.json({ files: out })
})

app.get("/sessions/:id/files/:path{.+}", async (c) => {
  const id = c.req.param("id")
  const rel = c.req.param("path")
  const got = await c.env.FILES.get(`${r2PrefixFor(id)}${rel}`)
  if (!got) return c.json({ error: "not found" }, 404)
  const headers = new Headers()
  got.writeHttpMetadata(headers)
  headers.set("etag", got.httpEtag)
  return new Response(got.body, { headers })
})

app.delete("/sessions/:id/files/:path{.+}", async (c) => {
  const id = c.req.param("id")
  const rel = c.req.param("path")
  await c.env.FILES.delete(`${r2PrefixFor(id)}${rel}`)
  return c.json({ ok: true })
})

app.post("/sessions/:id/prompt", async (c) => {
  const id = c.req.param("id")
  const stub = c.env.SESSIONS.get(c.env.SESSIONS.idFromName(id))
  const body = await c.req.text()
  return stub.fetch("http://do/__do/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  })
})

app.delete("/sessions/:id", async (c) => {
  const id = c.req.param("id")
  const stub = c.env.SESSIONS.get(c.env.SESSIONS.idFromName(id))
  return stub.fetch("http://do/__do/teardown", { method: "POST" })
})

app.notFound((c) => c.json({ error: "not found" }, 404))
app.onError((err, c) => {
  console.error(err)
  return c.json({ error: err.message }, 500)
})

export default app satisfies ExportedHandler<Env>
