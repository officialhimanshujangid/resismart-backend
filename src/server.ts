import app from './app';
import { appConfig } from './config/appConfig';
import { connectDatabase } from './config/db';
import { logger } from './utils/logger.util';

const startServer = async () => {
  // Connect to MongoDB
  await connectDatabase();

  const PORT = appConfig.port;

  app.listen(PORT, () => {
    logger.info(`=========================================`);
    logger.info(` ${appConfig.appName} Server Started Successfully `);
    logger.info(` Port: ${PORT} | Environment: ${appConfig.nodeEnv}`);
    logger.info(`=========================================`);
  });
};

// Handle unhandled rejections and exceptions gracefully
process.on('unhandledRejection', (err: any) => {
  logger.error(`Unhandled Promise Rejection: ${err.message}`);
  if (err.stack) logger.debug(err.stack);
});

process.on('uncaughtException', (err: any) => {
  logger.error(`Uncaught Exception: ${err.message}`);
  if (err.stack) logger.debug(err.stack);
  process.exit(1);
});

startServer();
