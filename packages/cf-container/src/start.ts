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
import { log } from "./log"

const OPENCODE_BIN = process.env.OPENCODE_BIN ?? "opencode"
const OPENCODE_PORT = process.env.OPENCODE_PORT ?? "4096"
const OPENCODE_HOST = process.env.OPENCODE_HOST ?? "127.0.0.1"

if (!process.env.OPENCODE_INTERNAL_URL) {
  process.env.OPENCODE_INTERNAL_URL = `http://${OPENCODE_HOST}:${OPENCODE_PORT}`
}

const SUPERVISOR_STARTED_AT = Date.now()

// Surface anything that would otherwise kill the supervisor silently. The
// sidecar has its own handlers but this is the outer process — if it dies,
// the container disappears and we get no signal in cf-worker tail.
process.on("uncaughtException", (err) => {
  log.error("supervisor.uncaughtException", {
    name: err?.name,
    message: err?.message,
    stack: err?.stack?.split("\n").slice(0, 8).join(" | "),
    uptimeMs: Date.now() - SUPERVISOR_STARTED_AT,
  })
  // Will fall through to opencode.exit handler if the throw came from there.
  process.exit(1)
})
process.on("unhandledRejection", (reason) => {
  const err = reason as { name?: string; message?: string; stack?: string } | undefined
  log.error("supervisor.unhandledRejection", {
    name: err?.name,
    message: err?.message ?? String(reason),
    stack: err?.stack?.split("\n").slice(0, 8).join(" | "),
    uptimeMs: Date.now() - SUPERVISOR_STARTED_AT,
  })
})

await fs.mkdir(WORKSPACE, { recursive: true })

log.info("supervisor.start", { workspace: WORKSPACE })
await import("./sidecar")

log.info("supervisor.waitingForSpawn")
await waitForSpawnSignal()

const opencodeStartedAt = Date.now()
log.info("opencode.spawn", { host: OPENCODE_HOST, port: OPENCODE_PORT, bin: OPENCODE_BIN })
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
const shutdown = (reason: string, code = 0) => {
  if (shuttingDown) {
    log.warn("supervisor.shutdown.duplicate", { reason })
    return
  }
  shuttingDown = true
  log.info("supervisor.shutdown", {
    reason,
    code,
    uptimeMs: Date.now() - SUPERVISOR_STARTED_AT,
    opencodePid: opencode.pid,
    opencodeAlive: opencode.pid != null && !opencode.killed,
  })
  if (opencode.pid && !opencode.killed) {
    try {
      opencode.kill("SIGTERM")
    } catch (e) {
      log.error("supervisor.opencode.killFailed", { error: String(e) })
    }
  }
  setTimeout(() => process.exit(code), 500)
}

opencode.on("exit", (code, signal) => {
  // This is the smoking-gun log if opencode itself crashed. `signal` will be
  // populated if it was killed (SIGSEGV / SIGABRT / SIGTERM); `code` will be
  // populated if it exited on its own. A non-zero `code` without a signal is
  // an unhandled exception inside opencode.
  log.error("opencode.exit", {
    code,
    signal,
    runtimeMs: Date.now() - opencodeStartedAt,
    supervisorAlreadyShuttingDown: shuttingDown,
  })
  shutdown(`opencode exited code=${code} signal=${signal}`, code ?? 1)
})

opencode.on("error", (err) => {
  // Fired when the spawn itself fails (e.g. binary missing). Distinct from
  // an exit-with-non-zero, which means it ran and then crashed.
  log.error("opencode.spawnError", {
    name: err?.name,
    message: err?.message,
    runtimeMs: Date.now() - opencodeStartedAt,
  })
  shutdown(`opencode spawn error: ${err?.message}`, 1)
})

process.on("SIGTERM", () => shutdown("SIGTERM", 0))
process.on("SIGINT", () => shutdown("SIGINT", 0))

try {
  await Opencode.ready(60_000)
  log.info("opencode.ready", { msToReady: Date.now() - opencodeStartedAt })
} catch (e) {
  log.error("opencode.readyTimeout", {
    msToReady: Date.now() - opencodeStartedAt,
    error: String(e),
  })
  shutdown("opencode failed to become ready", 1)
}
