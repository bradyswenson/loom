FROM node:20-slim

# Install minimal dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files first (better layer caching)
COPY package.json package-lock.json* ./
RUN npm install --production=false

# Copy source and doctrine
COPY tsconfig.json ./
COPY src ./src
COPY doctrine ./doctrine

# Build TypeScript
RUN npm run build

# Remove dev dependencies
RUN npm prune --production

ENV NODE_ENV=production
EXPOSE 3000

CMD ["npm", "run", "start"]
