FROM node:20-alpine
RUN apk add --no-cache openssl
RUN npm install -g pnpm

EXPOSE 3000

WORKDIR /app

ENV NODE_ENV=production

COPY package.json pnpm-lock.yaml ./

RUN pnpm install --frozen-lockfile --prod

COPY . .

RUN pnpm run build

CMD ["pnpm", "run", "docker-start"]
