import { Effect, Schema } from "effect"
import TurndownService from "turndown"
import * as Tool from "./tool"
import DESCRIPTION from "./url-render.txt"

const DEFAULT_TIMEOUT = 120 * 1000
const MAX_CHARS = 200_000

export const Parameters = Schema.Struct({
  url: Schema.String.annotate({
    description: "Fully-qualified URL to fetch (with JS executed). Must start with http:// or https://.",
  }),
  format: Schema.Literals(["markdown", "html", "text"])
    .pipe(Schema.optional, Schema.withDecodingDefault(Effect.succeed("markdown" as const)))
    .annotate({ description: "Output format. Defaults to markdown." }),
})

export const UrlRenderTool = Tool.define(
  "url_render",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          if (!params.url.startsWith("http://") && !params.url.startsWith("https://")) {
            throw new Error("URL must start with http:// or https://")
          }

          const token = process.env["CF_API_TOKEN"]
          const accountId = process.env["CF_ACCOUNT_ID"]
          if (!token || !accountId) {
            throw new Error(
              "url_render requires CF_API_TOKEN and CF_ACCOUNT_ID env vars. Set them to a Cloudflare API token with Browser Rendering: Edit permission, and the account id where Browser Rendering is enabled.",
            )
          }

          yield* ctx.ask({
            permission: "url_render",
            patterns: [params.url.slice(0, 80)],
            always: ["*"],
            metadata: { url: params.url, format: params.format },
          })

          const endpoint = `https://api.cloudflare.com/client/v4/accounts/${accountId}/browser-rendering/content`
          const body = {
            url: params.url,
            gotoOptions: { waitUntil: "networkidle0", timeout: 30_000 },
          }

          const controller = new AbortController()
          const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT)
          let res: Response
          try {
            res = yield* Effect.promise(() =>
              fetch(endpoint, {
                method: "POST",
                headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
                body: JSON.stringify(body),
                signal: controller.signal,
              }),
            )
          } finally {
            clearTimeout(timeoutId)
          }

          if (!res.ok) {
            const text = yield* Effect.promise(() => res.text().catch(() => ""))
            throw new Error(`Browser Rendering content failed (${res.status}): ${text.slice(0, 400)}`)
          }

          const raw = yield* Effect.promise(() => res.text())
          let parsed: { success?: boolean; result?: string; errors?: unknown } = {}
          try {
            parsed = JSON.parse(raw) as typeof parsed
          } catch {
            // Some Browser Rendering endpoints return HTML directly; fall back to raw.
            parsed = { success: true, result: raw }
          }
          const html = parsed.result ?? ""
          if (!html) {
            throw new Error(`Browser Rendering returned no content: ${JSON.stringify(parsed).slice(0, 400)}`)
          }

          let output = html
          if (params.format === "markdown") {
            const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" })
            output = turndown.turndown(html)
          } else if (params.format === "text") {
            output = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
          }

          if (output.length > MAX_CHARS) {
            output = output.slice(0, MAX_CHARS) + `\n\n[truncated at ${MAX_CHARS} chars of ${output.length}]`
          }

          return {
            title: `Rendered ${params.url}`,
            output,
            metadata: {
              url: params.url,
              format: params.format,
              chars: output.length,
            },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
