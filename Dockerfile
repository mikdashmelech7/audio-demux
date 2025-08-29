# Node + FFmpeg
FROM node:20-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev
COPY . .

ENV PORT=8000
EXPOSE 8000
CMD ["npm","start"]
