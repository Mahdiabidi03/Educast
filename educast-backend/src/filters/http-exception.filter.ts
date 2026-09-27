import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

/**
 * Global HTTP exception filter.
 * Returns a consistent JSON envelope for every error, including
 * Multer-specific ones (file size, wrong type, etc.).
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message: string | string[] = 'Internal server error';

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const res = exception.getResponse();
      message =
        typeof res === 'string'
          ? res
          : ((res as any).message ?? exception.message);
    } else if (exception instanceof Error) {
      // Handle Multer errors (LIMIT_FILE_SIZE, etc.)
      const err = exception as any;
      if (err.code === 'LIMIT_FILE_SIZE') {
        status = HttpStatus.PAYLOAD_TOO_LARGE;
        message = 'File is too large. Maximum allowed size is 50 MB.';
      } else if (err.code === 'LIMIT_UNEXPECTED_FILE') {
        status = HttpStatus.BAD_REQUEST;
        message = `Unexpected field. Use "file" as the field name.`;
      } else {
        message = exception.message;
      }
    }

    this.logger.error(
      `[${request.method}] ${request.url} → ${status} | ${JSON.stringify(message)}`,
    );

    response.status(status).json({
      statusCode: status,
      timestamp: new Date().toISOString(),
      path: request.url,
      method: request.method,
      message,
    });
  }
}
