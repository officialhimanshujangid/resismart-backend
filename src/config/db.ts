import mongoose from 'mongoose';
import { appConfig } from './appConfig';
import { logger } from '../utils/logger.util';

export const connectDatabase = async (): Promise<void> => {
  try {
    const conn = await mongoose.connect(appConfig.mongoUri, {
      autoIndex: true, // Automatically build indexes for schema definitions
    });
    logger.info(`MongoDB Connected: ${conn.connection.host}`);
  } catch (error: any) {
    logger.error(`Database connection error: ${error.message}`);
    process.exit(1);
  }
};
