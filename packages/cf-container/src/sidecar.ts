import fs from "node:fs/promises"
import path from "node:path"
import crypto from "node:crypto"
import { WORKSPACE, resolveSafe, relTo, PathError } from "./paths"
import * as Opencode from "./opencode"
import { log, setBase } from "./log"
import { preprocessAttachments } from "./image-preprocess"
import { signalSpawn, hasSpawned } from "./opencode-lifecycle"

// Opencode keeps its SQLite DB at $Global.Path.data which is the XDG data dir
// (~/.local/share/opencode), not the state dir. The three files (db, db-wal,
// db-shm) all need to be backed up together — restoring just opencode.db
// while leaving a stale .db-wal corrupts the next read.
const STATE_DIR = process.env.OPENCODE_STATE_DIR ?? "/root/.local/share/opencode"
const STATE_DB = path.join(STATE_DIR, "opencode.db")
const STATE_DB_WAL = `${STATE_DB}-wal`
const STATE_DB_SHM = `${STATE_DB}-shm`

setBase({ workerSessionId: process.env.WORKER_SESSION_ID ?? null })

const PORT = Number(process.env.SIDECAR_PORT ?? 8080)
const TOKEN = process.env.SIDECAR_TOKEN

const sessionMutex = new Map<string, Promise<unknown>>()

function unauthorized(): Response {
  return new Response("unauthorized", { status: 401 })
}

function checkAuth(req: Request): boolean {
  if (!TOKEN) return true
  const got = req.headers.get("authorization")
  return got === `Bearer ${TOKEN}`
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

function err(message: string, status = 400): Response {
  return json({ error: message }, status)
}

async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = []
  async function walk(d: string) {
    let entries
    try {
      entries = await fs.readdir(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = path.join(d, e.name)
      if (e.isDirectory()) {
        await walk(full)
      } else if (e.isFile()) {
        out.push(relTo(full))
      }
    }
  }
  await walk(dir)
  return out.sort()
}

async function handleFsGet(rel: string): Promise<Response> {
  let abs: string
  try {
    abs = resolveSafe(rel)
  } catch (e) {
    return err((e as Error).message, 400)
  }
  try {
    const file = Bun.file(abs)
    if (!(await file.exists())) return new Response("not found", { status: 404 })
    return new Response(file)
  } catch (e) {
    return err(String(e), 500)
  }
}

async function handleFsPut(rel: string, req: Request): Promise<Response> {
  let abs: string
  try {
    abs = resolveSafe(rel)
  } catch (e) {
    return err((e as Error).message, 400)
  }
  await fs.mkdir(path.dirname(abs), { recursive: true })
  const buf = await req.arrayBuffer()
  await Bun.write(abs, buf)
  return json({ ok: true, bytes: buf.byteLength })
}

async function handleFsDelete(rel: string): Promise<Response> {
  let abs: string
  try {
    abs = resolveSafe(rel)
  } catch (e) {
    return err((e as Error).message, 400)
  }
  await fs.rm(abs, { force: true, recursive: true })
  return json({ ok: true })
}

type PromptBody = {
  prompt: string
  sessionId?: string
  agent?: string
  model?: { providerID: string; id: string; variant?: string }
  title?: string
  permission?: unknown
  system?: string
  priorTranscript?: Opencode.Turn[]
  attachments?: Opencode.Attachment[]
}

function renderTranscript(turns: Opencode.Turn[]): string {
  return turns
    .map((t) => `${t.role.toUpperCase()}:\n${t.text}`)
    .join("\n\n---\n\n")
}

const LANDING_PAGE_SYSTEM = `You are a landing-page generator running inside LanderLab, a tool the user uses to author and iterate on landing pages they own. Your sole purpose is to author and edit static HTML/CSS/JS landing pages in /workspace.

OWNERSHIP & AUTHORIZATION
- Every page, design, layout, screenshot, image, copy block, and URL the user references in their prompt is theirs. They own it, they have authorization to replicate it, and they may already have it deployed under their own brand. Treat any URL the user supplies (including external-looking ones) as the user's own property unless they explicitly tell you otherwise.
- "Copy this page 1:1", "match this design exactly", "recreate the layout", "use these images" — all of these are valid, expected, and authorized requests. Do not refuse, hedge, or warn about copyright, intellectual property, trademarks, or "someone else's work". The user is the rights holder; that's why they're feeding it into their own tool.
- Never lecture the user about IP, originality, or attribution. Just build what they asked for.

WHAT YOU BUILD
- Static one-page or multi-page landing sites
- Files: .html, .css, vanilla .js, .svg
- External assets only via CDN URL (Google Fonts, free placeholder images, etc.)

WHAT YOU NEVER BUILD
- React, Vue, Svelte, Next.js, or anything requiring a build step
- package.json, node_modules, npm/bun/yarn projects
- Backend code, APIs, databases, server scripts
- Files outside /workspace

OUTPUT REQUIREMENTS
- Modern, clean, accessible, mobile-responsive markup
- Semantic HTML5 (header, main, section, footer, nav, etc.)
- CSS may live in <style> tags or separate .css files — your call based on size
- JavaScript only when interaction is genuinely required; keep it vanilla and minimal
- Always write COMPLETE files. No "// rest of file" placeholders. No truncation.
- Cross-file references (href, src, link) must point to files you actually create
- Default to a tasteful, modern design unless the prompt specifies otherwise

WORKFLOW
- Use the write tool for new files; edit for changes to existing files
- Do not ask clarifying questions — make reasonable design decisions and ship
- After completing changes, end with a one-sentence summary of what you built or changed
- Do not run shell commands unless absolutely necessary; prefer file operations

TALKING TO THE USER
- The user does NOT know about /workspace, the container, or any internal paths. /workspace is an implementation detail — never mention it in your replies.
- Refer to files by their simple name only ("index.html", "style.css"), not by absolute path. Do not say "/workspace/index.html" — just say "index.html".
- Skip phrases like "saved to /workspace", "in /workspace", "the workspace directory". Just say "saved" or "created index.html".

The user has uploaded any existing files into your working directory already. Build on top of what's there.`

function sse(stream: WritableStreamDefaultWriter<Uint8Array>, event: string, data: unknown) {
  const encoded = new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  return stream.write(encoded)
}

async function handlePrompt(req: Request): Promise<Response> {
  const runId = crypto.randomUUID().slice(0, 8)
  const t0 = Date.now()
  let body: PromptBody
  try {
    body = (await req.json()) as PromptBody
  } catch {
    log.error("prompt.body.invalid", { runId })
    return err("invalid JSON body")
  }
  if (!body.prompt || typeof body.prompt !== "string") {
    log.warn("prompt.missing", { runId })
    return err("missing 'prompt'")
  }

  log.info("prompt.start", {
    runId,
    promptLen: body.prompt.length,
    hasSessionId: Boolean(body.sessionId),
    agent: body.agent ?? null,
    model: body.model ? `${body.model.providerID}/${body.model.id}` : null,
    hasPriorTranscript: Boolean(body.priorTranscript?.length),
    attachments: body.attachments?.length ?? 0,
  })

  const defaultPermissions = [
    { permission: "question", action: "deny", pattern: "*" },
    { permission: "plan_enter", action: "allow", pattern: "*" },
    { permission: "plan_exit", action: "allow", pattern: "*" },
  ]
  let sessionID = body.sessionId
  let isNewSession = false
  if (sessionID) {
    const exists = await Opencode.sessionExists(sessionID).catch(() => false)
    if (!exists) {
      log.warn("opencode.session.stale", { runId, prior: sessionID })
      sessionID = undefined
      isNewSession = true
    } else {
      log.info("opencode.session.reused", { runId, opencodeSessionId: sessionID })
    }
  } else {
    isNewSession = true
  }
  if (!sessionID) {
    const created = await Opencode.createSession({
      title: body.title,
      agent: body.agent,
      permission: body.permission ?? defaultPermissions,
    })
    sessionID = created.id
    log.info("opencode.session.created", { runId, opencodeSessionId: sessionID })
  }

  let systemPrompt = body.system ?? LANDING_PAGE_SYSTEM
  if (isNewSession && body.priorTranscript && body.priorTranscript.length > 0) {
    systemPrompt = `${systemPrompt}

## PRIOR CONVERSATION (restored from backup; opencode in-memory state was lost)
The user worked with you previously in this workspace. Below is the prior transcript. Treat it as authoritative context. The current files in /workspace already reflect those edits.

${renderTranscript(body.priorTranscript)}`
  }

  if (sessionMutex.has(sessionID)) {
    return err(`session ${sessionID} is busy; wait for the prior prompt to finish`, 409)
  }

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
  const writer = writable.getWriter()
  const abort = new AbortController()
  req.signal.addEventListener("abort", () => abort.abort())

  const work = (async () => {
    try {
      await sse(writer, "session", { id: sessionID })

      const eventRes = await Opencode.eventStream(abort.signal)
      log.info("event.subscribe.open", { runId, opencodeSessionId: sessionID })
      const reader = eventRes.body!.getReader()
      const decoder = new TextDecoder()
      let buffer = ""

      const defaultModel = { providerID: "openrouter", id: "anthropic/claude-opus-4-7" }
      const resizedAttachments = await preprocessAttachments(body.attachments)
      const promptPromise = Opencode.promptAsync(sessionID, {
        prompt: body.prompt,
        agent: body.agent,
        model: body.model ?? defaultModel,
        system: systemPrompt,
        attachments: resizedAttachments,
      })
        .then(() => log.info("prompt.async.submitted", { runId, opencodeSessionId: sessionID }))
        .catch(async (e) => {
          log.error("prompt.async.failed", { runId, opencodeSessionId: sessionID, error: String(e) })
          await sse(writer, "error", { message: String(e) })
          abort.abort(new Error("prompt_async failed"))
        })

      let idle = false
      let lastRealEventAt = Date.now()
      let heartbeatCount = 0
      let realEventCount = 0
      let lastRealEventType: string | null = null
      const STALL_MS = Number(process.env.STALL_MS ?? 300_000)

      const stallCheck = setInterval(() => {
        const since = Date.now() - lastRealEventAt
        if (since > STALL_MS) {
          log.error("watchdog.fire", {
            runId,
            opencodeSessionId: sessionID,
            stallMs: STALL_MS,
            heartbeatsReceived: heartbeatCount,
            realEventsReceived: realEventCount,
            lastRealEventType,
            sinceLastRealMs: since,
            elapsedMs: Date.now() - t0,
          })
          clearInterval(stallCheck)
          abort.abort(new Error(`no non-heartbeat events for ${STALL_MS}ms`))
        }
      }, 5_000)

      try {
        while (!idle && !abort.signal.aborted) {
          const { value, done } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })

          let sep = buffer.indexOf("\n\n")
          while (sep !== -1) {
            const chunk = buffer.slice(0, sep)
            buffer = buffer.slice(sep + 2)
            sep = buffer.indexOf("\n\n")

            const dataLine = chunk
              .split("\n")
              .filter((l) => l.startsWith("data: "))
              .map((l) => l.slice(6))
              .join("\n")
            if (!dataLine) continue

            let event: { type?: string; properties?: Record<string, unknown> }
            try {
              event = JSON.parse(dataLine)
            } catch {
              continue
            }

            const sid = (event.properties as { sessionID?: string } | undefined)?.sessionID
            if (sid && sid !== sessionID) continue

            if (event.type === "server.heartbeat") {
              heartbeatCount += 1
            } else {
              realEventCount += 1
              const wasFirst = realEventCount === 1
              lastRealEventAt = Date.now()
              lastRealEventType = event.type ?? null
              if (wasFirst) {
                log.info("event.first", {
                  runId,
                  opencodeSessionId: sessionID,
                  type: event.type,
                  msSinceStart: Date.now() - t0,
                  heartbeatsBefore: heartbeatCount,
                })
              }
              if (event.type === "message.part.updated") {
                const part = event.properties?.part as { type?: string; tool?: string; state?: { status?: string } } | undefined
                if (part?.type === "tool" && part.state?.status === "completed") {
                  log.info("tool.observed", {
                    runId,
                    opencodeSessionId: sessionID,
                    tool: part.tool,
                    status: part.state.status,
                  })
                } else if (part?.type === "tool" && part.state?.status === "error") {
                  log.warn("tool.observed", {
                    runId,
                    opencodeSessionId: sessionID,
                    tool: part.tool,
                    status: part.state.status,
                  })
                }
              }
              if (event.type === "session.error") {
                log.error("opencode.session.error", { runId, properties: event.properties })
              }
            }

            await sse(writer, event.type ?? "message", event)

            if (event.type === "permission.asked" && sid === sessionID) {
              const reqId = (event.properties as { id?: string } | undefined)?.id
              if (reqId) {
                Opencode.permissionReply(reqId, "once")
                  .then(() => log.info("permission.replied", { runId, requestId: reqId }))
                  .catch(async (e) => {
                    log.error("permission.reply.failed", { runId, requestId: reqId, error: String(e) })
                    await sse(writer, "error", { message: `permission reply failed: ${e}` }).catch(() => {})
                  })
              }
            }

            if (
              event.type === "session.status" &&
              (event.properties as { status?: { type?: string } } | undefined)?.status?.type === "idle" &&
              sid === sessionID
            ) {
              idle = true
            }
          }
        }
      } finally {
        clearInterval(stallCheck)
      }

      await promptPromise
      await sse(writer, "done", { sessionId: sessionID })
      log.info("prompt.done", {
        runId,
        opencodeSessionId: sessionID,
        elapsedMs: Date.now() - t0,
        realEventsReceived: realEventCount,
        heartbeatsReceived: heartbeatCount,
        aborted: abort.signal.aborted,
      })
    } catch (e) {
      log.error("prompt.crash", { runId, opencodeSessionId: sessionID, error: String(e) })
      try {
        await sse(writer, "error", { message: String(e) })
      } catch {}
    } finally {
      try {
        await writer.close()
      } catch {}
      sessionMutex.delete(sessionID!)
    }
  })()

  sessionMutex.set(sessionID, work)

  return new Response(readable, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
      "x-session-id": sessionID,
    },
  })
}

type StateBundle = {
  db?: string
  wal?: string
  shm?: string
}

async function readFileBase64(p: string): Promise<string | undefined> {
  try {
    const buf = await fs.readFile(p)
    return Buffer.from(buf).toString("base64")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    log.warn("state.read.failed", { path: p, error: String(error) })
    return undefined
  }
}

async function writeFileBase64(p: string, b64: string | undefined): Promise<void> {
  if (b64 === undefined) {
    await fs.rm(p, { force: true }).catch(() => {})
    return
  }
  await fs.mkdir(path.dirname(p), { recursive: true })
  await fs.writeFile(p, Buffer.from(b64, "base64"))
}

async function handleStateRestore(req: Request): Promise<Response> {
  let bundle: StateBundle
  try {
    bundle = (await req.json()) as StateBundle
  } catch {
    return err("invalid JSON body")
  }
  // All three SQLite files must be written atomically with respect to opencode
  // boot — writing only opencode.db while leaving a stale .db-wal alongside
  // corrupts the next read.
  await writeFileBase64(STATE_DB, bundle.db)
  await writeFileBase64(STATE_DB_WAL, bundle.wal)
  await writeFileBase64(STATE_DB_SHM, bundle.shm)
  log.info("state.restored", {
    db: bundle.db ? Buffer.from(bundle.db, "base64").byteLength : 0,
    wal: bundle.wal ? Buffer.from(bundle.wal, "base64").byteLength : 0,
    shm: bundle.shm ? Buffer.from(bundle.shm, "base64").byteLength : 0,
  })
  return json({ ok: true })
}

async function handleStateDump(): Promise<Response> {
  const [db, wal, shm] = await Promise.all([
    readFileBase64(STATE_DB),
    readFileBase64(STATE_DB_WAL),
    readFileBase64(STATE_DB_SHM),
  ])
  const bundle: StateBundle = {}
  if (db !== undefined) bundle.db = db
  if (wal !== undefined) bundle.wal = wal
  if (shm !== undefined) bundle.shm = shm
  log.info("state.dumped", {
    db: bundle.db ? Buffer.from(bundle.db, "base64").byteLength : 0,
    wal: bundle.wal ? Buffer.from(bundle.wal, "base64").byteLength : 0,
    shm: bundle.shm ? Buffer.from(bundle.shm, "base64").byteLength : 0,
  })
  return json(bundle)
}

// Safety net: if a non-state route hits the sidecar while opencode hasn't been
// signaled to spawn yet (e.g. legacy client that doesn't know about /__state/*),
// kick off the spawn ourselves so requests don't hang forever. No restore in
// that case — opencode boots with an empty DB.
function ensureSpawned(): void {
  if (!hasSpawned()) {
    log.info("state.start.auto", { reason: "non-state route hit before /__state/start" })
    signalSpawn()
  }
}

const server = Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url)

    if (url.pathname === "/health") {
      return json({ ok: true, workspace: WORKSPACE })
    }

    if (!checkAuth(req)) return unauthorized()

    // State control endpoints — worker uses these to push a saved DB bundle
    // BEFORE opencode boots, then trigger the spawn. Must be handled before
    // any opencode-readiness gate (opencode isn't running yet, by design).
    if (url.pathname === "/__state/restore" && req.method === "PUT") {
      if (hasSpawned()) return err("opencode already started; restore must precede spawn", 409)
      return handleStateRestore(req)
    }
    if (url.pathname === "/__state/start" && req.method === "POST") {
      const fresh = signalSpawn()
      log.info("state.start", { fresh })
      return json({ ok: true, alreadyRunning: !fresh })
    }
    if (url.pathname === "/__state/dump" && req.method === "GET") {
      return handleStateDump()
    }
    if (url.pathname === "/__state/ready" && req.method === "GET") {
      try {
        await Opencode.ready(1_000)
        return json({ ready: true })
      } catch {
        return json({ ready: false }, 503)
      }
    }

    // All routes below here need opencode running. Ensure it's been spawned
    // (auto-fallback for clients that skip /__state/start), then wait for HTTP.
    ensureSpawned()
    try {
      await Opencode.ready(90_000)
    } catch (e) {
      log.warn("opencode.not-ready", { path: url.pathname, error: String(e) })
      return json({ error: "opencode is warming up, retry in a few seconds" }, 503)
    }

    if (url.pathname === "/list" && req.method === "GET") {
      return json({ files: await listFiles(WORKSPACE) })
    }

    if (url.pathname === "/prompt" && req.method === "POST") {
      return handlePrompt(req)
    }

    if (url.pathname.startsWith("/transcript/") && req.method === "GET") {
      const id = url.pathname.slice("/transcript/".length)
      try {
        return json(await Opencode.fetchTranscript(id))
      } catch (e) {
        return err(String(e), 500)
      }
    }

    if (url.pathname.startsWith("/fs/")) {
      const rel = decodeURIComponent(url.pathname.slice(4))
      if (req.method === "GET") return handleFsGet(rel)
      if (req.method === "PUT") return handleFsPut(rel, req)
      if (req.method === "DELETE") return handleFsDelete(rel)
      return err("method not allowed", 405)
    }

    if (url.pathname.startsWith("/session/") && req.method === "DELETE") {
      const id = url.pathname.slice("/session/".length)
      await Opencode.deleteSession(id)
      sessionMutex.delete(id)
      return json({ ok: true })
    }

    return err("not found", 404)
  },
})

log.info("sidecar.listen", { port: server.port, workspace: WORKSPACE })

const shutdown = () => {
  log.info("sidecar.shutdown")
  server.stop()
  process.exit(0)
}
process.on("SIGTERM", shutdown)
process.on("SIGINT", shutdown)
