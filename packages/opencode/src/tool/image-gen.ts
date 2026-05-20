import { Effect, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import fs from "node:fs/promises"
import path from "node:path"
import crypto from "node:crypto"
import * as Tool from "./tool"
import DESCRIPTION from "./image-gen.txt"

const DEFAULT_TIMEOUT = 120 * 1000
const DEFAULT_MODEL = "google/gemini-3.1-flash-image-preview"

const MIME_TO_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
}

export const Parameters = Schema.Struct({
  prompt: Schema.String.annotate({
    description: "Vivid, specific description of the image to generate (subject, style, lighting, composition).",
  }),
})

export const ImageGenTool = Tool.define(
  "image_generate",
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const apiKey = process.env["OPENROUTER_API_KEY"]
          const model = process.env["IMAGE_GEN_MODEL"] ?? DEFAULT_MODEL
          const sessionId = process.env["WORKER_SESSION_ID"]
          const publicBase = process.env["R2_PUBLIC_BASE"]
          const workspace = process.env["WORKSPACE_DIR"] ?? process.cwd()

          if (!apiKey) {
            throw new Error("image_generate requires OPENROUTER_API_KEY environment variable.")
          }

          yield* ctx.ask({
            permission: "image_generate",
            patterns: [params.prompt.slice(0, 80)],
            always: ["*"],
            metadata: { prompt: params.prompt },
          })

          const url = "https://openrouter.ai/api/v1/chat/completions"
          const body = {
            model,
            messages: [{ role: "user", content: params.prompt }],
            modalities: ["image", "text"],
          }

          const response = yield* HttpClientRequest.post(url).pipe(
            HttpClientRequest.setHeaders({
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
            }),
            HttpClientRequest.bodyJson(body),
            Effect.flatMap((req) => http.execute(req)),
            Effect.timeoutOrElse({
              duration: DEFAULT_TIMEOUT,
              orElse: () => Effect.die(new Error("Image generation timed out (120s)")),
            }),
          )

          if (response.status >= 400) {
            const text = yield* response.text
            throw new Error(`Image generation failed (${response.status}): ${text.slice(0, 500)}`)
          }

          const raw = yield* response.text
          const parsed = JSON.parse(raw) as {
            choices?: Array<{ message?: { images?: Array<{ image_url?: { url?: string } }> } }>
          }

          const images = parsed.choices?.[0]?.message?.images ?? []
          if (images.length === 0) throw new Error("OpenRouter response did not include any images")

          const first = images[0].image_url?.url
          if (!first) throw new Error("OpenRouter image_url.url missing")
          const dataMatch = first.match(/^data:([^;,]+);base64,(.+)$/)
          if (!dataMatch) throw new Error("Expected base64 data URL from OpenRouter")
          const mime = dataMatch[1].toLowerCase()
          const ext = MIME_TO_EXT[mime] ?? "bin"
          const buf = Buffer.from(dataMatch[2], "base64")

          const filename = `${crypto.randomUUID()}.${ext}`
          yield* Effect.promise(() => fs.mkdir(workspace, { recursive: true }))
          yield* Effect.promise(() => fs.writeFile(path.join(workspace, filename), buf))

          const publicUrl =
            publicBase && sessionId
              ? `${publicBase.replace(/\/+$/, "")}/sessions/${sessionId}/${filename}`
              : null

          const lines = [
            `Saved generated image to /workspace/${filename} (${buf.byteLength} bytes, ${mime}).`,
            publicUrl
              ? `Public URL (available after the prompt completes and R2 sync runs): ${publicUrl}`
              : `No R2 public base URL configured — only saved locally as ${filename}.`,
            `Reference the image in HTML using src="${publicUrl ?? `./${filename}`}".`,
          ]

          return {
            title: params.prompt.length > 60 ? params.prompt.slice(0, 57) + "..." : params.prompt,
            output: lines.join("\n"),
            metadata: {
              prompt: params.prompt,
              model,
              filename,
              path: `/workspace/${filename}`,
              publicUrl,
              mime,
              bytes: buf.byteLength,
            },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
