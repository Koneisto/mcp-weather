# syntax=docker/dockerfile:1

# Build stage: typecheck, bundle and generate the production dependency SBOM.
FROM node:26.12-alpine@sha256:6f08a523443ddedf52941874c203475b0ad503e859ad70cb26ab8be9a517dbd5 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --legacy-peer-deps
COPY tsconfig.json ./
COPY src/ ./src/
COPY scripts/ ./scripts/
RUN npm run build && npm run sbom

# Runtime: retain the official Node binary, but leave npm, headers and build tooling behind.
# Its musl runtime dependencies are libstdc++/libgcc (also verified by the container tests).
FROM alpine:3.24.2@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6
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
