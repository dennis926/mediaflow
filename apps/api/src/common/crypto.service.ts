import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const PREFIX = 'enc:v1:';
const ALGORITHM = 'aes-256-gcm';

/**
 * Encrypts secrets before they are written to the database, so a database dump or backup
 * never exposes API keys. The master key comes from SETTINGS_ENCRYPTION_KEY (falls back to
 * JWT_SECRET) and lives only in the environment.
 */
@Injectable()
export class CryptoService {
  private readonly logger = new Logger(CryptoService.name);
  private readonly key: Buffer;

  constructor(config: ConfigService) {
    const master = (config.get<string>('SETTINGS_ENCRYPTION_KEY') ?? '').trim();
    if (master.length < 32) {
      throw new Error(
        'SETTINGS_ENCRYPTION_KEY 必须配置且长度 ≥ 32' +
          (master ? `（当前仅 ${master.length} 字符）` : '（当前为空）') +
          '：密钥类配置（AI Key、平台 Secret）依赖它加解密；回退到 JWT_SECRET 或硬编码会在密钥轮换时造成永久不可解密。',
      );
    }
    this.key = scryptSync(master, 'mediaflow-settings', 32);
  }

  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${PREFIX}${Buffer.concat([iv, tag, encrypted]).toString('base64')}`;
  }

  /** Returns the plaintext for encrypted values; values stored in clear text pass through. */
  decrypt(value: string | null): string | null {
    if (value === null) return null;
    if (!value.startsWith(PREFIX)) return value;
    try {
      const raw = Buffer.from(value.slice(PREFIX.length), 'base64');
      const iv = raw.subarray(0, 12);
      const tag = raw.subarray(12, 28);
      const data = raw.subarray(28);
      const decipher = createDecipheriv(ALGORITHM, this.key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
    } catch (error) {
      this.logger.error(`解密失败：${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /**
   * 用主密钥派生的签名密钥对载荷做 HMAC-SHA256（十六进制）。
   *
   * 用途：导出产物的一次性下载令牌 —— 令牌必须不可伪造，但不需要可逆加密。
   * 与加解密共用同一主密钥的派生结果，因此轮换密钥会让旧令牌自然失效（安全上可接受）。
   */
  hmac(payload: string): string {
    return createHmac('sha256', this.key).update(payload).digest('hex');
  }

  /** 校验 HMAC（定长比较，避免时序侧信道）。 */
  verifyHmac(payload: string, signature: string): boolean {
    const expected = Buffer.from(this.hmac(payload), 'utf8');
    const provided = Buffer.from(signature ?? '', 'utf8');
    if (expected.length !== provided.length) return false;
    return timingSafeEqual(expected, provided);
  }

  isEncrypted(value: string | null): boolean {
    return typeof value === 'string' && value.startsWith(PREFIX);
  }

  /** Shows only the tail of a secret so the UI can confirm what is stored. */
  mask(plain: string | null): string {
    if (!plain) return '';
    if (plain.length <= 8) return '••••';
    return `••••${plain.slice(-4)}`;
  }
}
