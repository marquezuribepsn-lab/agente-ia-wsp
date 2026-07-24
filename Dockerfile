FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci --ignore-scripts

FROM node:22-bookworm-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build
RUN npm prune --omit=dev --ignore-scripts

FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production

# Chromium del sistema para whatsapp-web.js/Puppeteer — más liviano y
# confiable en Docker que dejar que Puppeteer baje su propio binario.
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    fonts-liberation \
    && rm -rf /var/lib/apt/lists/*
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

COPY --from=builder /app ./
EXPOSE 3000
CMD ["npm", "run", "start:all"]
