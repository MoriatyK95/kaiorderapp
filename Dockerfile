FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY vite.config.js ./
COPY client ./client
RUN npm run build

FROM node:24-bookworm-slim AS production-dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY server ./server
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3000
CMD ["node", "server/index.js"]
