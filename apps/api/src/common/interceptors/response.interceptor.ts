import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { ApiCode, ApiResponse } from '@mediaflow/shared';
import { Observable, map } from 'rxjs';

interface ShapedResponse {
  code: number;
  message: string;
  data: unknown;
}

function isShaped(value: unknown): value is ShapedResponse {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.code === 'number' && 'data' in candidate && 'message' in candidate;
}

/** Wraps every controller return value into the unified { code, message, data } envelope. */
@Injectable()
export class ResponseInterceptor<T> implements NestInterceptor<T, ApiResponse<T>> {
  intercept(_context: ExecutionContext, next: CallHandler<T>): Observable<ApiResponse<T>> {
    return next.handle().pipe(
      map((data) => {
        if (isShaped(data)) return data as ApiResponse<T>;
        return { code: ApiCode.Success, message: 'ok', data };
      }),
    );
  }
}
