import type { Attachment } from "./opencode"
import { log } from "./log"
import sharp from "sharp"

const MAX_DIM = 2000
const MAX_BASE64_BYTES = 5 * 1024 * 1024
const MAX_INPUT_PIXELS = 300_000_000
const JPEG_QUALITIES = [85, 75, 65, 55, 45]

function inferMime(url: string): string | undefined {
  const m = url.match(/^data:([^;,]+)[;,]/)
  if (m) return m[1]?.toLowerCase()
  const ext = url.split("?")[0]?.split(".").pop()?.toLowerCase()
  if (!ext) return undefined
  const map: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
    gif: "image/gif",
  }
  return map[ext]
}

async function fetchBytes(url: string): Promise<Buffer | null> {
  if (url.startsWith("data:")) {
    const idx = url.indexOf(";base64,")
    if (idx < 0) return null
    return Buffer.from(url.slice(idx + ";base64,".length), "base64")
  }
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    return Buffer.from(await res.arrayBuffer())
  } catch (error) {
    log.warn("image.fetch.failed", { url, error: String(error) })
    return null
  }
}

async function resizeOne(att: Attachment): Promise<Attachment> {
  const mime = att.mime ?? inferMime(att.url)
  if (!mime?.startsWith("image/")) return att
  if (mime === "image/gif" || mime === "image/svg+xml") return att

  const bytes = await fetchBytes(att.url)
  if (!bytes) return att

  try {
    const meta = await sharp(bytes, { failOn: "none", limitInputPixels: MAX_INPUT_PIXELS }).metadata()
    const w = meta.width ?? 0
    const h = meta.height ?? 0
    const base64Size = Math.ceil((bytes.length * 4) / 3)
    if (w > 0 && h > 0 && w <= MAX_DIM && h <= MAX_DIM && base64Size <= MAX_BASE64_BYTES) {
      return att
    }

    const resized = await sharp(bytes, { failOn: "none", limitInputPixels: MAX_INPUT_PIXELS })
      .resize({ width: MAX_DIM, height: MAX_DIM, fit: "inside", withoutEnlargement: true })
      .toBuffer()

    for (const quality of JPEG_QUALITIES) {
      const jpeg = await sharp(resized).jpeg({ quality, mozjpeg: true }).toBuffer()
      const base64 = jpeg.toString("base64")
      if (Buffer.byteLength(base64, "utf8") <= MAX_BASE64_BYTES) {
        log.info("image.resized", {
          from: `${w}x${h}`,
          quality,
          originalBytes: bytes.length,
          finalBase64Bytes: base64.length,
        })
        return {
          ...att,
          mime: "image/jpeg",
          url: `data:image/jpeg;base64,${base64}`,
        }
      }
    }

    log.warn("image.resize.gaveup", { w, h, bytes: bytes.length })
    return att
  } catch (error) {
    log.warn("image.process.failed", { mime, error: String(error) })
    return att
  }
}

export async function preprocessAttachments(
  attachments?: Attachment[],
): Promise<Attachment[] | undefined> {
  if (!attachments?.length) return attachments
  const out: Attachment[] = []
  for (const att of attachments) {
    out.push(await resizeOne(att))
  }
  return out
}
