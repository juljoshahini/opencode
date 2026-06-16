import { Hono } from "hono"
import { cors } from "hono/cors"
import { type Env, draftPrefixFor, draftKeyFor } from "./env"
import { bearerAuth } from "./auth"
import { OpenCodeSession } from "./session"

// A session's files ARE the variant draft in landerlab-prod:
// variants/unpublished/<id>/, where id is the session id = the variant's
// encryptedId (the backend sends it that way). These routes (used by the
// backend's CFWorkerService to read/write/list the workspace) operate on that
// bucket. Every per-file key goes through draftKeyFor, which refuses any path
// that could escape the per-session prefix (returns null -> 400 here).

export { OpenCodeSession }

const app = new Hono<{ Bindings: Env }>()

app.use("*", cors({ origin: "*", allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"], allowHeaders: ["Authorization", "Content-Type"], maxAge: 86400 }))

app.get("/", (c) =>
  c.json({
    name: "opencode-cf",
    purpose: "static landing-page generation via opencode",
    routes: {
      "POST /sessions": "create session — optional body: { apiKey?: \"sk-or-...\" } pins a per-session OpenRouter key (BYOK)",
      "PUT /sessions/:id/files/*path": "upload file (raw bytes)",
      "GET /sessions/:id/files": "list files",
      "GET /sessions/:id/files/*path": "read file",
      "DELETE /sessions/:id/files/*path": "delete file",
      "POST /sessions/:id/prompt": "run a prompt (SSE) — body: { prompt, agent?, model?, title?, system?, attachments?: [{url, mime?, filename?}] }",
      "DELETE /sessions/:id": "tear down session",
    },
  }),
)

app.use("*", bearerAuth())

function randomId(): string {
  return crypto.randomUUID().replace(/-/g, "")
}

app.post("/sessions", async (c) => {
  const id = randomId()
  let body: { apiKey?: string } = {}
  try {
    const ct = c.req.header("content-type") ?? ""
    if (ct.includes("application/json")) body = (await c.req.json()) as { apiKey?: string }
  } catch {}
  if (body.apiKey && typeof body.apiKey === "string") {
    const stub = c.env.SESSIONS.get(c.env.SESSIONS.idFromName(id))
    await stub.fetch("http://do/__do/set-byok", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: body.apiKey }),
    })
  }
  return c.json({ id, byok: Boolean(body.apiKey) })
})

app.put("/sessions/:id/files/:path{.+}", async (c) => {
  const id = c.req.param("id")
  const rel = c.req.param("path")
  const key = draftKeyFor(id, rel)
  if (key === null) return c.json({ error: "invalid path" }, 400)
  const body = await c.req.arrayBuffer()
  await c.env.PROD.put(key, body, {
    httpMetadata: { contentType: c.req.header("content-type") ?? "application/octet-stream" },
  })
  return c.json({ ok: true, bytes: body.byteLength, path: rel })
})

app.get("/sessions/:id/files", async (c) => {
  const id = c.req.param("id")
  const prefix = draftPrefixFor(id)
  const out: { path: string; size: number; uploaded: string }[] = []
  let cursor: string | undefined
  do {
    const list = await c.env.PROD.list({ prefix, cursor })
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
  const key = draftKeyFor(id, rel)
  if (key === null) return c.json({ error: "invalid path" }, 400)
  const got = await c.env.PROD.get(key)
  if (!got) return c.json({ error: "not found" }, 404)
  const headers = new Headers()
  got.writeHttpMetadata(headers)
  headers.set("etag", got.httpEtag)
  return new Response(got.body, { headers })
})

app.delete("/sessions/:id/files/:path{.+}", async (c) => {
  const id = c.req.param("id")
  const rel = c.req.param("path")
  const key = draftKeyFor(id, rel)
  if (key === null) return c.json({ error: "invalid path" }, 400)
  await c.env.PROD.delete(key)
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
