# Deployment Guide for Claude Voice Chat

This guide provides detailed instructions for deploying the Claude Voice Chat application to production environments.

## Docker Deployment (Recommended)

Docker provides the most consistent deployment experience across different environments.

### Prerequisites

- Docker (20.10.0+)
- Docker Compose (2.0.0+)
- Git
- A server with at least 1GB RAM and 1 CPU core

### Deployment Steps

1. Clone the repository on your server:
   ```bash
   git clone <repository-url>
   cd claude-voice-chat
   ```

2. Create a `.env` file with your API keys:
   ```bash
   cp .env.example .env
   # Edit the .env file to add your API keys
   nano .env
   ```

3. Build and start the Docker container:
   ```bash
   docker-compose up -d
   ```

4. Verify that the container is running:
   ```bash
   docker-compose ps
   ```

5. Access the application at `http://<your-server-ip>:3000`

### Updating the Application

To update the application to the latest version:

1. Pull the latest changes:
   ```bash
   git pull
   ```

2. Rebuild and restart the container:
   ```bash
   docker-compose down
   docker-compose up -d --build
   ```

### Logs and Troubleshooting

- View application logs:
  ```bash
  docker-compose logs -f
  ```

- Check container status:
  ```bash
  docker-compose ps
  ```

## Standalone Node.js Deployment

If you prefer to run the application without Docker:

### Prerequisites

- Node.js (18.x or later)
- npm (8.x or later)
- Git

### Deployment Steps

1. Clone the repository on your server:
   ```bash
   git clone <repository-url>
   cd claude-voice-chat
   ```

2. Install dependencies:
   ```bash
   npm install --production
   ```

3. Create a `.env` file with your API keys:
   ```bash
   cp .env.example .env
   # Edit the .env file to add your API keys
   nano .env
   ```

4. Start the application:
   ```bash
   npm start
   ```

5. Access the application at `http://<your-server-ip>:3000`

### Running as a Service (Linux)

To keep the application running in the background, you can use a process manager like PM2:

1. Install PM2 globally:
   ```bash
   npm install -g pm2
   ```

2. Start the application with PM2:
   ```bash
   pm2 start src/server.js --name claude-voice-chat
   ```

3. Configure PM2 to start on boot:
   ```bash
   pm2 startup
   pm2 save
   ```

4. View logs:
   ```bash
   pm2 logs claude-voice-chat
   ```

## Nginx Reverse Proxy (Optional)

For production deployments, it's recommended to use Nginx as a reverse proxy:

1. Install Nginx:
   ```bash
   sudo apt update
   sudo apt install nginx
   ```

2. Create an Nginx configuration file:
   ```bash
   sudo nano /etc/nginx/sites-available/claude-voice-chat
   ```

3. Add the following configuration:
   ```nginx
   server {
       listen 80;
       server_name your-domain.com;

       location / {
           proxy_pass http://localhost:3000;
           proxy_http_version 1.1;
           proxy_set_header Upgrade $http_upgrade;
           proxy_set_header Connection 'upgrade';
           proxy_set_header Host $host;
           proxy_cache_bypass $http_upgrade;
       }
   }
   ```

4. Enable the site and restart Nginx:
   ```bash
   sudo ln -s /etc/nginx/sites-available/claude-voice-chat /etc/nginx/sites-enabled/
   sudo nginx -t
   sudo systemctl restart nginx
   ```

5. Set up SSL with Let's Encrypt (optional but recommended):
   ```bash
   sudo apt install certbot python3-certbot-nginx
   sudo certbot --nginx -d your-domain.com
   ```

## Security Considerations

1. **API Keys**: Never expose your API keys. Always use environment variables to store them.

2. **HTTPS**: Use HTTPS to encrypt communications, especially when deploying to a public server.

3. **Access Control**: Consider implementing user authentication if the application is publicly accessible.

4. **Rate Limiting**: Implement rate limiting to prevent abuse of the API services.

## Scaling Considerations

For high-traffic deployments:

1. **Horizontal Scaling**: Run multiple instances of the application behind a load balancer.

2. **Database Integration**: Add a database to store conversation history and user preferences.

3. **Content Delivery Network (CDN)**: Use a CDN to serve static assets.