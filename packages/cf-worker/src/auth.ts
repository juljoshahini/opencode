import type { MiddlewareHandler } from "hono"
import type { Env } from "./env"

export const bearerAuth = (): MiddlewareHandler<{ Bindings: Env }> => async (c, next) => {
  const expected = c.env.API_KEY
  if (!expected) {
    return c.json({ error: "API_KEY not configured on Worker" }, 500)
  }
  const got = c.req.header("authorization")
  if (got !== `Bearer ${expected}`) {
    return c.json({ error: "unauthorized" }, 401)
  }
  await next()
}
