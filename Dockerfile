# node 26.12.1-alpine3.24
FROM node:26.12.1-alpine3.24@sha256:40cd011b55415bc894e45b02fdd5a5dfde056921b7d23a64c74f80497af48797 AS build
RUN apk --no-cache upgrade
# node 26 images no longer bundle corepack; strict mode makes it refuse any pnpm other than package.json's packageManager (version and sha512).
ENV COREPACK_ENABLE_STRICT=1
RUN npm install -g corepack@0.36.0 && corepack enable
WORKDIR /app

COPY dsl-log-viewer/package.json dsl-log-viewer/pnpm-lock.yaml dsl-log-viewer/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY dsl-log-viewer/ ./
RUN pnpm run build

# nginx 1.31.6-alpine3.24
FROM nginx:1.31.6-alpine@sha256:df221db836e1754089190208cee7eeda94f233197056426eda74a43ab1abeac2 AS runtime
RUN apk --no-cache upgrade
RUN rm -f /etc/nginx/conf.d/default.conf
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html/

EXPOSE 5900
