# Single-image deploy: build the frontend, then serve it and the API from one
# origin so the SSE stream never crosses an origin boundary.
FROM node:20-alpine AS build
WORKDIR /app
COPY web/package*.json ./web/
RUN cd web && npm ci --no-audit --no-fund
COPY web ./web
RUN cd web && npm run build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY server/package*.json ./server/
RUN cd server && npm ci --omit=dev --no-audit --no-fund
COPY server ./server
COPY --from=build /app/web/dist ./web/dist
ENV PORT=8787
ENV DATA_DIR=/app/data
EXPOSE 8787
CMD ["node", "server/src/index.js"]
