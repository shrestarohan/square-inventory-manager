FROM node:22-alpine

WORKDIR /usr/src/app

# Install deps first (layer cache friendly)
COPY package*.json ./
RUN npm ci --omit=dev

# Copy app code
COPY . .

# Ensure scripts exist & are executable (optional but safe)
RUN chmod +x bin/*.sh || true

# Cloud Run sets PORT; don't hardcode it
EXPOSE 8080

# Start the web server
CMD ["npm", "start"]