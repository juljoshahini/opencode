# cf-container

Cloudflare-Containers-ready image that wraps `opencode serve` with a thin HTTP
sidecar. The sidecar exposes a small API to push/pull files into a `/workspace`
directory and forward prompts to opencode, streaming events back as SSE.

This is **Step 1** of the conversion: the container alone, runnable with plain
`docker run`. The Cloudflare Worker + Durable Object glue lives in
`packages/cf-worker` (next step).

## Architecture

```
┌─ Container ────────────────────────────────────┐
│  PID 1: bun src/start.ts (supervisor)          │
│    ├─ child: opencode serve  (127.0.0.1:4096)  │
│    └─ sidecar HTTP server    (0.0.0.0:8080) ──── exposed
│                                                 │
│  /workspace  ← session files live here          │
└─────────────────────────────────────────────────┘
```

Only port `8080` is exposed externally. opencode stays on loopback; the sidecar
mediates all access.

## Sidecar HTTP API (port 8080)

All routes (except `/health`) require `Authorization: Bearer $SIDECAR_TOKEN` if
`SIDECAR_TOKEN` is set in the container env.

| Method | Path | Body | Returns |
|---|---|---|---|
| `GET` | `/health` | — | `{ ok, workspace }` |
| `GET` | `/list` | — | `{ files: string[] }` |
| `GET` | `/fs/<path>` | — | file bytes |
| `PUT` | `/fs/<path>` | raw bytes | `{ ok, bytes }` |
| `DELETE` | `/fs/<path>` | — | `{ ok }` |
| `POST` | `/prompt` | `{ prompt, sessionId?, agent?, model?, title? }` | SSE stream (`x-session-id` header on first response) |
| `DELETE` | `/session/<id>` | — | `{ ok }` |

Path components are URL-encoded; `..` traversal is rejected.

### `/prompt` events

Each line is `event: <type>\ndata: <json>\n\n`. Types:

- `session` — first event, payload `{ id }`
- All opencode bus events (e.g. `message.part.updated`, `session.status`,
  `permission.asked`, `session.error`) passed through verbatim
- `done` — final event, payload `{ sessionId }`
- `error` — payload `{ message }` if something failed

The stream ends when opencode reports the session went `idle`.

Concurrent prompts on the same `sessionId` are rejected with `409`.

## Build

The image bakes in a prebuilt opencode native binary. Build the binaries first:

```sh
bun run --cwd packages/opencode build
```

This produces (among others):
- `packages/opencode/dist/opencode-linux-x64-baseline-musl/bin/opencode`
- `packages/opencode/dist/opencode-linux-arm64-musl/bin/opencode`

Then build the container image (run from the repo root, **not** from this
package — the build context is the repo root):

```sh
docker build -f packages/cf-container/Dockerfile -t opencode-cf .
```

For a non-host architecture, use buildx:

```sh
docker buildx build --platform linux/amd64 -f packages/cf-container/Dockerfile -t opencode-cf .
```

## Run

```sh
docker run --rm -it \
  -p 8080:8080 \
  -e SIDECAR_TOKEN=dev-token \
  -e OPENCODE_SERVER_PASSWORD=dev-password \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  opencode-cf
```

Provider credentials (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc.) flow through
to opencode the same way they do for the CLI.

## Smoke test

In one shell:

```sh
docker run --rm -it -p 8080:8080 \
  -e SIDECAR_TOKEN=dev \
  -e OPENCODE_SERVER_PASSWORD=dev \
  -e ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY \
  opencode-cf
```

In another:

```sh
# 1. Push a static file
curl -X PUT http://localhost:8080/fs/index.html \
  -H "Authorization: Bearer dev" \
  -H "Content-Type: text/html" \
  --data-binary '<h1>Hello</h1>'

# 2. List
curl http://localhost:8080/list -H "Authorization: Bearer dev"

# 3. Run a prompt, stream events
curl -N -X POST http://localhost:8080/prompt \
  -H "Authorization: Bearer dev" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"Add a paragraph greeting the user under the h1 in index.html"}'

# 4. Read the modified file
curl http://localhost:8080/fs/index.html -H "Authorization: Bearer dev"
```

The third call should stream opencode events for several seconds and end with
`event: done`. The fourth call should return the file with the model's edit.

## Environment variables

| Var | Default | Purpose |
|---|---|---|
| `SIDECAR_PORT` | `8080` | Sidecar listen port |
| `SIDECAR_TOKEN` | (unset) | If set, required as `Bearer` for all non-health routes |
| `WORKSPACE_DIR` | `/workspace` | Directory opencode operates on |
| `OPENCODE_HOST` | `127.0.0.1` | Internal opencode bind host |
| `OPENCODE_PORT` | `4096` | Internal opencode bind port |
| `OPENCODE_SERVER_PASSWORD` | (unset) | Password for opencode HTTP basic auth — recommended |
| `OPENCODE_SERVER_USERNAME` | `opencode` | Username for opencode HTTP basic auth |
| Provider keys | — | `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc., per opencode docs |
