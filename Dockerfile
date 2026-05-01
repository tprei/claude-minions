# syntax=docker/dockerfile:1.7

# ----- builder ----------------------------------------------------------------
FROM node:22-bookworm-slim AS builder
WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends git python3 build-essential ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/engine/package.json packages/engine/
COPY packages/web/package.json    packages/web/

RUN pnpm install --frozen-lockfile

COPY packages/shared ./packages/shared
COPY packages/engine ./packages/engine
COPY packages/web    ./packages/web

RUN pnpm --filter @minions/shared run build \
 && pnpm --filter @minions/engine run build \
 && pnpm --filter @minions/web    run build

# ----- runtime ----------------------------------------------------------------
# MINIONS_TOKEN must be injected at runtime (compose env_file or `docker run -e`).
# Never bake into the image. The /api/health endpoint is public; all other /api routes
# require the token via Authorization: Bearer or ?token= query for SSE.
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates openssh-client tini curl gnupg \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | gpg --dearmor -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && chmod 644 /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends gh \
 && apt-get purge -y --auto-remove gnupg \
 && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

# claude CLI for the claude-code provider
RUN npm i -g @anthropic-ai/claude-code

COPY --from=builder /app/pnpm-workspace.yaml /app/pnpm-lock.yaml /app/package.json ./
COPY --from=builder /app/packages/shared/package.json packages/shared/
COPY --from=builder /app/packages/engine/package.json packages/engine/
COPY --from=builder /app/packages/web/package.json    packages/web/
COPY --from=builder /app/packages/shared/dist         packages/shared/dist
COPY --from=builder /app/packages/engine/dist         packages/engine/dist
COPY --from=builder /app/packages/web/dist            packages/web/dist

RUN pnpm install --prod --frozen-lockfile

# Non-root user: claude-code refuses --dangerously-skip-permissions when running as root.
RUN useradd -u 10001 -m -s /bin/bash minion \
 && mkdir -p /data/workspace /data/home \
 && chown -R minion:minion /app /data
USER minion
ENV HOME=/data/home

EXPOSE 8787

ENV MINIONS_PORT=8787 \
    MINIONS_HOST=0.0.0.0 \
    MINIONS_WORKSPACE=/data/workspace \
    MINIONS_SERVE_WEB=true \
    MINIONS_WEB_DIST=/app/packages/web/dist

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+process.env.MINIONS_PORT+'/api/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

ENTRYPOINT ["tini","--"]
CMD ["node","packages/engine/dist/cli.js"]
