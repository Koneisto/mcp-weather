FROM node:22.22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm install --legacy-peer-deps
COPY build/ ./build/
RUN npm install -g supergateway
EXPOSE 3000
CMD ["supergateway", "--stdio", "node /app/build/index.js", "--port", "3000", "--outputTransport", "streamableHttp"]
