FROM node:20-alpine AS build
WORKDIR /app

COPY dsl-log-viewer/package.json dsl-log-viewer/package-lock.json ./
RUN npm ci

COPY dsl-log-viewer/ ./
RUN npm run build

FROM nginx:alpine AS runtime
RUN rm -f /etc/nginx/conf.d/default.conf
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html/

EXPOSE 5900
