import type { OpenCodeSession } from "./session"

export interface Env {
  SESSIONS: DurableObjectNamespace<OpenCodeSession>
  // openlanderlab bucket — agent INTERNALS only (SQLite state bundle,
  // transcripts). Never serves the page; never published.
  FILES: R2Bucket
  // landerlab-prod bucket — the agent's workspace IS the variant's draft,
  // synced to/from variants/unpublished/<encryptedVariantId>/. This is what
  // the editor/preview reads, and what Publish promotes to live.
  PROD: R2Bucket

  API_KEY: string
  SIDECAR_TOKEN: string
  OPENCODE_SERVER_PASSWORD: string

  ANTHROPIC_API_KEY?: string
  OPENAI_API_KEY?: string
  AI_GATEWAY_API_KEY?: string
  GOOGLE_GENERATIVE_AI_API_KEY?: string
  IMAGE_GEN_MODEL?: string
  R2_PUBLIC_BASE?: string
  CF_API_TOKEN?: string
  CF_ACCOUNT_ID?: string
  // Base URL of the LanderLab backend's agent API (e.g.
  // "https://backend-v2-test.landerlab.workers.dev/api/v2"). Used by the
  // settings_get / settings_update tools together with the per-turn JWT.
  LANDERLAB_API_BASE?: string
  // Preview host that renders a variant draft, e.g.
  // "https://preview.landerlabpages.com". The DO builds the agent's
  // per-variant preview URL as `${LANDERLAB_PREVIEW_BASE}/variants/<encId>`.
  LANDERLAB_PREVIEW_BASE?: string
  // Shared secret for the DO -> backend turn-complete callback. The DO POSTs
  // ${LANDERLAB_API_BASE}/internal/turn-complete with this in x-callback-secret
  // when a turn finishes (even after client disconnect) so the backend can
  // finalize the assistant chat row + version snapshot independently of the
  // client request.
  LANDERLAB_CALLBACK_SECRET?: string
}

export const PROVIDER_VARS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "AI_GATEWAY_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "IMAGE_GEN_MODEL",
  "R2_PUBLIC_BASE",
  "CF_API_TOKEN",
  "CF_ACCOUNT_ID",
  "LANDERLAB_API_BASE",
] as const

// Legacy session-bucket prefix (openlanderlab). No longer used for the
// workspace — kept only for any residual cleanup of old session objects.
export function r2PrefixFor(sessionId: string): string {
  return `sessions/${sessionId}/`
}

// The variant draft prefix in the landerlab-prod bucket. The backend sends the
// variant's encryptedId AS the session id, so it's the draft folder name
// directly — no derivation needed. The workspace syncs to/from here, so the
// agent edits the exact draft the editor/preview serves.
export function draftPrefixFor(encryptedVariantId: string): string {
  return `variants/unpublished/${encryptedVariantId}/`
}

// Build the R2 key for a file `rel` inside a session's draft, with a HARD
// guarantee it can never escape the per-session prefix. `rel` is untrusted: it
// comes from a URL path param (the file routes) or the container file list (the
// sync). Returns null — never throws — if `rel` is unsafe, so callers decide
// the response (route -> 400, sync -> skip+log). This is the single chokepoint
// for every workspace R2 key; nothing else concatenates the prefix by hand.
//
// Note R2 keys are flat (no ".." resolution), so a ".." could only ever create
// a junk literal key that still begins with the prefix — but we reject it
// anyway so the invariant is enforced by assertion, not just by R2's behavior.
export function draftKeyFor(sessionId: string, rel = ""): string | null {
  const prefix = draftPrefixFor(sessionId)
  const cleaned = rel.replace(/^[/\\]+/, "")
  if (cleaned.includes("\0")) return null
  if (cleaned.split(/[/\\]/).some((seg) => seg === "..")) return null
  const key = `${prefix}${cleaned}`
  if (!key.startsWith(prefix)) return null
  return key
}

export function historyKeyFor(sessionId: string): string {
  return `transcripts/${sessionId}.json`
}

// Full opencode SQLite bundle (db + WAL + SHM, base64'd) for the session.
// Lets us hand back to opencode the exact state it had before container sleep,
// including tool history and compaction metadata.
export function stateKeyFor(sessionId: string): string {
  return `state/${sessionId}.json`
}
