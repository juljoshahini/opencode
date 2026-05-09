import type { OpenCodeSession } from "./session"

export interface Env {
  SESSIONS: DurableObjectNamespace<OpenCodeSession>
  FILES: R2Bucket

  API_KEY: string
  SIDECAR_TOKEN: string
  OPENCODE_SERVER_PASSWORD: string

  ANTHROPIC_API_KEY?: string
  OPENAI_API_KEY?: string
  OPENROUTER_API_KEY?: string
  GOOGLE_GENERATIVE_AI_API_KEY?: string
}

export const PROVIDER_VARS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
] as const

export function r2PrefixFor(sessionId: string): string {
  return `sessions/${sessionId}/`
}

export function historyKeyFor(sessionId: string): string {
  return `_system/sessions/${sessionId}/transcript.json`
}
