# cf-worker

Public-facing Cloudflare Worker that gives `opencode` a simple HTTP API for the
"give me a folder + a prompt" use case. Backed by Durable Objects + Containers
(spawning the image from `packages/cf-container`) + R2.

```
client ─HTTPS─▶ Worker (Hono, bearer auth)
                  │
                  ├── R2 (sessions/<id>/<file>)        — file storage
                  │
                  └─DO─▶ OpenCodeSession (Container)   — one per session
                          ├── /workspace ⇄ R2 sync
                          └── opencode serve  + sidecar (port 8080)
```

## Public API

All routes need `Authorization: Bearer <API_KEY>` (the secret you set with
`wrangler secret put API_KEY`). CORS is open.

| Method | Path | Body | Returns |
|---|---|---|---|
| `POST` | `/sessions` | — | `{ id }` |
| `PUT` | `/sessions/:id/files/<path>` | raw bytes | `{ ok, bytes, path }` |
| `GET` | `/sessions/:id/files` | — | `{ files: [{path,size,uploaded}] }` |
| `GET` | `/sessions/:id/files/<path>` | — | file bytes |
| `DELETE` | `/sessions/:id/files/<path>` | — | `{ ok }` |
| `POST` | `/sessions/:id/prompt` | `{ prompt, agent?, model?, title? }` | SSE stream |
| `DELETE` | `/sessions/:id` | — | `{ ok }` (kills container, wipes R2 prefix) |

`POST /sessions/:id/prompt` returns `text/event-stream`. Events are opencode
bus events passed through, plus `done` at the end. After `done`, R2 is updated
with whatever opencode wrote.

Follow-up prompts are just additional `POST /prompt` calls on the same session
id — opencode keeps conversation history server-side.

Concurrent prompts on the same session return `409 Conflict`.

## Typical flow

```sh
API=https://opencode-cf.<your-subdomain>.workers.dev
KEY=<your-API_KEY>
H="Authorization: Bearer $KEY"

# 1. Create a session
SID=$(curl -s -X POST $API/sessions -H "$H" | jq -r .id)

# 2. Upload static files
curl -X PUT "$API/sessions/$SID/files/index.html" -H "$H" \
  -H "Content-Type: text/html" --data-binary @index.html
curl -X PUT "$API/sessions/$SID/files/style.css" -H "$H" \
  -H "Content-Type: text/css" --data-binary @style.css

# 3. Run a prompt (SSE)
curl -N -X POST "$API/sessions/$SID/prompt" -H "$H" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"add a dark-mode toggle to index.html"}'

# 4. Read the modified files back
curl "$API/sessions/$SID/files" -H "$H"
curl "$API/sessions/$SID/files/index.html" -H "$H"

# 5. (optional) Tear down
curl -X DELETE "$API/sessions/$SID" -H "$H"
```

## Secrets

| Secret | What | How |
|---|---|---|
| `API_KEY` | Bearer token clients use to call this worker | `bunx wrangler secret put API_KEY` |
| `SIDECAR_TOKEN` | Bearer token Worker→Container (internal) | `bunx wrangler secret put SIDECAR_TOKEN` |
| `OPENCODE_SERVER_PASSWORD` | opencode's internal HTTP basic auth | `bunx wrangler secret put OPENCODE_SERVER_PASSWORD` |
| `ANTHROPIC_API_KEY` | (or other provider keys) | `bunx wrangler secret put ANTHROPIC_API_KEY` |

Each provider key set on the Worker is automatically forwarded to the container
as an env var by `OpenCodeSession`.

See the repo-root `DEPLOY.md` for the end-to-end deploy walkthrough.
