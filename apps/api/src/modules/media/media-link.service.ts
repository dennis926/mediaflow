import { Injectable, UnauthorizedException } from '@nestjs/common';
import { CryptoService } from '../../common/crypto.service';
import { runtime } from '../settings/runtime-config';

/**
 * 公开素材链接的签名与校验。
 *
 * 背景：素材要交给平台抓取（抖音/小红书发布时平台侧要能拉图），所以必须有免登录入口。
 * 早期实现是"知道 UUID 就能取"——UUID 不可枚举，但一旦某条链接泄漏（聊天记录、
 * 平台侧日志、referer），文件就永久公开且无法追责，也给了爬虫批量刷取的机会。
 *
 * 现在：链接带签名与有效期，URL 由后端按需签发；未签名的裸 UUID 访问仍然可用，
 * 但**必须先持有素材访问令牌**（GET /media/:id/access-token 签发，短时有效）。
 * 这样"链接泄漏"不再等于"文件永久公开"，同时既有内容里的老链接不会立刻失效。
 *
 * 有效期为 0 时表示签发长期链接（便于固定链接的平台配置），仍带签名可追溯。
 */
@Injectable()
export class MediaLinkService {
  constructor(private readonly crypto: CryptoService) {}

  /** 签名载荷：文件名 + 过期时间戳（秒）。改动任一字段签名即失效。 */
  private payload(storedName: string, expiresAt: number): string {
    return `${storedName}|${expiresAt}`;
  }

  /** 生成带签名的公开访问地址（相对路径；调用方按需拼上站点域名）。 */
  sign(storedName: string, ttlSeconds = 0): { url: string; expiresAt: string | null } {
    const ttl = ttlSeconds > 0 ? ttlSeconds : 0;
    const expiresAt = ttl > 0 ? Math.floor(Date.now() / 1000) + ttl : 0;
    const signature = this.crypto.hmac(this.payload(storedName, expiresAt));
    const base = runtime().media.publicBaseUrl.trim().replace(/\/$/, '');
    const query = `exp=${expiresAt}&sig=${signature}`;
    return {
      url: base ? `${base}/${storedName}?${query}` : `/api/public/media/${storedName}?${query}`,
      expiresAt: ttl > 0 ? new Date(expiresAt * 1000).toISOString() : null,
    };
  }

  /**
   * 校验签名；返回 null 表示未提供签名（由调用方决定是否走"裸 UUID + 访问令牌"路径）。
   * 签名存在但不合法 / 已过期一律抛 401——避免"签名错了就悄悄降级"。
   */
  verify(storedName: string, expiresAtRaw?: string, signature?: string): 'ok' | 'unsigned' {
    if (!expiresAtRaw && !signature) return 'unsigned';
    if (!expiresAtRaw || !signature) throw new UnauthorizedException('素材链接不完整');
    const expiresAt = Number(expiresAtRaw);
    if (!Number.isFinite(expiresAt)) throw new UnauthorizedException('素材链接无效');
    if (!this.crypto.verifyHmac(this.payload(storedName, expiresAt), signature)) {
      throw new UnauthorizedException('素材链接无效');
    }
    if (expiresAt > 0 && expiresAt * 1000 < Date.now()) throw new UnauthorizedException('素材链接已过期，请重新获取');
    return 'ok';
  }
}
