import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger.util';

export const errorHandler = (
  err: any,
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  const status = err.status || 500;
  const message = err.message || 'Internal Server Error';

  logger.error(`[${req.method}] ${req.path} - Status: ${status} - Error: ${message}`);
  
  if (process.env.NODE_ENV !== 'production' && err.stack) {
    logger.debug(err.stack);
  }

  res.status(status).json({
    error: message,
    ...(process.env.NODE_ENV !== 'production' && { stack: err.stack }),
  });
};
export default errorHandler;
