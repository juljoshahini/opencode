# Build context: this directory (packages/cf-container/).
# Build with:   docker build -t opencode-cf packages/cf-container
#
# The opencode binary is downloaded from anomalyco/opencode GitHub releases
# at image-build time. Override OPENCODE_VERSION to pin a different version.

ARG OPENCODE_VERSION=1.14.41

FROM oven/bun:1-alpine AS base
ARG BUN_RUNTIME_TRANSPILER_CACHE_PATH=0
ENV BUN_RUNTIME_TRANSPILER_CACHE_PATH=${BUN_RUNTIME_TRANSPILER_CACHE_PATH}
RUN apk add --no-cache libgcc libstdc++ ripgrep tini ca-certificates curl tar

FROM base AS bin-amd64
ARG OPENCODE_VERSION
RUN curl -fsSL -o /tmp/opencode.tar.gz \
    "https://github.com/anomalyco/opencode/releases/download/v${OPENCODE_VERSION}/opencode-linux-x64-baseline-musl.tar.gz" \
 && tar -xzf /tmp/opencode.tar.gz -C /tmp \
 && find /tmp -type f -name opencode -executable -exec mv {} /usr/local/bin/opencode \; \
 && rm -rf /tmp/opencode.tar.gz \
 && chmod +x /usr/local/bin/opencode

FROM base AS bin-arm64
ARG OPENCODE_VERSION
RUN curl -fsSL -o /tmp/opencode.tar.gz \
    "https://github.com/anomalyco/opencode/releases/download/v${OPENCODE_VERSION}/opencode-linux-arm64-musl.tar.gz" \
 && tar -xzf /tmp/opencode.tar.gz -C /tmp \
 && find /tmp -type f -name opencode -executable -exec mv {} /usr/local/bin/opencode \; \
 && rm -rf /tmp/opencode.tar.gz \
 && chmod +x /usr/local/bin/opencode

ARG TARGETARCH
FROM bin-${TARGETARCH} AS final
RUN opencode --version

WORKDIR /app
COPY package.json ./package.json
COPY tsconfig.json ./tsconfig.json
COPY src ./src

RUN mkdir -p /workspace
ENV WORKSPACE_DIR=/workspace
ENV OPENCODE_HOST=127.0.0.1
ENV OPENCODE_PORT=4096
ENV SIDECAR_PORT=8080
EXPOSE 8080

ENTRYPOINT ["/sbin/tini", "--", "bun", "run", "src/start.ts"]
