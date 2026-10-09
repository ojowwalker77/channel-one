# Self-hosted Kiwi Channels relay: the same process as `bun src/relay/bun.ts`.
# TLS stays in front of this container (see deploy/Caddyfile). Inside the
# container the relay binds every interface, so a published port can reach it.

# The dashboard is built here and copied into the runtime image. The relay
# serves web/dist on its own (src/relay sits next to web/).
FROM oven/bun:1.4.2 AS build
WORKDIR /app
COPY package.json bun.lock ./
# The dashboard imports the relay client through the @mc alias, which is ../src.
COPY src ./src
COPY web ./web
RUN bun install --frozen-lockfile && bun run web:build

FROM oven/bun:1.4.2
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY src ./src
COPY --from=build /app/web/dist ./web/dist

# Room files must be owned by the runtime user, not root. /data is created
# before VOLUME so the named volume inherits this ownership.
RUN mkdir -p /data && chown bun:bun /data
ENV PORT=8787
VOLUME /data
EXPOSE 8787
USER bun

# Sign-in and quotas stay off unless WORKOS_* and KIWI_* are set in the
# environment (same keys as wrangler.jsonc).
ENTRYPOINT ["bun", "src/relay/bun.ts"]
CMD ["--hostname", "0.0.0.0", "--port", "8787", "--data", "/data"]
