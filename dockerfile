# Use official Node.js LTS version
FROM node:18-alpine

# Create and set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install only production dependencies
RUN npm ci --only=production

# Copy the rest of your backend source code
COPY . .

# Expose the backend API port
EXPOSE 5000

CMD ["node", "index.js"]
