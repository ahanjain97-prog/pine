FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY public ./public
COPY seed ./seed

# The database lives on a Railway volume mounted at /app/data.
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]
