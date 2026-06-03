# Do not use alpine base image for gramjs: https://github.com/gram-js/gramjs/issues/637
# Alpine uses musl libc which breaks GramJS's MTProto Diffie-Hellman key exchange
FROM node:22-slim AS base

RUN apt-get update -y && apt-get install -y openssl python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./

RUN npm install

COPY tsconfig.json ./
COPY drizzle.config.ts ./
COPY src ./src
COPY drizzle ./drizzle

RUN npm run build

# Dev target — keeps all dependencies (including drizzle-kit)
FROM base AS dev

EXPOSE 3000
CMD ["node", "dist/server.js"]

# Production target — prunes dev dependencies
FROM base AS production

RUN npm prune --omit=dev && npm cache clean --force

ENV NODE_ENV=production

EXPOSE 3000
CMD ["node", "dist/server.js"]
