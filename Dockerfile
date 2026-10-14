# syntax=docker/dockerfile:1

# Build stage: compile TypeScript with the dev dependencies, then drop them.
FROM node:26.11-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --legacy-peer-deps
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build && npm prune --omit=dev --legacy-peer-deps

# Runtime stage: Node, production dependencies and the compiled server only.
# npm, npx and corepack are removed: the server does not use them at runtime, and their bundled dependencies were the
# only JavaScript findings in an image scan. Alpine packages are upgraded at build time to pick up OS security fixes.
FROM node:26.11-alpine
RUN apk upgrade --no-cache \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-*
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/build ./build
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
# One process serves every client over the SDK's own stateless Streamable HTTP transport (POST /mcp), so the cache
# is shared.
USER node
HEALTHCHECK --interval=60s --timeout=5s --start-period=10s CMD wget -qO- http://127.0.0.1:3000/health || exit 1
CMD ["node", "build/index.js", "--http"]
