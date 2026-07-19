FROM node:22-slim AS frontend-builder

WORKDIR /app

COPY package.json package-lock.json ./
COPY frontend/package.json frontend/package-lock.json ./frontend/
COPY frontend/ ./frontend/

RUN cd frontend && npm ci && npm run build

FROM node:22-slim AS backend-deps

WORKDIR /app/backend

# better-sqlite3 需要在安装阶段使用 python3、make、g++
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY backend/package.json backend/package-lock.json ./

RUN npm ci --omit=dev \
  && apt-get purge -y --auto-remove python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

FROM node:22-slim AS production

WORKDIR /app

ARG APP_VERSION=1.5.1

ENV NODE_ENV=production \
    APP_VERSION=${APP_VERSION}

COPY backend/ ./backend/
COPY --from=backend-deps /app/backend/node_modules/ ./backend/node_modules/
COPY --from=frontend-builder /app/frontend/out/ ./frontend/out/

RUN mkdir -p /app/backend/data

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD node -e "fetch('http://127.0.0.1:3001/api/flyreq/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "backend/server.js"]
