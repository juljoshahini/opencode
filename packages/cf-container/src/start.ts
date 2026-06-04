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

// Start sidecar FIRST so the externally-exposed port (8080) is bound
// immediately. Cloudflare Containers gates the container as "not listening"
// until that port is open, and the merged opencode binary can take longer
// than CF's startup probe to reach HTTP-ready. The sidecar's handlers will
// surface a clear error if opencode isn't up yet for a given request.
console.log("starting sidecar")
await import("./sidecar")

// Kick off the opencode readiness probe in the background. The sidecar's
// request handlers gate on Opencode.awaitReady() so they hold the request
// for up to ~30s while opencode warms up, rather than failing fast on a
// connection refused (which surfaced as a Bun error overlay to the client).
Opencode.startReadiness(120_000)
