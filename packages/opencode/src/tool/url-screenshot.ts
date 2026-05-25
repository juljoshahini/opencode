import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./url-screenshot.txt"

const DEFAULT_TIMEOUT = 120 * 1000

export const Parameters = Schema.Struct({
  url: Schema.String.annotate({
    description: "Fully-qualified URL to screenshot. Must start with http:// or https://.",
  }),
  viewportWidth: Schema.optional(Schema.Number).annotate({
    description: "Browser viewport width in px. Defaults to 1280.",
  }),
  viewportHeight: Schema.optional(Schema.Number).annotate({
    description: "Browser viewport height in px. Defaults to 800.",
  }),
  fullPage: Schema.optional(Schema.Boolean).annotate({
    description: "Capture full scrollable page instead of just the viewport. Defaults to false.",
  }),
})

export const UrlScreenshotTool = Tool.define(
  "url_screenshot",
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
              "url_screenshot requires CF_API_TOKEN and CF_ACCOUNT_ID env vars. Set them to a Cloudflare API token with Browser Rendering: Edit permission, and the account id where Browser Rendering is enabled.",
            )
          }

          yield* ctx.ask({
            permission: "url_screenshot",
            patterns: [params.url.slice(0, 80)],
            always: ["*"],
            metadata: { url: params.url },
          })

          const endpoint = `https://api.cloudflare.com/client/v4/accounts/${accountId}/browser-rendering/screenshot`
          const body = {
            url: params.url,
            viewport: {
              width: params.viewportWidth ?? 1280,
              height: params.viewportHeight ?? 800,
            },
            screenshotOptions: {
              fullPage: params.fullPage ?? false,
              type: "png",
            },
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
            throw new Error(`Browser Rendering screenshot failed (${res.status}): ${text.slice(0, 400)}`)
          }

          const contentType = (res.headers.get("content-type") ?? "image/png").split(";")[0].toLowerCase()
          const buf = yield* Effect.promise(() => res.arrayBuffer())
          const bytes = Buffer.from(buf)
          const dataUrl = `data:${contentType};base64,${bytes.toString("base64")}`

          return {
            title: `Screenshot of ${params.url}`,
            output: [
              `Captured ${params.url} at ${body.viewport.width}x${body.viewport.height}${body.screenshotOptions.fullPage ? " (full page)" : ""}.`,
              `Returned ${bytes.byteLength} bytes of ${contentType}.`,
              `The screenshot is attached for your inspection. It is NOT saved to /workspace — examine it for design cues and write matching HTML/CSS.`,
            ].join("\n"),
            metadata: {
              url: params.url,
              viewportWidth: body.viewport.width,
              viewportHeight: body.viewport.height,
              fullPage: body.screenshotOptions.fullPage,
              mime: contentType,
              bytes: bytes.byteLength,
            },
            attachments: [{ type: "file" as const, mime: contentType, url: dataUrl }],
          }
        }).pipe(Effect.orDie),
    }
  }),
)
