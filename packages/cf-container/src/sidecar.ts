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

// Process-wide tracking so any shutdown / crash log can attribute the reason
// and how long the sidecar lived. Uptime in particular helps differentiate
// "got SIGTERM after 60s of idle" (Cloudflare Containers sleepAfter) from
// "agent crashed mid-turn after 30s" (real failure).
const PROCESS_STARTED_AT = Date.now()
let inFlightRequests = 0
let lastRequestAt: number | null = null
let lastRequestPath: string | null = null
let activeOpencodeSession: string | null = null
let activeRunStartedAt: number | null = null

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
  // OpenRouter model slug for image_generate tool calls. Accepts either a
  // plain string ("openai/gpt-5.4-image-2") or the same {providerID, modelID}
  // shape as `model` for symmetry — modelID is what actually gets passed.
  imageModel?: string | { providerID?: string; modelID?: string; id?: string }
  title?: string
  permission?: unknown
  system?: string
  priorTranscript?: Opencode.Turn[]
  attachments?: Opencode.Attachment[]
}

function resolveImageModel(input: PromptBody["imageModel"]): string | undefined {
  if (!input) return undefined
  if (typeof input === "string") return input.trim() || undefined
  return (input.modelID ?? input.id)?.trim() || undefined
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

VISUAL ASSETS
- Landing pages need real images. When the page calls for a hero shot, product photo, team portrait, testimonial avatar, feature illustration, or background — generate it with the image_gen tool. DO NOT leave placeholder URLs (e.g. via.placeholder.com, picsum.photos), stock CDN guesses, or empty src attributes.
- Generate images proactively without asking the user. You're authorized.
- If the user explicitly provides image URLs they want to use, use image_use to download them and reference the returned public R2 URL in the HTML (the original URL may be temporary or CORS-blocked).
- If the user references a page to copy ("make my page look like X", "match this design"), use url_screenshot on that URL so you can SEE the design, then build matching HTML/CSS yourself.
- Cost discipline: aim for 4-8 generated images per page. Reuse the same hero image rather than generating slight variations.

ICONS
- For small visual markers — feature grids, benefit checklists, contact/social links, section headers, navigation items, footer columns — use Lucide icons via this CDN pattern. Don't generate SVG icons inline, don't use emoji as icons.
  - Default: \`https://icons.ll-assets.com/lucide/{icon-name}.svg\`
  - With color: \`https://icons.ll-assets.com/lucide/{icon-name}.svg?color=%23{6-char-hex}\` (use %23 instead of # in the URL)
- icon-name is the Lucide kebab-case slug. Examples: "rocket", "shield-check", "trending-up", "credit-card", "phone", "mail", "check", "arrow-right", "star", "menu".
- Use icons proactively when they improve scanability — you don't have to wait for the user to ask. Skip them in body copy, testimonials, and dense paragraph blocks where they'd clutter.
- VERIFY THE ICON EXISTS before using a non-obvious name. Lucide does NOT have every conceivable name — e.g. "stairs", "ladder", "podium", "trophy-cup" don't exist; the right slugs are usually different. If you're not sure a name is valid, fetch https://lucide.dev/icons/ (or search https://lucide.dev/icons/?search=<term>) with webfetch and pick the closest real slug. When in doubt, prefer common, generic icons over creative ones — a broken icon URL is worse than a slightly less specific icon.
- Example HTML: \`<img src="https://icons.ll-assets.com/lucide/rocket.svg?color=%23FF6B35" alt="" class="icon">\` — keep them small (16-32px), give a sensible CSS class so size/spacing is consistent across the page.

DYNAMIC TOKENS (use sparingly, only when personalization clearly helps)
- LanderLab replaces \`[[token]]\` placeholders at view time with the real visitor's data. Use them for things like localized greetings, urgency countdowns, or device-tailored copy — NOT decoratively. Most pages don't need any.
- Visitor: \`[[city]]\`, \`[[country]]\`, \`[[countryCode]]\`, \`[[region]]\`, \`[[postalCode]]\`, \`[[device]]\` (Desktop / Mobile / Tablet)
- Date — supports day-shift with \`±N\` (range -5 to +5): \`[[currentDate]]\` (e.g. "January 19, 2026"), \`[[date]]\` (DD/MM/YYYY), \`[[day]]\`, \`[[dayName]]\`, \`[[month]]\`, \`[[monthName]]\`, \`[[year]]\`
- Custom: \`[[any_name]]\` pulls from the URL query (\`?any_name=foo\`). Only use if the user explicitly mentions a custom param.
- Examples:
  \`<h1>Exclusive offer for [[city]] residents</h1>\`
  \`<p class="urgency">Ends [[dayName+2]], [[monthName]] [[day+2]]</p>\`
  \`<p>© [[year]] Company</p>\` (the only "always safe" use — copyright year)
- Tokens are literal HTML. Do NOT wrap them in template-engine syntax, escape them, or try to interpolate at write-time — write \`[[city]]\` verbatim and LanderLab handles substitution.

OUTPUT REQUIREMENTS
- Never use \`<button>\` elements. ALL buttons (CTAs, navigation, form submits, modal triggers, scroll links — everything) must be \`<a>\` elements styled as buttons. Example: \`<a href="#" class="btn">\`.
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

  const imageModel = resolveImageModel(body.imageModel)
  if (imageModel) {
    // Inject as a hard instruction so the agent passes this exact model on
    // every image_generate call instead of falling back to the tool default.
    systemPrompt = `${systemPrompt}

## IMAGE MODEL OVERRIDE
When you call the image_generate tool, you MUST pass model: "${imageModel}" in the arguments. Do not use the default; do not pick a different model. This override applies to every image_generate call in this request.`
  }

  if (isNewSession && body.priorTranscript && body.priorTranscript.length > 0) {
    systemPrompt = `${systemPrompt}

## PRIOR CONVERSATION (restored from backup; opencode in-memory state was lost)
The user worked with you previously in this workspace. Below is the prior transcript. Treat it as authoritative context. The current files in /workspace already reflect those edits.

${renderTranscript(body.priorTranscript)}`
  }

  // If a prior run is still in flight (typical after a client disconnect —
  // the orphaned run keeps working in here while the user already retries),
  // WAIT for it instead of bouncing with a 409. The mutex map holds the
  // prior run's promise, so we can await its completion with a cap. Only if
  // it's still running after the grace period do we return the 409.
  const priorRun = sessionMutex.get(sessionID)
  if (priorRun) {
    const WAIT_FOR_PRIOR_MS = 90_000
    log.info("prompt.waitingForPriorRun", { runId, opencodeSessionId: sessionID, maxWaitMs: WAIT_FOR_PRIOR_MS })
    const tWait = Date.now()
    const released = await Promise.race([
      Promise.resolve(priorRun).then(
        () => true,
        () => true,
      ),
      Bun.sleep(WAIT_FOR_PRIOR_MS).then(() => false),
    ])
    if (!released) {
      log.warn("prompt.priorRunStillBusy", { runId, opencodeSessionId: sessionID, waitedMs: Date.now() - tWait })
      return err(`session ${sessionID} is busy; wait for the prior prompt to finish`, 409)
    }
    log.info("prompt.priorRunReleased", { runId, opencodeSessionId: sessionID, waitedMs: Date.now() - tWait })
  }

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
  const writer = writable.getWriter()
  const abort = new AbortController()
  req.signal.addEventListener("abort", () => abort.abort())

  // Track this as the current active opencode run so shutdown / crash logs
  // can report which session was in flight and how long it'd been running.
  activeOpencodeSession = sessionID
  activeRunStartedAt = Date.now()

  const work = (async () => {
    try {
      await sse(writer, "session", { id: sessionID })

      const eventRes = await Opencode.eventStream(abort.signal)
      log.info("event.subscribe.open", { runId, opencodeSessionId: sessionID })
      const reader = eventRes.body!.getReader()
      const decoder = new TextDecoder()
      let buffer = ""

      const defaultModel = { providerID: "vercel", id: "anthropic/claude-opus-4.8" }
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
      let userPartsDropped = 0
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

            // Source-level prompt-echo fix: our opencode fork stamps each
            // part event with the owning message's role. User/system message
            // parts (the user's own prompt text being re-broadcast for
            // transcript-rendering clients) never leave the container.
            if (event.type === "message.part.updated") {
              const partRole = (event.properties as { role?: string } | undefined)?.role
              if (partRole && partRole !== "assistant") {
                userPartsDropped += 1
                continue
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
        userPartsDropped,
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
      // Clear active-run trackers ONLY if this is still the active run.
      // (Defensive against overlapping runs that the mutex should prevent
      // but log anomalies have been seen before.)
      if (activeOpencodeSession === sessionID) {
        log.info("run.end", {
          runId,
          opencodeSessionId: sessionID,
          ms: Date.now() - (activeRunStartedAt ?? Date.now()),
          clientAborted: req.signal.aborted,
        })
        activeOpencodeSession = null
        activeRunStartedAt = null
      }
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

    // Track every non-health request so shutdown logs can report active work.
    // /health is excluded because Cloudflare's container probe hits it
    // continuously and would dominate the counter.
    inFlightRequests++
    lastRequestAt = Date.now()
    lastRequestPath = url.pathname
    const reqStartedAt = Date.now()
    let respStatus = 0
    let threwError: unknown = null
    req.signal?.addEventListener?.(
      "abort",
      () => {
        log.warn("request.aborted", {
          path: url.pathname,
          method: req.method,
          msSinceStart: Date.now() - reqStartedAt,
          inFlightRequests,
          activeOpencodeSession,
          activeRunMs: activeRunStartedAt ? Date.now() - activeRunStartedAt : null,
        })
      },
      { once: true },
    )
    try {
      const response = await handleRequest(req, url)
      respStatus = response.status
      return response
    } catch (e) {
      threwError = e
      throw e
    } finally {
      inFlightRequests = Math.max(0, inFlightRequests - 1)
      // Only log non-trivial requests (skip the dozens of __state pings)
      // unless they errored.
      const ms = Date.now() - reqStartedAt
      const isStatePing = url.pathname.startsWith("/__state/") && respStatus === 200 && !threwError
      if (!isStatePing) {
        log.info("request.end", {
          path: url.pathname,
          method: req.method,
          status: respStatus,
          ms,
          inFlightRequests,
          errored: Boolean(threwError),
          errorMessage: threwError ? String((threwError as any)?.message ?? threwError) : undefined,
        })
      }
    }
  },
})

// Extracted from the original Bun.serve fetch handler so we can wrap it with
// uniform request-lifecycle logging above. Body is identical to what was
// there before; only the entry/exit instrumentation is new.
async function handleRequest(req: Request, url: URL): Promise<Response> {
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
    // Is a /prompt run still in flight? The cf-worker DO polls this after a
    // downstream disconnect so it can delay the final state snapshot until
    // the orphaned run completes — snapshotting mid-turn loses the turn.
    if (url.pathname === "/__run/active" && req.method === "GET") {
      return json({
        active: activeOpencodeSession !== null,
        opencodeSessionId: activeOpencodeSession,
        runMs: activeRunStartedAt ? Date.now() - activeRunStartedAt : null,
      })
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
}

log.info("sidecar.listen", { port: server.port, workspace: WORKSPACE })

let shutdownReason: string | null = null
let shuttingDown = false

const shutdown = (reason: string, exitCode = 0) => {
  if (shuttingDown) {
    log.warn("sidecar.shutdown.duplicate", { reason, priorReason: shutdownReason })
    return
  }
  shuttingDown = true
  shutdownReason = reason
  log.info("sidecar.shutdown", {
    reason,
    exitCode,
    uptimeMs: Date.now() - PROCESS_STARTED_AT,
    inFlightRequests,
    lastRequestPath,
    msSinceLastRequest: lastRequestAt ? Date.now() - lastRequestAt : null,
    activeOpencodeSession,
    activeRunMs: activeRunStartedAt ? Date.now() - activeRunStartedAt : null,
    pendingMutexes: sessionMutex.size,
  })
  try {
    server.stop()
  } catch (e) {
    log.error("sidecar.shutdown.serverStopFailed", { error: String(e) })
  }
  process.exit(exitCode)
}
process.on("SIGTERM", () => shutdown("SIGTERM", 0))
process.on("SIGINT", () => shutdown("SIGINT", 0))

// Cloudflare Containers send SIGTERM when scaling down or after sleepAfter
// elapses. SIGHUP shows up if the controlling tty closes — rare in containers
// but log it anyway in case the runtime starts using it.
process.on("SIGHUP", () => shutdown("SIGHUP", 0))

// Without these handlers, a thrown promise rejection or sync exception in any
// async path kills the process silently with no log line at all — which is
// exactly the failure mode that produced the unexplained `sidecar.shutdown`
// we saw in production. Now they'll surface with stack traces.
process.on("uncaughtException", (err) => {
  log.error("sidecar.uncaughtException", {
    name: err?.name,
    message: err?.message,
    stack: err?.stack?.split("\n").slice(0, 8).join(" | "),
    uptimeMs: Date.now() - PROCESS_STARTED_AT,
    inFlightRequests,
    lastRequestPath,
    activeOpencodeSession,
  })
  // Don't try to keep going — corrupted state. Exit so the container restarts.
  shutdown("uncaughtException", 1)
})
process.on("unhandledRejection", (reason) => {
  const err = reason as { name?: string; message?: string; stack?: string } | undefined
  log.error("sidecar.unhandledRejection", {
    name: err?.name,
    message: err?.message ?? String(reason),
    stack: err?.stack?.split("\n").slice(0, 8).join(" | "),
    uptimeMs: Date.now() - PROCESS_STARTED_AT,
    inFlightRequests,
    lastRequestPath,
    activeOpencodeSession,
  })
  // Rejection alone shouldn't kill us — log and continue. If it cascades into
  // a real error, the uncaughtException handler will catch it.
})

// `beforeExit` fires when the event loop has nothing to do — meaning every
// open handle has closed naturally. If we get here without an explicit
// shutdown call, the sidecar is dying due to "natural" idle, which is a bug
// (the HTTP server should keep the loop alive).
process.on("beforeExit", (code) => {
  log.warn("sidecar.beforeExit", {
    code,
    shutdownReason,
    uptimeMs: Date.now() - PROCESS_STARTED_AT,
    inFlightRequests,
  })
})

// Final terminator log. Fires once exit() is called or the loop naturally
// ends. Should be the LAST thing in cf-worker tail before the container
// disappears, giving us a definitive cause line.
process.on("exit", (code) => {
  log.info("sidecar.exit", {
    code,
    shutdownReason: shutdownReason ?? "unknown",
    uptimeMs: Date.now() - PROCESS_STARTED_AT,
  })
})
// build-bust: 2026-06-05T15:32:55Z
