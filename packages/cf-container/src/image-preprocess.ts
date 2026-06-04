// Resize image attachments before forwarding to opencode so we never hand the
// LLM something that blows past Anthropic (max 8000px, 5MB), Bedrock or Google
// (5MB) limits. Handles both data: URLs and HTTPS URLs (e.g. R2 public).
import type { Attachment } from "./opencode"
import { log } from "./log"

const MAX_DIM = 2000
const MAX_BASE64_BYTES = 5 * 1024 * 1024
const JPEG_QUALITIES = [85, 75, 65, 55, 45]
const RESIZE_ATTEMPTS = 5

type Photon = typeof import("@silvia-odwyer/photon-node")
let photonPromise: Promise<Photon | null> | null = null

function loadPhoton(): Promise<Photon | null> {
  if (!photonPromise) {
    photonPromise = import("@silvia-odwyer/photon-node").catch((error) => {
      log.warn("photon.load.failed", { error: String(error) })
      return null
    })
  }
  return photonPromise
}

function inferMime(url: string): string | undefined {
  const m = url.match(/^data:([^;,]+)[;,]/)
  if (m) return m[1].toLowerCase()
  const ext = url.split("?")[0].split(".").pop()?.toLowerCase()
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

async function fetchBytes(url: string): Promise<Uint8Array | null> {
  if (url.startsWith("data:")) {
    const idx = url.indexOf(";base64,")
    if (idx < 0) return null
    return Buffer.from(url.slice(idx + ";base64,".length), "base64")
  }
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    return new Uint8Array(await res.arrayBuffer())
  } catch (error) {
    log.warn("image.fetch.failed", { url, error: String(error) })
    return null
  }
}

async function resizeOne(att: Attachment): Promise<Attachment> {
  const mime = att.mime ?? inferMime(att.url)
  if (!mime?.startsWith("image/")) return att
  // GIF/SVG: resizing breaks animation / loses vector fidelity — pass through.
  if (mime === "image/gif" || mime === "image/svg+xml") return att

  const photon = await loadPhoton()
  if (!photon) return att

  const bytes = await fetchBytes(att.url)
  if (!bytes) return att

  let img: InstanceType<Photon["PhotonImage"]>
  try {
    img = photon.PhotonImage.new_from_byteslice(bytes)
  } catch (error) {
    log.warn("image.decode.failed", { mime, error: String(error) })
    return att
  }

  try {
    const w = img.get_width()
    const h = img.get_height()
    // Rough base64 size = ceil(bytes * 4 / 3). If already small and in-bounds, skip.
    const base64Size = Math.ceil((bytes.length * 4) / 3)
    if (w <= MAX_DIM && h <= MAX_DIM && base64Size <= MAX_BASE64_BYTES) {
      return att
    }

    const scale = Math.min(1, MAX_DIM / w, MAX_DIM / h)
    let curW = Math.max(1, Math.round(w * scale))
    let curH = Math.max(1, Math.round(h * scale))

    for (let attempt = 0; attempt < RESIZE_ATTEMPTS; attempt++) {
      const resized = photon.resize(img, curW, curH, photon.SamplingFilter.Lanczos3)
      try {
        for (const quality of JPEG_QUALITIES) {
          const jpegBytes = resized.get_bytes_jpeg(quality)
          const base64 = Buffer.from(jpegBytes).toString("base64")
          if (Buffer.byteLength(base64, "utf8") <= MAX_BASE64_BYTES) {
            log.info("image.resized", {
              from: `${w}x${h}`,
              to: `${curW}x${curH}`,
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
      } finally {
        resized.free()
      }
      curW = Math.max(1, Math.floor(curW * 0.75))
      curH = Math.max(1, Math.floor(curH * 0.75))
    }

    log.warn("image.resize.gaveup", { w, h, bytes: bytes.length })
    return att
  } finally {
    img.free()
  }
}

export async function preprocessAttachments(
  attachments?: Attachment[],
): Promise<Attachment[] | undefined> {
  if (!attachments?.length) return attachments
  return Promise.all(attachments.map(resizeOne))
}
