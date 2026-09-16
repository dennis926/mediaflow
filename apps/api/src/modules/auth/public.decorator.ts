import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'mediaflow:is-public';

/** Marks a route as reachable without a token (health checks, login, adapter catalogue). */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);
