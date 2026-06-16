import { Effect, Schema } from "effect"
import fs from "node:fs/promises"
import * as Tool from "./tool"
import DESCRIPTION from "./settings-get.txt"

const DEFAULT_TIMEOUT = 15 * 1000

export async function readAgentToken(): Promise<string | null> {
  const file = process.env["AGENT_TOKEN_FILE"] ?? "/tmp/.agent-token"
  try {
    const token = (await fs.readFile(file, "utf8")).trim()
    return token || null
  } catch {
    return null
  }
}

export function agentApiBase(): string | null {
  const base = process.env["LANDERLAB_API_BASE"]
  return base ? base.replace(/\/+$/, "") : null
}

export const Parameters = Schema.Struct({})

export const SettingsGetTool = Tool.define(
  "settings_get",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (_params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const base = agentApiBase()
          if (!base) throw new Error("settings_get requires the LANDERLAB_API_BASE environment variable.")
          const token = yield* Effect.promise(() => readAgentToken())
          if (!token) {
            throw new Error(
              "No agent token available for this run — the settings API can't be reached. Tell the user that lander settings can't be read right now.",
            )
          }

          yield* ctx.ask({
            permission: "settings_get",
            patterns: ["*"],
            always: ["*"],
            metadata: {},
          })

          const controller = new AbortController()
          const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT)
          let res: Response
          try {
            res = yield* Effect.promise(() =>
              fetch(`${base}/agent/settings`, {
                headers: { Authorization: `Bearer ${token}` },
                signal: controller.signal,
              }),
            )
          } finally {
            clearTimeout(timeoutId)
          }

          const text = yield* Effect.promise(() => res.text())
          if (!res.ok) {
            throw new Error(`settings_get failed (${res.status}): ${text.slice(0, 400)}`)
          }

          return {
            title: "Lander settings",
            output: text,
            metadata: { status: res.status },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
