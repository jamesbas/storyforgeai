# Multi-stage build producing a self-contained Next.js standalone server image.
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci

FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
ENV NEXT_OUTPUT=standalone
RUN npx prisma generate || true
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# Demo/local mode by default: in-memory store, all integrations off.
ENV STORYFORGE_PERSISTENCE=memory
# Inside a container 0.0.0.0 is the container's own namespace, so the real
# boundary is the publish address on the host — see docker-compose.yml, which
# publishes to 127.0.0.1. The allowlist is set explicitly rather than left at its
# default because the app refuses to bind wider than loopback otherwise.
ENV HOSTNAME=0.0.0.0
ENV STORYFORGE_BIND_HOST=0.0.0.0
ENV STORYFORGE_ALLOWED_HOSTS=localhost,127.0.0.1,[::1]
RUN addgroup -S nodejs && adduser -S nextjs -G nodejs
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
USER nextjs
EXPOSE 3200
ENV PORT=3200
HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3200/api/health || exit 1
CMD ["node", "server.js"]
