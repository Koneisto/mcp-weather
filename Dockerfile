# syntax=docker/dockerfile:1

# Build stage: typecheck, bundle and generate the production dependency SBOM.
FROM node:22.23-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --legacy-peer-deps
COPY tsconfig.json ./
COPY src/ ./src/
COPY scripts/ ./scripts/
RUN npm run build && npm run sbom

# Runtime: retain the official Node binary, but leave npm, headers and build tooling behind.
# Its musl runtime dependencies are libstdc++/libgcc (also verified by the container tests).
FROM alpine:3.24.3@sha256:be2656061b536c1883c4034790e21d0a09c5aaaf51968b89368a3c0371ea2c9a
RUN apk add --no-cache libstdc++ ca-certificates \
 && apk upgrade --no-cache \
 && addgroup -g 1000 node \
 && adduser -u 1000 -G node -s /bin/sh -D node \
 && mkdir -p /var/lib/mcp-weather \
 && chown node:node /var/lib/mcp-weather \
 && chmod 700 /var/lib/mcp-weather
COPY --from=build /usr/local/bin/node /usr/local/bin/node
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/build/weather.mjs ./weather.mjs
COPY --from=build /app/build/sbom.cdx.json ./sbom.cdx.json
ARG VCS_REF=unknown
LABEL org.opencontainers.image.source="https://github.com/Koneisto/mcp-weather" \
      org.opencontainers.image.version="1.6.0" \
      org.opencontainers.image.revision=$VCS_REF
ENV NODE_ENV=production PORT=3000 HOST=0.0.0.0 MCP_STATE_DIR=/var/lib/mcp-weather
EXPOSE 3000
# One process serves every client over the SDK's own stateless Streamable HTTP transport (POST /mcp), so the cache
# is shared.
USER node
HEALTHCHECK --interval=60s --timeout=5s --start-period=10s CMD wget -qO- http://127.0.0.1:3000/health || exit 1
CMD ["node", "weather.mjs", "--http"]
