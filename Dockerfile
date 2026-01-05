FROM node:22-alpine

WORKDIR /app

# Install deps first (layer cache friendly)
COPY package*.json ./
RUN npm install --production

# Copy app code
COPY . .

# Ensure scripts exist & are executable (optional but safe)
RUN chmod +x bin/*.sh || true

ENV PORT=8080
