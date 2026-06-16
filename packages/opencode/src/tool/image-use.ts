import { Effect, Schema } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import crypto from "node:crypto"
import * as Tool from "./tool"
import DESCRIPTION from "./image-use.txt"

const DEFAULT_TIMEOUT = 60 * 1000
// Cap raw bytes so the base64-expanded attachment stays under Anthropic's
// 5 MB image limit (base64 is ~4/3x raw). The file itself is still saved
// to /workspace regardless — this only gates the inline attachment.
const MAX_ATTACHMENT_BYTES = 3 * 1024 * 1024

const MIME_TO_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/svg+xml": "svg",
}

// The agent supplies `filename`, and we write it under WORKSPACE_DIR. This tool
// writes to disk DIRECTLY (not via the sidecar's resolveSafe), so it must do
// its OWN containment check: force a single in-workspace path segment. Rejects
// path separators, "..", absolute paths, leading dots (dot-paths are excluded
// from the R2 sync), and NUL — so the agent can never escape the workspace.
function safeWorkspaceName(name: string | undefined, fallback: string): string {
  const trimmed = (name ?? "").trim()
  if (!trimmed) return fallback
  if (
    trimmed !== path.basename(trimmed) ||
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    trimmed.includes("\0") ||
    trimmed.startsWith(".")
  ) {
    throw new Error(
      `Invalid filename "${name}": must be a simple filename in the page folder ` +
        `(no path separators, no "..", no leading dot).`,
    )
  }
  return trimmed
}

export const Parameters = Schema.Struct({
  url: Schema.String.annotate({
    description: "Public URL of the image to download.",
  }),
  filename: Schema.optional(Schema.String).annotate({
    description: "Optional workspace filename (with extension). Defaults to a UUID + detected extension.",
  }),
})

export const ImageUseTool = Tool.define(
  "image_use",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          if (!params.url.startsWith("http://") && !params.url.startsWith("https://")) {
            throw new Error("URL must start with http:// or https://")
          }

          const publicBase = process.env["R2_PUBLIC_BASE"]
          // Workspace lives in the draft bucket (variants/unpublished/<encId>/);
          // images saved here are referenced RELATIVELY in HTML. This prefix is
          // only for building the chat-thumbnail absolute URL.
          const draftPrefix = (process.env["WORKER_DRAFT_PREFIX"] ?? "").replace(/^\/+|\/+$/g, "")
          const workspace = process.env["WORKSPACE_DIR"] ?? process.cwd()

          yield* ctx.ask({
            permission: "image_use",
            patterns: [params.url.slice(0, 80)],
            always: ["*"],
            metadata: { url: params.url },
          })

          const controller = new AbortController()
          const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT)
          let res: Response
          try {
            res = yield* Effect.promise(() => fetch(params.url, { signal: controller.signal }))
          } finally {
            clearTimeout(timeoutId)
          }
          if (!res.ok) throw new Error(`fetch failed (${res.status}) for ${params.url}`)
          const contentType = (res.headers.get("content-type") ?? "image/png").split(";")[0].toLowerCase()
          if (!contentType.startsWith("image/")) {
            throw new Error(`URL did not return an image (content-type: ${contentType})`)
          }
          const ext = MIME_TO_EXT[contentType] ?? "bin"
          const filename = safeWorkspaceName(params.filename, `${crypto.randomUUID()}.${ext}`)

          const buf = yield* Effect.promise(() => res.arrayBuffer())
          const bytes = Buffer.from(buf)
          yield* Effect.promise(() => fs.mkdir(workspace, { recursive: true }))
          yield* Effect.promise(() => fs.writeFile(path.join(workspace, filename), bytes))

          const publicUrl =
            publicBase && draftPrefix
              ? `${publicBase.replace(/\/+$/, "")}/${draftPrefix}/${filename}`
              : null

          const tooLargeForInline = bytes.byteLength > MAX_ATTACHMENT_BYTES
          const dataUrl = tooLargeForInline ? null : `data:${contentType};base64,${bytes.toString("base64")}`

          return {
            title: `Saved ${filename}`,
            output: [
              `Downloaded ${params.url} (${bytes.byteLength} bytes, ${contentType}) as ${filename}.`,
              publicUrl
                ? `Reference it in HTML with this ABSOLUTE URL: <img src="${publicUrl}" alt="..."> — it resolves to your draft on the CDN (live after this turn saves).`
                : `Saved locally as ${filename}.`,
              tooLargeForInline
                ? `(${bytes.byteLength} bytes exceeds the ${MAX_ATTACHMENT_BYTES}-byte inline limit, not attached.)`
                : null,
            ]
              .filter(Boolean)
              .join("\n"),
            metadata: {
              url: params.url,
              filename,
              path: `/workspace/${filename}`,
              publicUrl,
              mime: contentType,
              bytes: bytes.byteLength,
            },
            attachments: dataUrl ? [{ type: "file" as const, mime: contentType, url: dataUrl }] : [],
          }
        }).pipe(Effect.orDie),
    }
  }),
)
