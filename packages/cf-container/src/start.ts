// Container supervisor. New ordering:
//   1. Start sidecar HTTP first (bind 8080) so CF's container probe passes and
//      the worker can push a state bundle / workspace files before opencode
//      has a chance to create an empty DB.
//   2. Wait for an explicit spawn signal (POST /__state/start from the worker,
//      or sidecar's auto-fallback if a non-state route hits first).
//   3. Spawn opencode subprocess.
//   4. Wait for opencode to be HTTP-ready, then we're done bootstrapping.
import fs from "node:fs/promises"
import { spawn, type ChildProcess } from "node:child_process"
import { WORKSPACE } from "./paths"
import * as Opencode from "./opencode"
import { waitForSpawnSignal } from "./opencode-lifecycle"

const OPENCODE_BIN = process.env.OPENCODE_BIN ?? "opencode"
const OPENCODE_PORT = process.env.OPENCODE_PORT ?? "4096"
const OPENCODE_HOST = process.env.OPENCODE_HOST ?? "127.0.0.1"

if (!process.env.OPENCODE_INTERNAL_URL) {
  process.env.OPENCODE_INTERNAL_URL = `http://${OPENCODE_HOST}:${OPENCODE_PORT}`
}

await fs.mkdir(WORKSPACE, { recursive: true })

console.log("starting sidecar")
await import("./sidecar")

console.log("waiting for spawn signal")
await waitForSpawnSignal()

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
