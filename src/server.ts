import http from 'http';
import app from './app';
import { config } from './config';
import { initializeSocketIO } from './socket';
import prisma from './lib/prisma';

const server = http.createServer(app);

// Initialize Socket.IO for real-time features
initializeSocketIO(server);

// Ensure uploads directory exists
import fs from 'fs';
import path from 'path';
const uploadsDir = path.join(__dirname, '../uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Start server
async function main() {
  try {
    await prisma.$connect();
    console.log('✓ Database connected');

    server.listen(config.port, () => {
      console.log(`✓ Server running on port ${config.port}`);
      console.log(`  Environment: ${config.env}`);
      console.log(`  API: http://localhost:${config.port}/api`);
      console.log(`  Health: http://localhost:${config.port}/api/health`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received. Shutting down...');
  server.close();
  await prisma.$disconnect();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('SIGINT received. Shutting down...');
  server.close();
  await prisma.$disconnect();
  process.exit(0);
});

main();
