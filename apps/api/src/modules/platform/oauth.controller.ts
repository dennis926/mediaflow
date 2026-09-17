import { Controller, Get, Param, ParseEnumPipe, Query, Res } from '@nestjs/common';
import { PlatformCode } from '@mediaflow/shared';
import { Response } from 'express';
import { toActor } from '../auth/actor.util';
import { AuthUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { Public } from '../auth/public.decorator';
import { Capability } from '../auth/capabilities';
import { AuthorizeResult, OAuthService } from './oauth.service';

@Controller('accounts/oauth')
export class OAuthController {
  constructor(private readonly oauthService: OAuthService) {}

  /** Step 1: returns the platform authorize URL (the UI opens it in a new tab / same window). */
  @Capability('platform.bind')
  @Get(':platform/authorize')
  authorize(
    @Param('platform', new ParseEnumPipe(PlatformCode)) platform: PlatformCode,
    @CurrentUser() user?: AuthUser,
  ): Promise<AuthorizeResult> {
    return this.oauthService.authorize(platform, toActor(user).id);
  }

  /** Step 2: platform redirects here; we exchange the code and bounce back to the UI. */
  @Public()
  @Get(':platform/callback')
  async callback(
    @Param('platform', new ParseEnumPipe(PlatformCode)) platform: PlatformCode,
    @Query('code') code: string,
    @Query('state') state: string,
    @Res() response: Response,
  ): Promise<void> {
    try {
      const result = await this.oauthService.callback(platform, code, state);
      response.redirect(302, this.oauthService.buildReturnUrl({ ok: true, platform: result.platform, message: result.accountName }));
    } catch (error) {
      const message = error instanceof Error ? error.message : '授权失败';
      response.redirect(302, this.oauthService.buildReturnUrl({ ok: false, platform, message }));
    }
  }
}
