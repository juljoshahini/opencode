import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./analytics-get.txt"
import { agentApiBase, readAgentToken } from "./settings-get"

const DEFAULT_TIMEOUT = 20 * 1000

export const Parameters = Schema.Struct({
  from: Schema.String.annotate({ description: "Start date (inclusive), YYYY-MM-DD" }),
  to: Schema.String.annotate({ description: "End date (inclusive), YYYY-MM-DD" }),
  timezone: Schema.optional(Schema.String).annotate({
    description: 'Optional IANA timezone (e.g. "Europe/Berlin"). Defaults to UTC.',
  }),
})

export const AnalyticsGetTool = Tool.define(
  "analytics_get",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const base = agentApiBase()
          if (!base) throw new Error("analytics_get requires the LANDERLAB_API_BASE environment variable.")
          const token = yield* Effect.promise(() => readAgentToken())
          if (!token) {
            throw new Error(
              "No agent token available for this run — the analytics API can't be reached. Tell the user analytics can't be read right now.",
            )
          }

          yield* ctx.ask({
            permission: "analytics_get",
            patterns: [`${params.from}..${params.to}`],
            always: ["*"],
            metadata: {},
          })

          const qs = new URLSearchParams({ from: params.from, to: params.to })
          if (params.timezone) qs.set("timezone", params.timezone)

          const controller = new AbortController()
          const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT)
          let res: Response
          try {
            res = yield* Effect.promise(() =>
              fetch(`${base}/agent/analytics?${qs.toString()}`, {
                headers: { Authorization: `Bearer ${token}` },
                signal: controller.signal,
              }),
            )
          } finally {
            clearTimeout(timeoutId)
          }

          const text = yield* Effect.promise(() => res.text())
          if (!res.ok) {
            throw new Error(`analytics_get failed (${res.status}): ${text.slice(0, 400)}`)
          }

          return {
            title: `Analytics ${params.from} → ${params.to}`,
            output: text,
            metadata: { status: res.status, truncated: false },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
