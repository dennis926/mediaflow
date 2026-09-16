import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { ApiCode } from '@mediaflow/shared';
import { Request, Response } from 'express';

const HTTP_TO_CODE: Record<number, number> = {
  [HttpStatus.BAD_REQUEST]: ApiCode.BadRequest,
  [HttpStatus.UNAUTHORIZED]: ApiCode.Unauthorized,
  [HttpStatus.FORBIDDEN]: ApiCode.Forbidden,
  [HttpStatus.NOT_FOUND]: ApiCode.NotFound,
  [HttpStatus.CONFLICT]: ApiCode.Conflict,
  [HttpStatus.TOO_MANY_REQUESTS]: ApiCode.TooManyRequests,
};

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const status = exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const message = this.resolveMessage(exception);
    const code = HTTP_TO_CODE[status] ?? ApiCode.InternalError;

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(`${request.method} ${request.url} -> ${status}: ${message}`);
    }

    response.status(status).json({ code, message, data: null });
  }

  private resolveMessage(exception: unknown): string {
    if (exception instanceof HttpException) {
      const payload = exception.getResponse();
      if (typeof payload === 'string') return payload;
      if (typeof payload === 'object' && payload !== null) {
        const detail = (payload as Record<string, unknown>).message;
        if (Array.isArray(detail)) return detail.join('; ');
        if (typeof detail === 'string') return detail;
      }
      return exception.message;
    }
    if (exception instanceof Error) return exception.message;
    return 'Internal server error';
  }
}
