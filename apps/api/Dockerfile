FROM node:24-alpine AS base
WORKDIR /app
RUN apk add --no-cache git openssl

# Install deps
COPY package.json tsconfig.base.json ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/api/package.json ./apps/api/
RUN npm install --workspaces --if-present

# Build shared
COPY packages/shared ./packages/shared
RUN npm run build --workspace=packages/shared

# Build API
COPY apps/api ./apps/api
RUN npm exec -- prisma generate --schema=apps/api/prisma/schema.prisma
RUN npm run build --workspace=apps/api

FROM node:24-alpine AS runner
WORKDIR /app
RUN apk add --no-cache git openssl
COPY --from=base /app/node_modules ./node_modules
COPY --from=base /app/packages ./packages
COPY --from=base /app/apps/api ./apps/api
COPY apps/api/prisma ./apps/api/prisma

WORKDIR /app
ENV NODE_ENV=production
EXPOSE 4000
CMD ["sh", "-c", "npm exec -- prisma db push --schema=apps/api/prisma/schema.prisma --accept-data-loss && node apps/api/dist/index.js"]
