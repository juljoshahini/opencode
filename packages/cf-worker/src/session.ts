import { Container } from "@cloudflare/containers"
import { type Env, PROVIDER_VARS, historyKeyFor, r2PrefixFor, stateKeyFor } from "./env"
import { logger } from "./log"

type Turn = { role: "user" | "assistant"; text: string; time?: number }

export class OpenCodeSession extends Container<Env> {
  defaultPort = 8080
  sleepAfter = "60s"
  requiredPorts = [8080]

  override envVars: Record<string, string> = {}

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.envVars = {
      SIDECAR_TOKEN: env.SIDECAR_TOKEN,
      OPENCODE_SERVER_PASSWORD: env.OPENCODE_SERVER_PASSWORD,
      WORKER_SESSION_ID: ctx.id.name ?? ctx.id.toString(),
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
    if (path === "/__do/set-byok" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as { apiKey?: string }
      if (typeof body.apiKey === "string" && body.apiKey.trim()) {
        await this.ctx.storage.put("byokOpenRouterKey", body.apiKey.trim())
        logger.info("byok.set", { sessionId: this.sessionId })
        return Response.json({ ok: true, stored: true })
      }
      return Response.json({ ok: true, stored: false })
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
    const runId = crypto.randomUUID().slice(0, 8)
    const t0 = Date.now()
    const sessionId = this.sessionId
    logger.info("run.start", { runId, sessionId })

    const rawBody = await req.text()

    const byok = await this.ctx.storage.get<string>("byokOpenRouterKey")
    if (byok) this.envVars.OPENROUTER_API_KEY = byok
    else if (this.env.OPENROUTER_API_KEY) this.envVars.OPENROUTER_API_KEY = this.env.OPENROUTER_API_KEY

    const tBootStart = Date.now()
    await this.startAndWaitForPorts(8080)
    logger.info("container.ready", { runId, sessionId, msToReady: Date.now() - tBootStart, byok: Boolean(byok) })

    // Push opencode's SQLite bundle into the container BEFORE opencode boots,
    // then signal the supervisor to spawn opencode. start.ts blocks on
    // /__state/start until we call it. This is what makes a cold-started
    // container resume with the exact opencode state — tool history,
    // compaction markers, everything — that the previous prompt ended with.
    const tStateRestore = Date.now()
    const stateRestored = await this.pushStateToContainer(runId)
    await this.signalOpencodeStart(runId)
    logger.info("state.restore", {
      runId,
      sessionId,
      restored: stateRestored,
      ms: Date.now() - tStateRestore,
    })

    const tSyncIn = Date.now()
    const syncedIn = await this.syncFromR2()
    logger.info("r2.sync.in", { runId, sessionId, files: syncedIn, ms: Date.now() - tSyncIn })

    let parsed: Record<string, unknown> = {}
    try {
      parsed = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {}
    } catch {
      logger.warn("run.body.invalid", { runId, sessionId })
      return new Response(JSON.stringify({ error: "invalid JSON body" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      })
    }

    if (!parsed.sessionId) {
      const stored = await this.ctx.storage.get<string>("opencodeSessionId")
      if (stored) {
        parsed.sessionId = stored
        logger.info("opencode.session.restored", { runId, sessionId, opencodeSessionId: stored })
      }
    }
    if (!parsed.priorTranscript) {
      const stored = await this.loadTranscript()
      if (stored && stored.length > 0) {
        parsed.priorTranscript = stored
        logger.info("transcript.restored", { runId, sessionId, turns: stored.length })
      }
    }
    const body = JSON.stringify(parsed)

    logger.info("container.fetch.start", { runId, sessionId })
    const upstream = await this.containerFetch(
      new Request("http://container/prompt", {
        method: "POST",
        headers: { ...this.sidecarHeaders, "content-type": "application/json", "x-run-id": runId },
        body,
      }),
      8080,
    )
    logger.info("container.fetch.headers", { runId, sessionId, status: upstream.status })

    const opencodeSessionId = upstream.headers.get("x-session-id")
    if (opencodeSessionId) {
      await this.ctx.storage.put("opencodeSessionId", opencodeSessionId)
    }
    const opencodeSessionForSync = opencodeSessionId

    if (!upstream.ok || !upstream.body) {
      logger.error("container.fetch.failed", { runId, sessionId, status: upstream.status })
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
        sessionState.renewActivityTimeout()
        controller.enqueue(value)
        textBuffer += decoder.decode(value, { stream: true })
        if (!sawDone && textBuffer.includes("event: done")) {
          sawDone = true
          sessionState.ctx.waitUntil(sessionState.finalizeRun(opencodeSessionForSync).catch(() => {}))
        }
      },
      cancel(reason) {
        reader.cancel(reason).catch(() => {})
        // Client disconnected (Postman closes SSE early, browser tab closed,
        // user hit cancel, etc.). Still persist whatever opencode produced so
        // the next prompt has prior-conversation context. Without this hook,
        // pull() never sees the upstream finish and the transcript is lost.
        if (!sawDone && opencodeSessionForSync) {
          sawDone = true
          sessionState.ctx.waitUntil(sessionState.finalizeRun(opencodeSessionForSync).catch(() => {}))
        }
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
    const t = Date.now()
    const results = await Promise.allSettled([
      this.syncToR2(),
      this.saveTranscript(opencodeSessionId),
      this.pullStateFromContainer(),
    ])
    logger.info("finalize.done", {
      sessionId: this.sessionId,
      opencodeSessionId,
      syncToR2: results[0].status,
      saveTranscript: results[1].status,
      saveState: results[2].status,
      ms: Date.now() - t,
    })
  }

  // Fetch the opencode SQLite bundle from the sidecar and write it to R2.
  // Runs alongside syncToR2 and saveTranscript so we capture both filesystem
  // and DB state at the same checkpoint.
  private async pullStateFromContainer(): Promise<void> {
    const res = await this.containerFetch(
      new Request("http://container/__state/dump", {
        method: "GET",
        headers: this.sidecarHeaders,
      }),
      8080,
    )
    if (!res.ok) {
      logger.warn("state.dump.failed", { sessionId: this.sessionId, status: res.status })
      return
    }
    const bundle = (await res.json()) as { db?: string; wal?: string; shm?: string }
    if (!bundle.db && !bundle.wal && !bundle.shm) {
      logger.info("state.dump.empty", { sessionId: this.sessionId })
      return
    }
    await this.env.FILES.put(stateKeyFor(this.sessionId), JSON.stringify(bundle), {
      httpMetadata: { contentType: "application/json" },
    })
    logger.info("state.saved", {
      sessionId: this.sessionId,
      db: bundle.db?.length ?? 0,
      wal: bundle.wal?.length ?? 0,
      shm: bundle.shm?.length ?? 0,
    })
  }

  // Counterpart to pullStateFromContainer — read the saved bundle from R2 and
  // push it into the container before opencode boots. Returns true if a saved
  // state existed and was successfully restored.
  private async pushStateToContainer(runId: string): Promise<boolean> {
    const got = await this.env.FILES.get(stateKeyFor(this.sessionId))
    if (!got) return false
    let bundle: unknown
    try {
      bundle = await got.json()
    } catch (error) {
      logger.warn("state.bundle.invalid", { runId, sessionId: this.sessionId, error: String(error) })
      return false
    }
    const res = await this.containerFetch(
      new Request("http://container/__state/restore", {
        method: "PUT",
        headers: { ...this.sidecarHeaders, "content-type": "application/json" },
        body: JSON.stringify(bundle),
      }),
      8080,
    )
    if (!res.ok) {
      logger.warn("state.restore.failed", { runId, sessionId: this.sessionId, status: res.status })
      return false
    }
    return true
  }

  private async signalOpencodeStart(runId: string): Promise<void> {
    const res = await this.containerFetch(
      new Request("http://container/__state/start", {
        method: "POST",
        headers: this.sidecarHeaders,
      }),
      8080,
    )
    if (!res.ok) {
      logger.warn("state.start.failed", { runId, sessionId: this.sessionId, status: res.status })
    }
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

  private async syncFromR2(): Promise<number> {
    const prefix = r2PrefixFor(this.sessionId)
    let cursor: string | undefined
    let count = 0
    do {
      const list = await this.env.FILES.list({ prefix, cursor })
      cursor = list.truncated ? list.cursor : undefined
      await Promise.all(
        list.objects.map(async (obj) => {
          const rel = obj.key.slice(prefix.length)
          if (!rel) return
          const got = await this.env.FILES.get(obj.key)
          if (!got) return
          count += 1
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
    return count
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
    await this.ctx.storage.delete("byokOpenRouterKey")
    await this.env.FILES.delete(historyKeyFor(this.sessionId)).catch(() => {})
    await this.env.FILES.delete(stateKeyFor(this.sessionId)).catch(() => {})
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
