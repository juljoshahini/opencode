type Level = "info" | "warn" | "error" | "debug"
type Ctx = Record<string, unknown>

// Emit the message string plus a structured payload object (NOT a
// pre-stringified blob): Workers Logs indexes object-argument fields, which
// makes dashboard queries like sessionId="..." or msg="turnComplete.sent"
// actually work. wrangler tail prints both, so grep-ability is unchanged.
export function log(level: Level, msg: string, ctx?: Ctx): void {
  const payload = {
    ts: new Date().toISOString(),
    level,
    msg,
    component: "worker",
    ...(ctx ?? {}),
  }
  if (level === "error") console.error(msg, payload)
  else console.log(msg, payload)
}

export const logger = {
  info: (msg: string, ctx?: Ctx) => log("info", msg, ctx),
  warn: (msg: string, ctx?: Ctx) => log("warn", msg, ctx),
  error: (msg: string, ctx?: Ctx) => log("error", msg, ctx),
  debug: (msg: string, ctx?: Ctx) => log("debug", msg, ctx),
}
