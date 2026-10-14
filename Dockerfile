FROM node:22.22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --legacy-peer-deps && npm cache clean --force
COPY build/ ./build/
ENV PORT=3000
EXPOSE 3000
# One process serves every client over the SDK's own stateless Streamable HTTP transport (POST /mcp), so the cache
# is shared. Before 10/2026 supergateway wrapped the stdio server and started a process per client session.
USER node
HEALTHCHECK --interval=60s --timeout=5s --start-period=10s CMD wget -qO- http://127.0.0.1:3000/health || exit 1
CMD ["node", "build/index.js", "--http"]
