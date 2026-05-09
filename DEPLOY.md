# Deploy `opencode-cf` to Cloudflare

End-to-end deploy of the Worker + Durable Object + Container + R2.
Assumes you already have a **Workers Paid** plan.

## What you need locally

- Bun 1.3.13+ (the repo's package manager)
- Docker Desktop running (wrangler shells out to it to build the container image)
- A Cloudflare account ID handy (right sidebar of the Cloudflare dashboard)
- At least one provider API key (e.g. `ANTHROPIC_API_KEY`)

## One-time setup

```sh
# 1. Install deps (from repo root)
bun install

# 2. Auth wrangler — opens a browser
bunx wrangler login

# 3. Create the R2 bucket (skip if you already have one — match the name in wrangler.jsonc)
bunx wrangler r2 bucket create opencode-test

# 4. Set the secrets (you'll be prompted for each value)
bunx wrangler secret put API_KEY                  # any random string; clients use this as Bearer token
bunx wrangler secret put SIDECAR_TOKEN            # any random string; internal worker→container auth
bunx wrangler secret put OPENCODE_SERVER_PASSWORD # any random string; opencode internal auth
bunx wrangler secret put ANTHROPIC_API_KEY        # your provider key (repeat for OPENAI_API_KEY, etc.)
```

Generate random tokens with:

```sh
# bash / git-bash
openssl rand -hex 32
# powershell
-join ((48..57)+(97..122) | Get-Random -Count 64 | % {[char]$_})
```

## Deploy

```sh
# From repo root
bun run cf:deploy
```

`cf:deploy` invokes `wrangler deploy`, which:
1. Builds the container image — the Dockerfile downloads the opencode linux-musl
   binary from GitHub releases (`anomalyco/opencode` v1.14.41 by default; override
   with `--build-arg OPENCODE_VERSION=...`).
2. Pushes the image to Cloudflare's managed registry.
3. Deploys the Worker + Durable Object migration.

First deploy takes ~5–10 minutes (image build + push). Subsequent deploys are
faster (layer cache).

When it finishes, wrangler prints a URL like
`https://opencode-cf.<your-subdomain>.workers.dev`. That's your API endpoint.

## Smoke-test the deployment

```sh
API=https://opencode-cf.<your-subdomain>.workers.dev
KEY=<the API_KEY you set>

# Create a session
SID=$(curl -s -X POST $API/sessions -H "Authorization: Bearer $KEY" | jq -r .id)
echo "session: $SID"

# Upload a tiny html file
curl -X PUT "$API/sessions/$SID/files/index.html" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: text/html" \
  --data-binary '<!doctype html><h1>Hello</h1>'

# Run a prompt — should stream events for ~30s and end with `event: done`
curl -N -X POST "$API/sessions/$SID/prompt" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"Under the h1 in index.html add a paragraph saying hello to the world."}'

# Read it back
curl "$API/sessions/$SID/files/index.html" -H "Authorization: Bearer $KEY"
```

Tail logs in another shell while you're testing:

```sh
bun run cf:tail
```

## Common issues

**`Error: Insufficient resources for instance_type "standard"`**
Lower `instance_type` to `basic` in `wrangler.jsonc` and redeploy.

**`opencode --version` fails during image build**
The prebuild step didn't produce a binary for your build platform. Check
`packages/opencode/dist/`. If you're on Windows or macOS but pushing a linux
image, that's expected — wrangler buildx will produce a linux image regardless.

**Prompt streams `error` immediately**
Your provider key isn't set or isn't getting into the container. Verify with:
```sh
bunx wrangler secret list
```
Then redeploy after `wrangler secret put ANTHROPIC_API_KEY` (or whichever key
matches the model you're invoking).

**Session times out / container falls asleep mid-run**
`sleepAfter` is `10m`. Long-running prompts stay alive thanks to opencode's
heartbeat events. If you genuinely need longer single prompts, raise it in
`packages/cf-worker/src/session.ts`.

## Tear down

```sh
bunx wrangler delete                  # removes the worker
bunx wrangler r2 bucket delete opencode-test  # removes file storage (must be empty)
```
