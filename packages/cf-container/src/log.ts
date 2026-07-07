type Level = "info" | "warn" | "error" | "debug"

type Ctx = Record<string, unknown>

let baseCtx: Ctx = {}

export function setBase(ctx: Ctx): void {
  baseCtx = { ...baseCtx, ...ctx }
}

// `msg` first: container stdout reaches Workers Logs as a JSON text line and
// the dashboard displays the FIRST field as the entry's message — with `ts`
// first, entries render as a bare timestamp.
function emit(level: Level, msg: string, ctx?: Ctx): void {
  const line = JSON.stringify({
    msg,
    level,
    ts: new Date().toISOString(),
    component: "sidecar",
    ...baseCtx,
    ...(ctx ?? {}),
  })
  if (level === "error") console.error(line)
  else console.log(line)
}

export const log = {
  info: (msg: string, ctx?: Ctx) => emit("info", msg, ctx),
  warn: (msg: string, ctx?: Ctx) => emit("warn", msg, ctx),
  error: (msg: string, ctx?: Ctx) => emit("error", msg, ctx),
  debug: (msg: string, ctx?: Ctx) => emit("debug", msg, ctx),
}
