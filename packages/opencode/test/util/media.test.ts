import { describe, expect, test } from "bun:test"
import { getImageDimensions, base64BytesFromDataUrl, imageDimensionsFromDataUrl } from "../../src/util/media"

function png(width: number, height: number) {
  const w = Buffer.alloc(4)
  w.writeUInt32BE(width, 0)
  const h = Buffer.alloc(4)
  h.writeUInt32BE(height, 0)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from([0, 0, 0, 13]),
    Buffer.from("IHDR"),
    w,
    h,
  ])
}

describe("getImageDimensions", () => {
  test("png", () => {
    expect(getImageDimensions(png(4660, 100))).toEqual({ width: 4660, height: 100 })
  })

  test("gif (little-endian)", () => {
    const gif = Buffer.concat([Buffer.from("GIF89a"), Buffer.from([100, 0]), Buffer.from([200, 0])])
    expect(getImageDimensions(gif)).toEqual({ width: 100, height: 200 })
  })

  test("jpeg sof immediately after soi", () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x90, 0x02, 0x80])
    expect(getImageDimensions(jpeg)).toEqual({ width: 640, height: 400 })
  })

  test("jpeg with leading app0 segment before sof", () => {
    const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, ...new Array(14).fill(0)])
    const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x2c, 0x01, 0x90])
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof])
    expect(getImageDimensions(jpeg)).toEqual({ width: 400, height: 300 })
  })

  test("webp vp8x", () => {
    const webpx = Buffer.concat([
      Buffer.from("RIFF"),
      Buffer.from([0, 0, 0, 0]),
      Buffer.from("WEBP"),
      Buffer.from("VP8X"),
      Buffer.from([0, 0, 0, 0]),
      Buffer.from([0, 0, 0, 0]),
      Buffer.from([0xe7, 0x03, 0x00]),
      Buffer.from([0xcf, 0x07, 0x00]),
    ])
    expect(getImageDimensions(webpx)).toEqual({ width: 1000, height: 2000 })
  })

  test("garbage and truncated return undefined (never throws)", () => {
    expect(getImageDimensions(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]))).toBeUndefined()
    expect(getImageDimensions(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]))).toBeUndefined()
    expect(getImageDimensions(Buffer.from([0xff, 0xd8, 0xff]))).toBeUndefined()
  })

  test("oversized dimension is reported (caller guards on it)", () => {
    expect(getImageDimensions(png(640, 30000))).toEqual({ width: 640, height: 30000 })
  })
})

describe("data url helpers", () => {
  test("imageDimensionsFromDataUrl parses base64 header", () => {
    const url = `data:image/png;base64,${png(512, 256).toString("base64")}`
    expect(imageDimensionsFromDataUrl(url)).toEqual({ width: 512, height: 256 })
  })

  test("base64BytesFromDataUrl approximates raw size", () => {
    const url = `data:image/png;base64,${Buffer.alloc(900, 1).toString("base64")}`
    expect(base64BytesFromDataUrl(url)).toBe(900)
  })

  test("non-data and non-base64 urls return undefined", () => {
    expect(imageDimensionsFromDataUrl("https://example.com/a.png")).toBeUndefined()
    expect(base64BytesFromDataUrl("https://example.com/a.png")).toBeUndefined()
    expect(base64BytesFromDataUrl("data:image/png,notbase64")).toBeUndefined()
  })
})
