FROM node:20-alpine

# ffmpeg
RUN apk add --no-cache ffmpeg

WORKDIR /app
COPY package.json ./
RUN npm i --omit=dev

COPY . .
ENV PORT=8080
EXPOSE 8080

CMD ["npm","start"]
