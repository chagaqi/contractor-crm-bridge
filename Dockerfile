# Build stage: bundle the gateway into one file.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages ./packages
RUN npm ci && npm run build

# Runtime stage: the bundle has zero npm dependencies.
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8787
COPY --from=build /app/packages/gateway/dist/server.mjs ./server.mjs
USER node
EXPOSE 8787
CMD ["node", "server.mjs"]
