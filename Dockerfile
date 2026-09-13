FROM node:26-bookworm-slim@sha256:cd9f682fa2885cd1056e830424764158570061c59736a1da836bc3d73df095ae AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build:server

FROM node:26-bookworm-slim@sha256:cd9f682fa2885cd1056e830424764158570061c59736a1da836bc3d73df095ae AS runtime
LABEL org.opencontainers.image.source="https://github.com/zhoupeixian/zherp-svn-review-portal" \
      org.opencontainers.image.licenses="MIT"
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORTAL_DATA_DIR=/data \
    PORTAL_BIND_ADDRESS=0.0.0.0 \
    PORTAL_SERVER_ENTRY=server.js
COPY --from=build --chown=node:node /app/.next-server/standalone ./
COPY --chown=node:node LICENSE ./LICENSE
COPY --chown=node:node scripts/start-server.mjs scripts/backup-server.mjs scripts/restore-server.mjs ./scripts/
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "scripts/start-server.mjs"]
