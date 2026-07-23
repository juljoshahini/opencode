import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./leads-get.txt"
import { agentApiBase, readAgentToken } from "./settings-get"

const DEFAULT_TIMEOUT = 20 * 1000

export const Parameters = Schema.Struct({
  from: Schema.String.annotate({ description: "Start date (inclusive), YYYY-MM-DD" }),
  to: Schema.String.annotate({ description: "End date (inclusive), YYYY-MM-DD" }),
  page: Schema.optional(Schema.Number).annotate({ description: "Page number, starting at 1 (default 1)" }),
  limit: Schema.optional(Schema.Number).annotate({ description: "Leads per page, 1-200 (default 50)" }),
  timezone: Schema.optional(Schema.String).annotate({
    description: 'Optional IANA timezone for the per-bucket counts. Defaults to UTC.',
  }),
})

export const LeadsGetTool = Tool.define(
  "leads_get",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const base = agentApiBase()
          if (!base) throw new Error("leads_get requires the LANDERLAB_API_BASE environment variable.")
          const token = yield* Effect.promise(() => readAgentToken())
          if (!token) {
            throw new Error(
              "No agent token available for this run — the leads API can't be reached. Tell the user leads can't be read right now.",
            )
          }

          yield* ctx.ask({
            permission: "leads_get",
            patterns: [`${params.from}..${params.to}`],
            always: ["*"],
            metadata: {},
          })

          const qs = new URLSearchParams({ from: params.from, to: params.to })
          if (params.timezone) qs.set("timezone", params.timezone)
          if (params.page !== undefined) qs.set("page", String(params.page))
          if (params.limit !== undefined) qs.set("limit", String(params.limit))

          const controller = new AbortController()
          const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT)
          let res: Response
          try {
            res = yield* Effect.promise(() =>
              fetch(`${base}/agent/leads?${qs.toString()}`, {
                headers: { Authorization: `Bearer ${token}` },
                signal: controller.signal,
              }),
            )
          } finally {
            clearTimeout(timeoutId)
          }

          const text = yield* Effect.promise(() => res.text())
          if (!res.ok) {
            throw new Error(`leads_get failed (${res.status}): ${text.slice(0, 400)}`)
          }

          return {
            title: `Leads ${params.from} → ${params.to}`,
            output: text,
            metadata: { status: res.status },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
