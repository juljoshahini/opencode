import fs from "node:fs/promises"
import { spawn, type ChildProcess } from "node:child_process"
import { WORKSPACE } from "./paths"
import * as Opencode from "./opencode"

const OPENCODE_BIN = process.env.OPENCODE_BIN ?? "opencode"
const OPENCODE_PORT = process.env.OPENCODE_PORT ?? "4096"
const OPENCODE_HOST = process.env.OPENCODE_HOST ?? "127.0.0.1"

if (!process.env.OPENCODE_INTERNAL_URL) {
  process.env.OPENCODE_INTERNAL_URL = `http://${OPENCODE_HOST}:${OPENCODE_PORT}`
}

await fs.mkdir(WORKSPACE, { recursive: true })

console.log(`booting opencode serve on ${OPENCODE_HOST}:${OPENCODE_PORT}`)
const opencode: ChildProcess = spawn(
  OPENCODE_BIN,
  ["serve", "--port", OPENCODE_PORT, "--hostname", OPENCODE_HOST],
  {
    stdio: ["ignore", "inherit", "inherit"],
    cwd: WORKSPACE,
    env: process.env,
  },
)

let shuttingDown = false
const shutdown = (code = 0) => {
  if (shuttingDown) return
  shuttingDown = true
  console.log("supervisor shutting down")
  if (opencode.pid && !opencode.killed) {
    try {
      opencode.kill("SIGTERM")
    } catch {}
  }
  setTimeout(() => process.exit(code), 500)
}

opencode.on("exit", (code, signal) => {
  console.error(`opencode exited code=${code} signal=${signal}`)
  shutdown(code ?? 1)
})
process.on("SIGTERM", () => shutdown(0))
process.on("SIGINT", () => shutdown(0))

try {
  await Opencode.ready(60_000)
  console.log("opencode ready")
} catch (e) {
  console.error("opencode failed to start:", e)
  shutdown(1)
}

console.log("starting sidecar")
await import("./sidecar")
