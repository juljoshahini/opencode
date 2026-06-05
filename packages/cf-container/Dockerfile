# Build context: repo root (set via wrangler.jsonc image_build_context = "../../").
# Multi-stage: stage 1 compiles the opencode binary from source so local edits
# (e.g. new tools in packages/opencode/src/tool/) are baked in. Stage 2 is the
# slim runtime that ships to Cloudflare Containers.

FROM oven/bun:1-slim AS builder
ARG BUN_RUNTIME_TRANSPILER_CACHE_PATH=0
ENV BUN_RUNTIME_TRANSPILER_CACHE_PATH=${BUN_RUNTIME_TRANSPILER_CACHE_PATH}

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      python3 make g++ git build-essential ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /repo
COPY . .

# Postinstall scripts are skipped — opencode's HTTP server doesn't need the
# native node-pty / parcel watcher binaries that those scripts compile.
RUN bun install --ignore-scripts

# OPENCODE_CHANNEL bypasses the build's `git branch` query (no .git in context).
# OPENCODE_VERSION pins the binary version string so we don't depend on npm.
ENV OPENCODE_CHANNEL=latest
ENV OPENCODE_VERSION=1.14.42-cf

# Single linux-x64-baseline (glibc) binary, no embedded web UI (we don't expose
# the local /web route through the worker).
RUN bun run --cwd packages/opencode build --single --baseline --skip-embed-web-ui

# ---
FROM oven/bun:1-slim AS runtime
ARG BUN_RUNTIME_TRANSPILER_CACHE_PATH=0
ENV BUN_RUNTIME_TRANSPILER_CACHE_PATH=${BUN_RUNTIME_TRANSPILER_CACHE_PATH}

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ripgrep tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY --from=builder /repo/packages/opencode/dist/opencode-linux-x64-baseline/bin/opencode /usr/local/bin/opencode
RUN /usr/local/bin/opencode --version

WORKDIR /app
COPY packages/cf-container/package.json ./package.json
COPY packages/cf-container/tsconfig.json ./tsconfig.json
COPY packages/cf-container/src ./src

# Sidecar deps (photon-node WASM for image resizing). --production skips devDeps,
# --ignore-scripts skips native postinstalls we don't need for the HTTP sidecar.
RUN bun install --production --ignore-scripts

RUN mkdir -p /workspace
ENV WORKSPACE_DIR=/workspace
ENV OPENCODE_HOST=127.0.0.1
ENV OPENCODE_PORT=4096
ENV SIDECAR_PORT=8080
EXPOSE 8080

ENTRYPOINT ["/usr/bin/tini", "--", "bun", "run", "src/start.ts"]
