# syntax=docker/dockerfile:1

# Build stage: full dev dependencies + TypeScript compiler.
# The `migrate` compose service targets this stage so it can run
# node-pg-migrate, which is a devDependency.
FROM node:24-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY migrations ./migrations
RUN npm run build

# Runtime stage: production dependencies + compiled output only.
FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist
COPY public ./public
COPY migrations ./migrations

EXPOSE 3000
USER node

CMD ["node", "dist/api.js"]
