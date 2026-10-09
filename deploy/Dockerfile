# Self-hosted Kiwi Channels relay: the same process as `bun src/relay/bun.ts`.
# TLS stays in front of this container (see deploy/Caddyfile). Inside the
# container the relay binds every interface, so a published port can reach it.
FROM oven/bun:1.4.2

WORKDIR /app

# Deps before source, so a source-only change does not reinstall.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY src ./src

# One sqlite file per room, plus the people directory. Kept across restarts.
ENV KIWI_DATA=/data
ENV PORT=8787
VOLUME /data
EXPOSE 8787

# No dashboard in this image. Sign-in and quotas stay off unless WORKOS_* and
# KIWI_* are set in the environment (same keys as wrangler.jsonc).
ENTRYPOINT ["bun", "src/relay/bun.ts"]
CMD ["--hostname", "0.0.0.0", "--port", "8787", "--data", "/data", "--no-web"]
