# --- UI bauen ---------------------------------------------------------------
FROM node:22-alpine AS ui
WORKDIR /ui
COPY ui/package*.json ./
RUN npm ci || npm install
COPY ui/ ./
RUN npm run build

# --- Server bauen -----------------------------------------------------------
FROM node:22-alpine AS server
WORKDIR /server
COPY server/package*.json ./
RUN npm ci || npm install
COPY server/ ./
RUN npm run build

# --- Laufzeit ---------------------------------------------------------------
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production CONFIG_DIR=/config
COPY server/package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev
COPY --from=server /server/dist ./dist
COPY --from=ui /ui/dist ./public
VOLUME ["/config"]
EXPOSE 8080
CMD ["node", "dist/index.js"]
