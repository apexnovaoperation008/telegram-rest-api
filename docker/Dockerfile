# Do not use alpine base image for gramjs: https://github.com/gram-js/gramjs/issues/637
# Alpine uses musl libc which breaks GramJS's MTProto Diffie-Hellman key exchange

# ─── Development ─────────────────────────────────────────────────────────────
FROM node:22-slim AS development

RUN apt-get update -y && apt-get install -y openssl python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
COPY prisma ./prisma

RUN npm install

COPY tsconfig.json ./
COPY src ./src

EXPOSE 3000

CMD ["npm", "run", "dev"]

# ─── Production ───────────────────────────────────────────────────────────────
FROM node:22-slim AS production

RUN apt-get update -y && apt-get install -y openssl python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
COPY prisma ./prisma

RUN npm install

COPY tsconfig.json ./
COPY src ./src

RUN npm run build; npm prune --omit=dev && npm cache clean --force

ENV NODE_ENV=production

EXPOSE 3000

CMD ["node", "dist/server.js"]
