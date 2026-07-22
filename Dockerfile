FROM node:20-alpine

ENV CHROMIUM_EXECUTABLE=/usr/bin/chromium-browser

WORKDIR /app

COPY package.json ./
RUN apk add --no-cache chromium nss freetype harfbuzz ca-certificates ttf-freefont && npm install

COPY server.js ./
COPY public ./public
COPY data/releaseUrlOverrides.json ./data/releaseUrlOverrides.json

EXPOSE 3050

CMD ["node", "server.js"]

