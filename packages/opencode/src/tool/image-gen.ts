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
  model: Schema.optional(Schema.String).annotate({
    description:
      "Vercel AI Gateway model slug for image generation (e.g. 'google/gemini-3.1-flash-image-preview', 'openai/gpt-5.4-image-2'). Omit to use the default. Override when the user asks for a specific model.",
  }),
  image: Schema.optional(Schema.String).annotate({
    description:
      "Optional reference image to use as the visual starting point — the model will refine, restyle, or make variations of this image instead of generating from scratch. Must be an absolute http(s) URL (e.g. the publicUrl returned by a previous image_generate call, or any other public image URL). Workspace paths are NOT accepted — the model needs a publicly fetchable URL. Use when the user asks to 'change/refine/tweak/restyle/use the same image but...' or otherwise wants the new image to be derived from a prior one rather than fresh.",
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
          const apiKey = process.env["AI_GATEWAY_API_KEY"]
          // Per-call model wins over the env-var default; lets the user say
          // "use openai/gpt-5.4-image-2" in their prompt without redeploying.
          const model = params.model?.trim() || process.env["IMAGE_GEN_MODEL"] || DEFAULT_MODEL
          const publicBase = process.env["R2_PUBLIC_BASE"]
          // Where the workspace lives in the draft bucket, e.g.
          // "variants/unpublished/<encId>/". The image is written into the
          // workspace, so in HTML it's referenced RELATIVELY; this prefix is
          // only used to build an absolute URL for the chat thumbnail.
          const draftPrefix = (process.env["WORKER_DRAFT_PREFIX"] ?? "").replace(/^\/+|\/+$/g, "")
          const workspace = process.env["WORKSPACE_DIR"] ?? process.cwd()

          if (!apiKey) {
            throw new Error("image_generate requires AI_GATEWAY_API_KEY environment variable.")
          }

          yield* ctx.ask({
            permission: "image_generate",
            patterns: [params.prompt.slice(0, 80)],
            always: ["*"],
            metadata: { prompt: params.prompt, refining: params.image ? true : false },
          })

          if (params.image && !/^https?:\/\//i.test(params.image)) {
            throw new Error(
              `image must be an absolute http(s) URL (got: ${params.image.slice(0, 80)}). Workspace paths are not supported — pass the publicUrl from a previous image_generate call instead.`,
            )
          }

          const userContent = params.image
            ? [
                { type: "text", text: params.prompt },
                { type: "image_url", image_url: { url: params.image } },
              ]
            : params.prompt

          const url = "https://ai-gateway.vercel.sh/v1/chat/completions"
          const body = {
            model,
            messages: [{ role: "user", content: userContent }],
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
          if (images.length === 0) throw new Error("AI Gateway response did not include any images")

          const first = images[0].image_url?.url
          if (!first) throw new Error("AI Gateway image_url.url missing")
          const dataMatch = first.match(/^data:([^;,]+);base64,(.+)$/)
          if (!dataMatch) throw new Error("Expected base64 data URL from AI Gateway")
          const mime = dataMatch[1].toLowerCase()
          const ext = MIME_TO_EXT[mime] ?? "bin"
          const buf = Buffer.from(dataMatch[2], "base64")

          const filename = `${crypto.randomUUID()}.${ext}`
          yield* Effect.promise(() => fs.mkdir(workspace, { recursive: true }))
          yield* Effect.promise(() => fs.writeFile(path.join(workspace, filename), buf))

          // The image lives in the workspace = the draft folder, so the HTML
          // reference is always RELATIVE (resolves under both the unpublished
          // preview and the published live URL). publicUrl is for the chat
          // thumbnail only.
          const publicUrl =
            publicBase && draftPrefix
              ? `${publicBase.replace(/\/+$/, "")}/${draftPrefix}/${filename}`
              : null

          const lines = [
            `Saved generated image as ${filename} (${buf.byteLength} bytes, ${mime}).`,
            publicUrl
              ? `Reference it in HTML with this ABSOLUTE URL: <img src="${publicUrl}" alt="..."> — it resolves to your draft on the CDN (live after this turn saves).`
              : `Saved locally as ${filename}.`,
          ].filter(Boolean) as string[]

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
              refinedFrom: params.image ?? null,
            },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
