# Font Potato — deployable web server (Linux).
# The Mac app runs this same server.js locally; this image runs it on a host.
FROM node:20-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production
# Hosts (Render/Fly/Railway) inject PORT; default for local docker run.
ENV PORT=8080
# Persist uploads/output/specimens/shares on a mounted volume.
ENV DYF_DATA_DIR=/data

# Install deps fresh so native modules (sharp) get the Linux build, not the
# macOS binaries from the dev machine (node_modules is .dockerignore'd).
COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY . .
RUN mkdir -p /data
EXPOSE 8080
CMD ["node", "server.js"]
