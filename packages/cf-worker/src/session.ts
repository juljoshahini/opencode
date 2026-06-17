import { Container } from "@cloudflare/containers"
import { type Env, PROVIDER_VARS, historyKeyFor, r2PrefixFor, stateKeyFor, draftPrefixFor, draftKeyFor } from "./env"
import { logger } from "./log"

type Turn = { role: "user" | "assistant"; text: string; time?: number }

// Append/replace a `?v=<ver>` cache-buster on every reference to a specific
// asset base inside an HTML string. The draft is served from a CDN that caches
// by URL, so an edited style.css/img would otherwise stay stale at its
// unchanged URL; bumping `?v=` each turn changes the URL -> guaranteed fresh.
// Matches the base + path in href/src/srcset and inline url(...), and drops any
// existing query so re-stamping every turn replaces rather than stacks.
function stampAssetVersions(html: string, assetBase: string, ver: string): string {
  const esc = assetBase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const re = new RegExp(`(${esc}[^"'?\\s)>]+)(\\?[^"'\\s)>]*)?`, "g")
  return html.replace(re, (_m, path) => `${path}?v=${ver}`)
}

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

    // Tell the container where its workspace lives in the draft bucket so
    // image_generate can form public URLs (R2_PUBLIC_BASE + this prefix) and
    // reference images relatively in HTML. Set before the container starts.
    this.envVars.WORKER_DRAFT_PREFIX = this.draftPrefix()

    // The exact per-variant preview URL, so the agent can url_screenshot the
    // rendered draft without guessing the id format. The session id IS the
    // variant's encryptedId (the backend sends it that way).
    const previewBase = (this.env.LANDERLAB_PREVIEW_BASE ?? "https://preview.landerlabpages.com").replace(/\/+$/, "")
    this.envVars.WORKER_PREVIEW_URL = `${previewBase}/variants/${this.sessionId}`

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
        // The agent run usually SURVIVES a downstream disconnect — opencode's
        // prompt loop is fire-and-forget inside the container. Snapshotting
        // immediately here would capture mid-turn state and lose the turn
        // (June 11 incident: turn completed 40s after the disconnect, but the
        // only snapshot predated it). finalizeOrphanedRun keeps the container
        // alive, polls until the run ends, then takes the real final snapshot.
        if (!sawDone && opencodeSessionForSync) {
          sawDone = true
          sessionState.ctx.waitUntil(sessionState.finalizeOrphanedRun(runId, opencodeSessionForSync).catch(() => {}))
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
        // Correlation key: this same runId appears in DO logs (run.start,
        // stream.*, orphan.*) and container logs (prompt.start, prompt.done).
        // The backend surfaces it in failure diagnostics so one grep finds
        // the whole story across all three systems.
        "x-run-id": runId,
      },
    })
  }

  // Called when the downstream client disconnected mid-turn. The container's
  // agent run keeps going on its own, so: take an immediate partial snapshot
  // (in case the container dies), then keep the container alive and poll the
  // sidecar until the run actually completes, then snapshot again — that
  // final snapshot is the one that contains the full turn.
  private async finalizeOrphanedRun(runId: string, opencodeSessionId: string | null): Promise<void> {
    const t0 = Date.now()
    const MAX_WAIT_MS = 5 * 60_000
    const POLL_MS = 10_000

    await this.finalizeRun(opencodeSessionId).catch(() => {})

    while (Date.now() - t0 < MAX_WAIT_MS) {
      this.renewActivityTimeout()
      await new Promise((resolve) => setTimeout(resolve, POLL_MS))
      let active = false
      try {
        const res = await this.containerFetch(
          new Request("http://container/__run/active", {
            method: "GET",
            headers: this.sidecarHeaders,
          }),
          8080,
        )
        if (!res.ok) {
          logger.warn("orphan.poll.failed", { runId, sessionId: this.sessionId, status: res.status })
          break
        }
        const body = (await res.json()) as { active?: boolean; runMs?: number | null }
        active = Boolean(body.active)
      } catch (e) {
        logger.warn("orphan.poll.threw", { runId, sessionId: this.sessionId, error: String(e) })
        break
      }
      if (!active) {
        logger.info("orphan.runCompleted", {
          runId,
          sessionId: this.sessionId,
          opencodeSessionId,
          waitedMs: Date.now() - t0,
        })
        await this.finalizeRun(opencodeSessionId).catch(() => {})
        return
      }
    }

    logger.warn("orphan.finalize.gaveUp", {
      runId,
      sessionId: this.sessionId,
      opencodeSessionId,
      waitedMs: Date.now() - t0,
    })
    // Last-resort snapshot — better partial than nothing.
    await this.finalizeRun(opencodeSessionId).catch(() => {})
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

  // The session id IS the variant's encryptedId (the backend sends it that
  // way), so it's the draft folder name directly — no derivation needed.
  private draftPrefix(): string {
    return draftPrefixFor(this.sessionId)
  }

  // Pull the variant's CURRENT draft (landerlab-prod/variants/unpublished/<encId>/)
  // into the container so the agent edits the live draft, not a stale copy.
  private async syncFromR2(): Promise<number> {
    const prefix = this.draftPrefix()
    let cursor: string | undefined
    let count = 0
    do {
      const list = await this.env.PROD.list({ prefix, cursor })
      cursor = list.truncated ? list.cursor : undefined
      await Promise.all(
        list.objects.map(async (obj) => {
          const rel = obj.key.slice(prefix.length)
          // Skip the directory marker and any internal/dot paths.
          if (!rel || rel.startsWith(".")) return
          const got = await this.env.PROD.get(obj.key)
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

  // Push the agent workspace OUT to the variant draft
  // (landerlab-prod/variants/unpublished/<encId>/). Excludes internal/dot
  // paths (e.g. .screenshots) so agent scratch never reaches the draft (and
  // thus never gets Published onto the live page).
  private async syncToR2(): Promise<void> {
    const t0 = Date.now()
    const prefix = this.draftPrefix()
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
    const allFiles = (await listRes.json()) as { files: string[] }
    // Deliverables only — never sync dot-paths into the published-able draft.
    const files = allFiles.files.filter((rel) => rel && !rel.split("/").some((seg) => seg.startsWith(".")))

    // SAFETY GUARD: an empty workspace almost always means the sidecar/list
    // failed or the container booted blank — NOT that the user wants their
    // draft emptied. Never let that prune the real draft.
    if (files.length === 0) {
      logger.warn("r2.sync.out.emptyWorkspace.skipPrune", { sessionId: this.sessionId, listed: allFiles.files.length })
      return
    }

    // One cache-buster per sync, stamped onto this variant's draft asset refs
    // inside HTML (see stampAssetVersions). assetBase = the public CDN URL for
    // this draft, e.g. https://static.ll-assets.com/variants/unpublished/<id>/.
    const cacheBust = crypto.randomUUID().slice(0, 8)
    const publicBase = (this.env.R2_PUBLIC_BASE ?? "").replace(/\/+$/, "")
    const assetBase = publicBase ? `${publicBase}/${prefix}` : null

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
        // Defense-in-depth: route the key through the same guard as the file
        // routes. `rel` comes from the container list and is already proven
        // safe, but this makes the per-session prefix an enforced invariant.
        const key = draftKeyFor(this.sessionId, rel)
        if (key === null) {
          logger.warn("r2.sync.out.unsafePath.skip", { sessionId: this.sessionId, rel })
          return
        }
        seen.add(key)
        const body = await fileRes.arrayBuffer()
        // Forward the container's Content-Type (Bun.file infers from extension)
        // so SVGs, HTML, CSS, JS, images etc. are served with the right MIME
        // when fetched from R2 via a public URL. Without this, browsers render
        // SVGs as text and treat HTML as application/octet-stream.
        const mime = (fileRes.headers.get("content-type") ?? "application/octet-stream").split(";")[0].trim()
        // For HTML, stamp a fresh ?v= onto draft asset refs so an edited
        // style.css/image can't be served stale from the CDN's URL cache.
        const isHtml = mime === "text/html" || rel.toLowerCase().endsWith(".html")
        const putBody: ArrayBuffer | string =
          isHtml && assetBase ? stampAssetVersions(new TextDecoder().decode(body), assetBase, cacheBust) : body
        await this.env.PROD.put(key, putBody, {
          httpMetadata: { contentType: mime },
        })
        uploaded += 1
        uploadedBytes += body.byteLength
      }),
    )

    // Don't prune if more than half the fetches failed — a flaky sidecar
    // shouldn't delete draft files it simply couldn't read this pass.
    let staleDeleted = 0
    if (fetchFailed > files.length / 2) {
      logger.warn("r2.sync.out.tooManyFetchFails.skipPrune", {
        sessionId: this.sessionId,
        files: files.length,
        fetchFailed,
      })
    } else {
      let cursor: string | undefined
      do {
        const list = await this.env.PROD.list({ prefix, cursor })
        cursor = list.truncated ? list.cursor : undefined
        // Only prune deliverables we own; never touch dot-path objects.
        const stale = list.objects
          .map((o) => o.key)
          .filter((k) => !seen.has(k) && !k.slice(prefix.length).split("/").some((seg) => seg.startsWith(".")))
        if (stale.length) {
          await this.env.PROD.delete(stale)
          staleDeleted += stale.length
        }
      } while (cursor)
    }

    logger.info("r2.sync.out", {
      sessionId: this.sessionId,
      prefix,
      listed: allFiles.files.length,
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
    // IMPORTANT: teardown only clears agent INTERNALS on openlanderlab (FILES).
    // It must NEVER touch this.env.PROD — that's the user's variant draft in
    // landerlab-prod, not session-scoped junk.
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
