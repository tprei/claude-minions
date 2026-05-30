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

# shared needs a build step (tsc outputs to dist); engine runs via tsx at
# runtime so no compile step needed here; web is bundled by vite.
RUN pnpm --filter @minions/shared run build \
 && pnpm --filter @minions/web    run build

# ----- runtime ----------------------------------------------------------------
# MWF_TOKEN must be injected at runtime (compose env_file or `docker run -e`).
# Never bake into the image. The /health endpoint is public; protected API
# routes require the token via Authorization: Bearer or ?token= query for SSE.
# When MWF_SITE_TOKEN_AUTH=1, the built PWA is gated behind the same token.
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates openssh-client tini curl gnupg tmux \
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

# native Codex CLI for the codex provider
RUN npm i -g @openai/codex@0.135.0

# pi CLI for the pi provider (ChatGPT Codex subscription auth). Pinned for
# reproducible builds; bump deliberately when upgrading. The package was renamed
# from @mariozechner/pi-coding-agent and the old name is deprecated.
RUN npm i -g @earendil-works/pi-coding-agent@0.74.0

COPY --from=builder /app/pnpm-workspace.yaml /app/pnpm-lock.yaml /app/package.json ./
COPY --from=builder /app/packages/shared/package.json packages/shared/
COPY --from=builder /app/packages/engine/package.json packages/engine/
COPY --from=builder /app/packages/web/package.json    packages/web/
COPY --from=builder /app/packages/shared/dist         packages/shared/dist
# engine runs from source via tsx; copy the full src tree
COPY --from=builder /app/packages/engine/src          packages/engine/src
COPY --from=builder /app/packages/web/dist            packages/web/dist

RUN pnpm install --prod --frozen-lockfile

# Non-root user: claude-code refuses --dangerously-skip-permissions when running as root.
# UID/GID default to a high range for prod; dev compose overrides to match the host user
# so bind-mounting ~/.claude shares tokens between host and container (rotations stay in sync).
ARG MINION_UID=10001
ARG MINION_GID=10001
# Drop the base image's `node` user (UID 1000) if we'd collide with it.
RUN if getent passwd $MINION_UID >/dev/null; then userdel -r "$(getent passwd $MINION_UID | cut -d: -f1)"; fi \
 && if getent group $MINION_GID >/dev/null; then groupdel "$(getent group $MINION_GID | cut -d: -f1)"; fi \
 && groupadd -g $MINION_GID minion \
 && useradd -u $MINION_UID -g $MINION_GID -m -s /bin/bash minion \
 && mkdir -p /data/workspace /data/home \
 && chown -R minion:minion /app /data
USER minion
ENV HOME=/data/home

EXPOSE 8787

ENV MWF_PORT=8787 \
    MWF_DB_PATH=/data/engine.db \
    MWF_DATA_DIR=/data/sessions \
    MWF_WORKSPACE_ROOT=/data/workspace \
    MWF_PWA_DIR=/app/packages/web/dist

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+process.env.MWF_PORT+'/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

ENTRYPOINT ["tini","--"]
CMD ["pnpm","--filter","@minions/engine","exec","tsx","src/main.ts"]
