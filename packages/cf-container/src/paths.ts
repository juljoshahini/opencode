import path from "node:path"

export const WORKSPACE = process.env.WORKSPACE_DIR ?? "/workspace"

export class PathError extends Error {}

export function resolveSafe(rel: string): string {
  const cleaned = rel.replace(/^\/+/, "")
  if (!cleaned) throw new PathError("empty path")
  const abs = path.resolve(WORKSPACE, cleaned)
  if (abs !== WORKSPACE && !abs.startsWith(WORKSPACE + path.sep)) {
    throw new PathError(`path escapes workspace: ${rel}`)
  }
  return abs
}

export function relTo(abs: string): string {
  return path.relative(WORKSPACE, abs).split(path.sep).join("/")
}
