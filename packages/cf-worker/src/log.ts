type Level = "info" | "warn" | "error" | "debug"
type Ctx = Record<string, unknown>

export function log(level: Level, msg: string, ctx?: Ctx): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg,
    component: "worker",
    ...(ctx ?? {}),
  })
  if (level === "error") console.error(line)
  else console.log(line)
}

export const logger = {
  info: (msg: string, ctx?: Ctx) => log("info", msg, ctx),
  warn: (msg: string, ctx?: Ctx) => log("warn", msg, ctx),
  error: (msg: string, ctx?: Ctx) => log("error", msg, ctx),
  debug: (msg: string, ctx?: Ctx) => log("debug", msg, ctx),
}
