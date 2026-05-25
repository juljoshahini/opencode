import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./image-view.txt"

const DEFAULT_TIMEOUT = 60 * 1000
const MAX_BYTES = 8 * 1024 * 1024

export const Parameters = Schema.Struct({
  url: Schema.String.annotate({
    description: "Public URL of the image to examine. The image is NOT saved to the workspace — this is reference-only.",
  }),
})

export const ImageViewTool = Tool.define(
  "image_view",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          if (!params.url.startsWith("http://") && !params.url.startsWith("https://")) {
            throw new Error("URL must start with http:// or https://")
          }

          yield* ctx.ask({
            permission: "image_view",
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

          const buf = yield* Effect.promise(() => res.arrayBuffer())
          if (buf.byteLength > MAX_BYTES) {
            throw new Error(`image is ${buf.byteLength} bytes; max ${MAX_BYTES} for image_view`)
          }
          const bytes = Buffer.from(buf)
          const dataUrl = `data:${contentType};base64,${bytes.toString("base64")}`

          return {
            title: `Viewed ${params.url}`,
            output: `Loaded ${bytes.byteLength} bytes of ${contentType} from ${params.url}. The image is attached for your inspection. It is NOT saved to /workspace — examine it for design cues and write matching HTML/CSS.`,
            metadata: {
              url: params.url,
              mime: contentType,
              bytes: bytes.byteLength,
            },
            attachments: [{ type: "file" as const, mime: contentType, url: dataUrl }],
          }
        }).pipe(Effect.orDie),
    }
  }),
)
