import { Container } from "@cloudflare/containers"
import { type Env, PROVIDER_VARS, historyKeyFor, r2PrefixFor } from "./env"

type Turn = { role: "user" | "assistant"; text: string; time?: number }

export class OpenCodeSession extends Container<Env> {
  defaultPort = 8080
  sleepAfter = "10m"
  requiredPorts = [8080]

  override envVars: Record<string, string> = {}

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.envVars = {
      SIDECAR_TOKEN: env.SIDECAR_TOKEN,
      OPENCODE_SERVER_PASSWORD: env.OPENCODE_SERVER_PASSWORD,
    }
    for (const key of PROVIDER_VARS) {
      const v = env[key]
      if (v) this.envVars[key] = v
    }
  }

  override async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url)
    const path = url.pathname

    if (path === "/__do/run" && req.method === "POST") {
      return this.run(req)
    }
    if (path === "/__do/teardown" && req.method === "POST") {
      return this.teardown()
    }
    if (path === "/__do/sync-up" && req.method === "POST") {
      await this.syncFromR2()
      return Response.json({ ok: true })
    }
    if (path === "/__do/sync-down" && req.method === "POST") {
      await this.syncToR2()
      return Response.json({ ok: true })
    }
    return new Response("not found", { status: 404 })
  }

  private get sessionId(): string {
    return this.ctx.id.name ?? this.ctx.id.toString()
  }

  private get sidecarHeaders(): Record<string, string> {
    return { authorization: `Bearer ${this.env.SIDECAR_TOKEN}` }
  }

  private async run(req: Request): Promise<Response> {
    const rawBody = await req.text()

    await this.startAndWaitForPorts(8080)
    await this.syncFromR2()

    let parsed: Record<string, unknown> = {}
    try {
      parsed = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {}
    } catch {
      return new Response(JSON.stringify({ error: "invalid JSON body" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      })
    }

    if (!parsed.sessionId) {
      const stored = await this.ctx.storage.get<string>("opencodeSessionId")
      if (stored) parsed.sessionId = stored
    }
    if (!parsed.priorTranscript) {
      const stored = await this.loadTranscript()
      if (stored && stored.length > 0) parsed.priorTranscript = stored
    }
    const body = JSON.stringify(parsed)

    const upstream = await this.containerFetch(
      new Request("http://container/prompt", {
        method: "POST",
        headers: { ...this.sidecarHeaders, "content-type": "application/json" },
        body,
      }),
      8080,
    )

    const opencodeSessionId = upstream.headers.get("x-session-id")
    if (opencodeSessionId) {
      await this.ctx.storage.put("opencodeSessionId", opencodeSessionId)
    }
    const opencodeSessionForSync = opencodeSessionId

    if (!upstream.ok || !upstream.body) {
      return upstream
    }

    const sessionState = this
    const reader = upstream.body.getReader()
    const decoder = new TextDecoder()
    let textBuffer = ""
    let sawDone = false

    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const { value, done } = await reader.read()
        if (done) {
          if (!sawDone) {
            sessionState.ctx.waitUntil(sessionState.finalizeRun(opencodeSessionForSync).catch(() => {}))
            sawDone = true
          }
          controller.close()
          return
        }
        controller.enqueue(value)
        textBuffer += decoder.decode(value, { stream: true })
        if (!sawDone && textBuffer.includes("event: done")) {
          sawDone = true
          sessionState.ctx.waitUntil(sessionState.finalizeRun(opencodeSessionForSync).catch(() => {}))
        }
      },
      cancel(reason) {
        reader.cancel(reason).catch(() => {})
      },
    })

    return new Response(stream, {
      status: upstream.status,
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        "x-accel-buffering": "no",
        "x-session-id": this.sessionId,
      },
    })
  }

  private async finalizeRun(opencodeSessionId: string | null): Promise<void> {
    await Promise.allSettled([this.syncToR2(), this.saveTranscript(opencodeSessionId)])
  }

  private async loadTranscript(): Promise<Turn[] | null> {
    const got = await this.env.FILES.get(historyKeyFor(this.sessionId))
    if (!got) return null
    try {
      const parsed = (await got.json()) as Turn[]
      if (!Array.isArray(parsed)) return null
      return parsed
    } catch {
      return null
    }
  }

  private async saveTranscript(opencodeSessionId: string | null): Promise<void> {
    if (!opencodeSessionId) return
    const res = await this.containerFetch(
      new Request(`http://container/transcript/${opencodeSessionId}`, {
        method: "GET",
        headers: this.sidecarHeaders,
      }),
      8080,
    )
    if (!res.ok) return
    const turns = (await res.json()) as Turn[]
    if (!Array.isArray(turns) || turns.length === 0) return
    await this.env.FILES.put(historyKeyFor(this.sessionId), JSON.stringify(turns), {
      httpMetadata: { contentType: "application/json" },
    })
  }

  private async syncFromR2(): Promise<void> {
    const prefix = r2PrefixFor(this.sessionId)
    let cursor: string | undefined
    do {
      const list = await this.env.FILES.list({ prefix, cursor })
      cursor = list.truncated ? list.cursor : undefined
      await Promise.all(
        list.objects.map(async (obj) => {
          const rel = obj.key.slice(prefix.length)
          if (!rel) return
          const got = await this.env.FILES.get(obj.key)
          if (!got) return
          await this.containerFetch(
            new Request(`http://container/fs/${encodeURI(rel)}`, {
              method: "PUT",
              headers: this.sidecarHeaders,
              body: got.body,
            }),
            8080,
          )
        }),
      )
    } while (cursor)
  }

  private async syncToR2(): Promise<void> {
    const prefix = r2PrefixFor(this.sessionId)
    const listRes = await this.containerFetch(
      new Request("http://container/list", {
        method: "GET",
        headers: this.sidecarHeaders,
      }),
      8080,
    )
    if (!listRes.ok) return
    const { files } = (await listRes.json()) as { files: string[] }

    const seen = new Set<string>()
    await Promise.all(
      files.map(async (rel) => {
        const fileRes = await this.containerFetch(
          new Request(`http://container/fs/${encodeURI(rel)}`, {
            method: "GET",
            headers: this.sidecarHeaders,
          }),
          8080,
        )
        if (!fileRes.ok || !fileRes.body) return
        const key = `${prefix}${rel}`
        seen.add(key)
        const body = await fileRes.arrayBuffer()
        await this.env.FILES.put(key, body)
      }),
    )

    let cursor: string | undefined
    do {
      const list = await this.env.FILES.list({ prefix, cursor })
      cursor = list.truncated ? list.cursor : undefined
      const stale = list.objects.map((o) => o.key).filter((k) => !seen.has(k))
      if (stale.length) await this.env.FILES.delete(stale)
    } while (cursor)
  }

  private async teardown(): Promise<Response> {
    try {
      await this.stop()
    } catch {}
    await this.ctx.storage.delete("opencodeSessionId")
    await this.env.FILES.delete(historyKeyFor(this.sessionId)).catch(() => {})
    const prefix = r2PrefixFor(this.sessionId)
    let cursor: string | undefined
    do {
      const list = await this.env.FILES.list({ prefix, cursor })
      cursor = list.truncated ? list.cursor : undefined
      if (list.objects.length) {
        await this.env.FILES.delete(list.objects.map((o) => o.key))
      }
    } while (cursor)
    return Response.json({ ok: true })
  }
}
