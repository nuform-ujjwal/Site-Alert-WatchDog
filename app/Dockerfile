FROM node:20-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends whois ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY src ./src
COPY public ./public
ENV NODE_ENV=production
EXPOSE 3001
CMD ["node", "src/server.js"]
