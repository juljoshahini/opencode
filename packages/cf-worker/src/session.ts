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
    // Cast: newer @cloudflare/workers-types defaults DurableObjectState's
    // generic to `unknown`, but @cloudflare/containers' Container<Env>
    // expects `DurableObjectState<{}>`. Pure type-level fix.
    super(ctx as DurableObjectState<{}>, env)
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
        await this.ctx.storage.put("byokAiGatewayKey", body.apiKey.trim())
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

    const byok = await this.ctx.storage.get<string>("byokAiGatewayKey")
    if (byok) this.envVars.AI_GATEWAY_API_KEY = byok
    else if (this.env.AI_GATEWAY_API_KEY) this.envVars.AI_GATEWAY_API_KEY = this.env.AI_GATEWAY_API_KEY

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
    let streamedBytes = 0
    let streamedChunks = 0
    const tStreamStart = Date.now()
    // Eager image sync: tool outputs carry a publicUrl that only becomes
    // fetchable once the workspace syncs to R2 — normally at turn end. When
    // we spot an image-producing tool completing mid-stream, sync right away
    // (debounced) so the frontend's thumbnails load seconds after generation
    // instead of after the whole turn. `eagerWindow` is a small sliding
    // window over the decoded stream so markers split across chunks still
    // match.
    let eagerWindow = ""
    let lastEagerSyncAt = 0
    const EAGER_SYNC_DEBOUNCE_MS = 8_000
    const EAGER_TOOL_RX = /"tool":\s*"(?:image_generate|image_use|imageTool)"/

    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        let result: ReadableStreamReadResult<Uint8Array>
        try {
          result = await reader.read()
        } catch (e) {
          // Upstream (container) died mid-stream — without this log the only
          // trace is a generic stream error on the consumer side.
          logger.error("stream.pull.error", {
            runId,
            sessionId,
            streamedBytes,
            streamedChunks,
            sawDone,
            msSinceStreamStart: Date.now() - tStreamStart,
            error: String(e),
          })
          if (!sawDone) {
            sawDone = true
            sessionState.ctx.waitUntil(sessionState.finalizeRun(opencodeSessionForSync).catch(() => {}))
          }
          throw e
        }
        const { value, done } = result
        if (done) {
          logger.info("stream.close", {
            runId,
            sessionId,
            streamedBytes,
            streamedChunks,
            sawDone,
            ms: Date.now() - tStreamStart,
          })
          if (!sawDone) {
            sessionState.ctx.waitUntil(sessionState.finalizeRun(opencodeSessionForSync).catch(() => {}))
            sawDone = true
          }
          controller.close()
          return
        }
        sessionState.renewActivityTimeout()
        streamedBytes += value.byteLength
        streamedChunks += 1
        controller.enqueue(value)
        const chunkText = decoder.decode(value, { stream: true })
        textBuffer += chunkText

        eagerWindow = (eagerWindow + chunkText).slice(-8192)
        if (
          eagerWindow.includes('"completed"') &&
          EAGER_TOOL_RX.test(eagerWindow) &&
          Date.now() - lastEagerSyncAt > EAGER_SYNC_DEBOUNCE_MS
        ) {
          lastEagerSyncAt = Date.now()
          eagerWindow = ""
          logger.info("r2.sync.eager", { runId, sessionId, streamedChunks })
          sessionState.ctx.waitUntil(sessionState.syncToR2().catch(() => {}))
        }

        if (!sawDone && textBuffer.includes("event: done")) {
          sawDone = true
          logger.info("stream.doneEvent", {
            runId,
            sessionId,
            streamedBytes,
            streamedChunks,
            ms: Date.now() - tStreamStart,
          })
          sessionState.ctx.waitUntil(sessionState.finalizeRun(opencodeSessionForSync).catch(() => {}))
        }
      },
      cancel(reason) {
        // Client disconnected (browser tab closed, user hit stop, network
        // dropped — e.g. the QUIC failures we've seen). This is the smoking
        // gun that distinguishes "downstream gave up" from "container died":
        // stream.cancel here = client-side abort; stream.pull.error = upstream.
        logger.warn("stream.cancel", {
          runId,
          sessionId,
          reason: reason ? String(reason) : "unknown",
          streamedBytes,
          streamedChunks,
          sawDone,
          ms: Date.now() - tStreamStart,
        })
        reader.cancel(reason).catch(() => {})
        // Still persist whatever opencode produced so the next prompt has
        // prior-conversation context. Without this hook, pull() never sees
        // the upstream finish and the transcript is lost.
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
    if (!got) {
      logger.info("state.push.none", { runId, sessionId: this.sessionId })
      return false
    }
    let bundle: unknown
    try {
      bundle = await got.json()
    } catch (error) {
      logger.warn("state.bundle.invalid", { runId, sessionId: this.sessionId, error: String(error) })
      return false
    }
    const sizes = bundle as { db?: string; wal?: string; shm?: string }
    logger.info("state.push.start", {
      runId,
      sessionId: this.sessionId,
      db: sizes.db?.length ?? 0,
      wal: sizes.wal?.length ?? 0,
      shm: sizes.shm?.length ?? 0,
    })
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
    if (!opencodeSessionId) {
      logger.warn("transcript.save.skipped", { sessionId: this.sessionId, reason: "no opencodeSessionId" })
      return
    }
    const res = await this.containerFetch(
      new Request(`http://container/transcript/${opencodeSessionId}`, {
        method: "GET",
        headers: this.sidecarHeaders,
      }),
      8080,
    )
    if (!res.ok) {
      logger.warn("transcript.save.fetchFailed", {
        sessionId: this.sessionId,
        opencodeSessionId,
        status: res.status,
      })
      return
    }
    const turns = (await res.json()) as Turn[]
    if (!Array.isArray(turns) || turns.length === 0) {
      logger.warn("transcript.save.empty", { sessionId: this.sessionId, opencodeSessionId })
      return
    }
    await this.env.FILES.put(historyKeyFor(this.sessionId), JSON.stringify(turns), {
      httpMetadata: { contentType: "application/json" },
    })
    logger.info("transcript.saved", { sessionId: this.sessionId, opencodeSessionId, turns: turns.length })
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
    const t0 = Date.now()
    const prefix = r2PrefixFor(this.sessionId)
    const listRes = await this.containerFetch(
      new Request("http://container/list", {
        method: "GET",
        headers: this.sidecarHeaders,
      }),
      8080,
    )
    if (!listRes.ok) {
      logger.warn("r2.sync.out.listFailed", { sessionId: this.sessionId, status: listRes.status })
      return
    }
    const { files } = (await listRes.json()) as { files: string[] }

    let uploaded = 0
    let uploadedBytes = 0
    let fetchFailed = 0
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
        if (!fileRes.ok || !fileRes.body) {
          fetchFailed += 1
          return
        }
        const key = `${prefix}${rel}`
        seen.add(key)
        const body = await fileRes.arrayBuffer()
        // Forward the container's Content-Type (Bun.file infers from extension)
        // so SVGs, HTML, CSS, JS, images etc. are served with the right MIME
        // when fetched from R2 via a public URL. Without this, browsers render
        // SVGs as text and treat HTML as application/octet-stream.
        const contentType = fileRes.headers.get("content-type") ?? "application/octet-stream"
        await this.env.FILES.put(key, body, {
          httpMetadata: { contentType: contentType.split(";")[0].trim() },
        })
        uploaded += 1
        uploadedBytes += body.byteLength
      }),
    )

    let staleDeleted = 0
    let cursor: string | undefined
    do {
      const list = await this.env.FILES.list({ prefix, cursor })
      cursor = list.truncated ? list.cursor : undefined
      const stale = list.objects.map((o) => o.key).filter((k) => !seen.has(k))
      if (stale.length) {
        await this.env.FILES.delete(stale)
        staleDeleted += stale.length
      }
    } while (cursor)

    logger.info("r2.sync.out", {
      sessionId: this.sessionId,
      listed: files.length,
      uploaded,
      uploadedBytes,
      fetchFailed,
      staleDeleted,
      ms: Date.now() - t0,
    })
  }

  private async teardown(): Promise<Response> {
    const t0 = Date.now()
    logger.info("teardown.start", { sessionId: this.sessionId })
    try {
      await this.stop()
    } catch (e) {
      logger.warn("teardown.stopFailed", { sessionId: this.sessionId, error: String(e) })
    }
    await this.ctx.storage.delete("opencodeSessionId")
    await this.ctx.storage.delete("byokAiGatewayKey")
    await this.env.FILES.delete(historyKeyFor(this.sessionId)).catch(() => {})
    await this.env.FILES.delete(stateKeyFor(this.sessionId)).catch(() => {})
    const prefix = r2PrefixFor(this.sessionId)
    let deleted = 0
    let cursor: string | undefined
    do {
      const list = await this.env.FILES.list({ prefix, cursor })
      cursor = list.truncated ? list.cursor : undefined
      if (list.objects.length) {
        await this.env.FILES.delete(list.objects.map((o) => o.key))
        deleted += list.objects.length
      }
    } while (cursor)
    logger.info("teardown.done", { sessionId: this.sessionId, filesDeleted: deleted, ms: Date.now() - t0 })
    return Response.json({ ok: true })
  }
}
