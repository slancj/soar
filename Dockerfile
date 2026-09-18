FROM node:22-alpine

ENV NODE_ENV=production
ARG PNPM_BUILD="pnpm install --frozen-lockfile --prod"
EXPOSE 8080/tcp

LABEL summary="Soar Proxy Image"
LABEL description="Soar web proxy application"

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN apk add --upgrade --no-cache python3 make g++ \
	&& corepack enable \
	&& corepack prepare pnpm@10.18.3 --activate \
	&& $PNPM_BUILD

COPY . .

ENTRYPOINT [ "node" ]
CMD ["src/index.js"]
