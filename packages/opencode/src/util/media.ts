const startsWith = (bytes: Uint8Array, prefix: number[]) => prefix.every((value, index) => bytes[index] === value)

export function isPdfAttachment(mime: string) {
  return mime === "application/pdf"
}

export function isMedia(mime: string) {
  return mime.startsWith("image/") || isPdfAttachment(mime)
}

export function isImageAttachment(mime: string) {
  return mime.startsWith("image/") && mime !== "image/svg+xml" && mime !== "image/vnd.fastbidsheet"
}

export function sniffAttachmentMime(bytes: Uint8Array, fallback: string) {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png"
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg"
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return "image/gif"
  if (startsWith(bytes, [0x42, 0x4d])) return "image/bmp"
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf"
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes.subarray(8), [0x57, 0x45, 0x42, 0x50])) {
    return "image/webp"
  }

  return fallback
}

export const MAX_IMAGE_EDGE = 8000
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024

function readU32BE(bytes: Uint8Array, offset: number) {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0
}

export function getImageDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (bytes.length < 10) return undefined
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    if (bytes.length < 24) return undefined
    return { width: readU32BE(bytes, 16), height: readU32BE(bytes, 20) }
  }
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) {
    return { width: bytes[6] | (bytes[7] << 8), height: bytes[8] | (bytes[9] << 8) }
  }
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
    let offset = 2
    while (offset + 1 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset++
        continue
      }
      let marker = offset + 1
      while (marker < bytes.length && bytes[marker] === 0xff) marker++
      if (marker >= bytes.length) break
      const code = bytes[marker]
      offset = marker + 1
      if (code === 0x01 || (code >= 0xd0 && code <= 0xd9)) continue
      if (offset + 1 >= bytes.length) break
      const segLen = (bytes[offset] << 8) | bytes[offset + 1]
      if (segLen < 2) break
      if (code >= 0xc0 && code <= 0xcf && code !== 0xc4 && code !== 0xc8 && code !== 0xcc) {
        if (offset + 6 >= bytes.length) break
        return {
          height: (bytes[offset + 3] << 8) | bytes[offset + 4],
          width: (bytes[offset + 5] << 8) | bytes[offset + 6],
        }
      }
      offset += segLen
    }
    return undefined
  }
  if (
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    bytes.length >= 30 &&
    startsWith(bytes.subarray(8), [0x57, 0x45, 0x42, 0x50])
  ) {
    const fourCC = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15])
    if (fourCC === "VP8 ") {
      return { width: (bytes[26] | (bytes[27] << 8)) & 0x3fff, height: (bytes[28] | (bytes[29] << 8)) & 0x3fff }
    }
    if (fourCC === "VP8L") {
      const b = (bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24)) >>> 0
      return { width: (b & 0x3fff) + 1, height: ((b >>> 14) & 0x3fff) + 1 }
    }
    if (fourCC === "VP8X") {
      return {
        width: ((bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)) & 0xffffff) + 1,
        height: ((bytes[27] | (bytes[28] << 8) | (bytes[29] << 16)) & 0xffffff) + 1,
      }
    }
    return undefined
  }
  return undefined
}

export function base64BytesFromDataUrl(url: string): number | undefined {
  if (!url.startsWith("data:")) return undefined
  const comma = url.indexOf(",")
  if (comma === -1) return undefined
  if (!url.slice(5, comma).toLowerCase().includes("base64")) return undefined
  const b64 = url.slice(comma + 1)
  const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0
  return Math.max(0, Math.floor((b64.length * 3) / 4) - padding)
}

export function imageDimensionsFromDataUrl(url: string): { width: number; height: number } | undefined {
  if (!url.startsWith("data:")) return undefined
  const comma = url.indexOf(",")
  if (comma === -1) return undefined
  if (!url.slice(5, comma).toLowerCase().includes("base64")) return undefined
  const prefix = url.slice(comma + 1, comma + 1 + 131072)
  try {
    return getImageDimensions(Buffer.from(prefix, "base64"))
  } catch {
    return undefined
  }
}
