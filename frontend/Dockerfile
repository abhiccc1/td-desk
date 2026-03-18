FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --legacy-peer-deps

FROM deps AS builder
COPY . .
RUN npm run build

FROM nginx:alpine AS prod
COPY --from=builder /app/out /usr/share/nginx/html
EXPOSE 80
