FROM node:18-slim

# Create app directory
WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm install

# Copy app source code
COPY . .
COPY .env.example .

# Create required directories
RUN mkdir -p logs recordings

# Expose the port the app runs on
EXPOSE 3000

# Command to run the app
CMD ["npm", "start"]