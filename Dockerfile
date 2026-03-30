FROM node:20-alpine
RUN apk add --no-cache openssl
RUN npm install -g pnpm

EXPOSE 3000

WORKDIR /app

COPY package.json pnpm-lock.yaml ./

RUN pnpm install --frozen-lockfile

COPY . .

RUN pnpm run build

RUN pnpm prune --prod

ENV NODE_ENV=production

CMD ["pnpm", "run", "docker-start"]
