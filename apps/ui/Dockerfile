FROM node:24-alpine AS builder
WORKDIR /app

COPY package.json tsconfig.base.json ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/ui/package.json ./apps/ui/
RUN npm install --workspaces --if-present

COPY packages/shared ./packages/shared
RUN npm run build --workspace=packages/shared

COPY apps/ui ./apps/ui
ARG VITE_API_BASE_URL=
ARG VITE_SOCKET_URL=
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
ENV VITE_SOCKET_URL=$VITE_SOCKET_URL
RUN npm run build --workspace=apps/ui

FROM nginx:alpine AS runner
COPY --from=builder /app/apps/ui/dist /usr/share/nginx/html
COPY apps/ui/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
