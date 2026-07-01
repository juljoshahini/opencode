import { WORKSPACE } from "./paths"

const BASE = process.env.OPENCODE_INTERNAL_URL ?? "http://127.0.0.1:4096"

function authHeader(): Record<string, string> {
  const password = process.env.OPENCODE_SERVER_PASSWORD
  if (!password) return {}
  const username = process.env.OPENCODE_SERVER_USERNAME ?? "opencode"
  const token = Buffer.from(`${username}:${password}`).toString("base64")
  return { Authorization: `Basic ${token}` }
}

function headers(extra?: Record<string, string>): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-opencode-directory": WORKSPACE,
    ...authHeader(),
    ...(extra ?? {}),
  }
}

export async function ready(timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/path`, { headers: headers() })
      if (res.ok) return
      lastError = new Error(`opencode /path returned ${res.status}`)
    } catch (e) {
      lastError = e
    }
    await Bun.sleep(250)
  }
  throw new Error(`opencode not ready: ${String(lastError)}`)
}

export type CreateSessionInput = {
  title?: string
  agent?: string
  permission?: unknown
}

export type SessionInfo = { id: string; title?: string; directory?: string }

export async function createSession(input: CreateSessionInput = {}): Promise<SessionInfo> {
  const res = await fetch(`${BASE}/session`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(input),
  })
  if (!res.ok) throw new Error(`create session failed: ${res.status} ${await res.text()}`)
  return (await res.json()) as SessionInfo
}

export async function deleteSession(sessionID: string): Promise<void> {
  await fetch(`${BASE}/session/${sessionID}`, {
    method: "DELETE",
    headers: headers(),
  })
}

export async function sessionExists(sessionID: string): Promise<boolean> {
  const res = await fetch(`${BASE}/session/${sessionID}`, {
    headers: headers(),
  })
  if (res.status === 200) return true
  if (res.status === 404) return false
  throw new Error(`session lookup failed: ${res.status}`)
}

export type Turn = { role: "user" | "assistant"; text: string; time?: number }

type RawMessage = {
  info?: { role?: string; time?: { created?: number } }
  parts?: Array<{ type?: string; text?: string }>
}

export async function fetchTranscript(sessionID: string): Promise<Turn[]> {
  // opencode's list-messages route is singular: /session/:id/message (not /messages).
  // The plural form 404s, fetchTranscript returns [], saveTranscript silently skips,
  // and no transcript ever lands in R2.
  const res = await fetch(`${BASE}/session/${sessionID}/message`, { headers: headers() })
  if (!res.ok) {
    if (res.status === 404) return []
    throw new Error(`fetch messages failed: ${res.status}`)
  }
  const messages = (await res.json()) as RawMessage[]
  const turns: Turn[] = []
  for (const m of messages) {
    const role = m.info?.role
    if (role !== "user" && role !== "assistant") continue
    const text = (m.parts ?? [])
      .filter((p) => p.type === "text" && typeof p.text === "string")
      .map((p) => p.text!.trim())
      .filter(Boolean)
      .join("\n\n")
    if (!text) continue
    turns.push({ role, text, time: m.info?.time?.created })
  }
  return turns
}

export type RawPart = { id?: string; type?: string; [k: string]: unknown }
export type MessageWithParts = {
  info?: { id?: string; role?: string; time?: { created?: number; completed?: number } }
  parts?: RawPart[]
}

export async function fetchMessageParts(sessionID: string): Promise<MessageWithParts[]> {
  const res = await fetch(`${BASE}/session/${sessionID}/message`, { headers: headers() })
  if (!res.ok) {
    if (res.status === 404) return []
    throw new Error(`fetch message parts failed: ${res.status}`)
  }
  return (await res.json()) as MessageWithParts[]
}

export type Attachment = {
  url: string
  mime?: string
  filename?: string
}

function inferMimeFromUrl(url: string): string | undefined {
  const m = url.match(/^data:([^;,]+)[;,]/)
  if (m) return m[1]?.toLowerCase()
  const ext = url.split("?")[0]?.split(".").pop()?.toLowerCase()
  if (!ext) return undefined
  const map: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
    gif: "image/gif",
    svg: "image/svg+xml",
    pdf: "application/pdf",
    txt: "text/plain",
  }
  return map[ext]
}

function extFromMime(mime: string): string | undefined {
  const map: Record<string, string> = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "image/svg+xml": ".svg",
    "application/pdf": ".pdf",
    "text/plain": ".txt",
  }
  return map[mime]
}

export type PromptInput = {
  prompt: string
  agent?: string
  model?: { providerID: string; id?: string; modelID?: string; variant?: string }
  variant?: string
  system?: string
  attachments?: Attachment[]
}

export async function promptAsync(sessionID: string, input: PromptInput): Promise<void> {
  const attachmentParts = (input.attachments ?? [])
    .filter((a) => a && typeof a.url === "string" && a.url.length > 0)
    .map((a, i) => ({
      type: "file" as const,
      url: a.url,
      mime: a.mime ?? inferMimeFromUrl(a.url) ?? "application/octet-stream",
      filename: a.filename ?? `attachment-${i + 1}${extFromMime(a.mime ?? inferMimeFromUrl(a.url) ?? "") ?? ""}`,
    }))

  const body = {
    agent: input.agent,
    model: input.model
      ? {
          providerID: input.model.providerID,
          modelID: input.model.modelID ?? input.model.id,
          variant: input.model.variant ?? input.variant,
        }
      : undefined,
    variant: input.variant ?? input.model?.variant,
    system: input.system,
    parts: [...attachmentParts, { type: "text", text: input.prompt }],
  }
  const res = await fetch(`${BASE}/session/${sessionID}/prompt_async`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
  })
  if (!res.ok && res.status !== 204) {
    throw new Error(`prompt failed: ${res.status} ${await res.text()}`)
  }
}

export async function abortSession(sessionID: string): Promise<boolean> {
  const res = await fetch(`${BASE}/session/${sessionID}/abort`, {
    method: "POST",
    headers: headers(),
  })
  if (!res.ok) throw new Error(`abort failed: ${res.status} ${await res.text()}`)
  return (await res.json().catch(() => true)) as boolean
}

export async function permissionReply(
  requestID: string,
  reply: "once" | "always" | "reject",
): Promise<void> {
  const res = await fetch(`${BASE}/permission/${requestID}/reply`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ reply }),
  })
  if (!res.ok) {
    throw new Error(`permission reply failed: ${res.status} ${await res.text()}`)
  }
}

export async function eventStream(signal: AbortSignal): Promise<Response> {
  const res = await fetch(`${BASE}/event`, {
    headers: { ...authHeader(), "x-opencode-directory": WORKSPACE, accept: "text/event-stream" },
    signal,
  })
  if (!res.ok || !res.body) {
    throw new Error(`event subscribe failed: ${res.status}`)
  }
  return res
}
