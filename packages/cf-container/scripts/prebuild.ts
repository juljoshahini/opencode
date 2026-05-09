#!/usr/bin/env bun
import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, "..")
const opencodeDist = path.resolve(root, "..", "opencode", "dist")
const localDist = path.resolve(root, "dist")

const targets = [
  "opencode-linux-x64-baseline-musl/bin/opencode",
  "opencode-linux-arm64-musl/bin/opencode",
]

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

async function copyOne(rel: string) {
  const src = path.join(opencodeDist, rel)
  const dst = path.join(localDist, rel)
  if (!(await exists(src))) {
    console.warn(`skip (missing): ${src}`)
    return false
  }
  await fs.mkdir(path.dirname(dst), { recursive: true })
  await fs.copyFile(src, dst)
  await fs.chmod(dst, 0o755).catch(() => {})
  console.log(`copied ${rel}`)
  return true
}

async function main() {
  await fs.mkdir(localDist, { recursive: true })
  let copied = 0
  for (const t of targets) {
    if (await copyOne(t)) copied++
  }
  if (copied === 0) {
    console.error(
      `\nNo opencode binaries found at ${opencodeDist}.\n` +
        `Run:  bun run --cwd packages/opencode build\n`,
    )
    process.exit(1)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
