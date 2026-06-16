import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./settings-update.txt"
import { agentApiBase, readAgentToken } from "./settings-get"

const DEFAULT_TIMEOUT = 15 * 1000

export const Parameters = Schema.Struct({
  patch: Schema.Record(Schema.String, Schema.Unknown).annotate({
    description:
      'Partial settings object. Only include sections/fields you want to change — omitted fields are left untouched. Field names MUST come from the schema returned by settings_get. Example: {"seo": {"description": "New meta description"}, "general": {"title": "New Title"}}',
  }),
})

export const SettingsUpdateTool = Tool.define(
  "settings_update",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const base = agentApiBase()
          if (!base) throw new Error("settings_update requires the LANDERLAB_API_BASE environment variable.")
          const token = yield* Effect.promise(() => readAgentToken())
          if (!token) {
            throw new Error(
              "No agent token available for this run — the settings API can't be reached. Tell the user that lander settings can't be changed right now.",
            )
          }

          yield* ctx.ask({
            permission: "settings_update",
            patterns: [Object.keys(params.patch).join(",").slice(0, 80) || "*"],
            always: ["*"],
            metadata: { sections: Object.keys(params.patch) },
          })

          const controller = new AbortController()
          const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT)
          let res: Response
          try {
            res = yield* Effect.promise(() =>
              fetch(`${base}/agent/settings`, {
                method: "PATCH",
                headers: {
                  Authorization: `Bearer ${token}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify(params.patch),
                signal: controller.signal,
              }),
            )
          } finally {
            clearTimeout(timeoutId)
          }

          const text = yield* Effect.promise(() => res.text())
          if (!res.ok) {
            // 400s carry validation detail (unknown field, too long, etc.) —
            // surface it verbatim so the model can self-correct.
            throw new Error(`settings_update failed (${res.status}): ${text.slice(0, 500)}`)
          }

          return {
            title: `Updated settings: ${Object.keys(params.patch).join(", ")}`,
            output: text,
            metadata: { status: res.status, sections: Object.keys(params.patch) },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
