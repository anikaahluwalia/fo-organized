# Kiki online. The server runs TypeScript natively on Node 24 (no build step); only the web app is
# built. Secrets come from the host's environment variables, never from this image.
FROM node:24-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npx vite build && npm prune --omit=dev
ENV NODE_ENV=production
# Kiki's database lives here: mount a persistent volume at /data.
ENV DATA_DIR=/data
EXPOSE 8787
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.ts"]
