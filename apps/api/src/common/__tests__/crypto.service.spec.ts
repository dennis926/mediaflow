import { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';
import { CryptoService } from '../crypto.service';

/**
 * 类别 7：设置加密密钥（任务 7）
 *
 * 守卫必须"缺了就起不来"，且解密**只依赖 SETTINGS_ENCRYPTION_KEY**——
 * 这样轮换 JWT_SECRET 才不会波及已加密的数据（任务 8b 已在生产验证）。
 */
function serviceOf(env: Record<string, string | undefined>): CryptoService {
  const config = { get: (key: string) => env[key] } as unknown as ConfigService;
  return new CryptoService(config);
}

const SETTINGS_KEY = 'S'.repeat(44);
const JWT_KEY = 'J'.repeat(48);

describe('CryptoService 启动守卫（类别 7）', () => {
  it('SETTINGS_ENCRYPTION_KEY 为空 → 启动即抛错', () => {
    expect(() => serviceOf({ JWT_SECRET: JWT_KEY })).toThrowError(/SETTINGS_ENCRYPTION_KEY 必须配置且长度 ≥ 32（当前为空）/);
  });

  it('SETTINGS_ENCRYPTION_KEY 少于 32 字符 → 启动即抛错并说明当前长度', () => {
    expect(() => serviceOf({ SETTINGS_ENCRYPTION_KEY: 'abc' })).toThrowError(/当前仅 3 字符/);
    expect(() => serviceOf({ SETTINGS_ENCRYPTION_KEY: 'x'.repeat(31) })).toThrowError(/当前仅 31 字符/);
  });

  it('够长的密钥可以正常工作（32 字符是下限）', () => {
    const service = serviceOf({ SETTINGS_ENCRYPTION_KEY: 'x'.repeat(32) });
    const cipher = service.encrypt('hello');
    expect(cipher.startsWith('enc:v1:')).toBe(true);
    expect(service.decrypt(cipher)).toBe('hello');
  });
});

describe('CryptoService 加解密行为（类别 7）', () => {
  it('往返一致，且同一明文两次加密产生不同密文（随机 IV）', () => {
    const service = serviceOf({ SETTINGS_ENCRYPTION_KEY: SETTINGS_KEY });
    const first = service.encrypt('sk-test-value');
    const second = service.encrypt('sk-test-value');

    expect(first).not.toBe(second);
    expect(service.decrypt(first)).toBe('sk-test-value');
    expect(service.decrypt(second)).toBe('sk-test-value');
  });

  it('明文（未加密的历史值）原样返回，null 仍是 null', () => {
    const service = serviceOf({ SETTINGS_ENCRYPTION_KEY: SETTINGS_KEY });
    expect(service.decrypt('plain-value')).toBe('plain-value');
    expect(service.decrypt(null)).toBeNull();
  });

  it('密文被篡改 → 认证失败返回 null（记错误日志，不抛异常，避免单行损坏拖垮启动）', () => {
    const service = serviceOf({ SETTINGS_ENCRYPTION_KEY: SETTINGS_KEY });
    const cipher = service.encrypt('sensitive');
    const tampered = `${cipher.slice(0, -4)}AAAA`;

    expect(service.decrypt(tampered)).toBeNull();
    // 未篡改的原文仍然可读
    expect(service.decrypt(cipher)).toBe('sensitive');
  });

  it('解密只认 SETTINGS_ENCRYPTION_KEY：换掉 JWT_SECRET 依然能解密（已解耦）', () => {
    const before = serviceOf({ SETTINGS_ENCRYPTION_KEY: SETTINGS_KEY, JWT_SECRET: JWT_KEY });
    const cipher = before.encrypt('after-rotation-check');

    // 模拟 JWT_SECRET 轮换（甚至是完全不同的值/缺失），密文必须照常解出
    for (const jwt of ['Z'.repeat(48), undefined]) {
      const after = serviceOf({ SETTINGS_ENCRYPTION_KEY: SETTINGS_KEY, JWT_SECRET: jwt });
      expect(after.decrypt(cipher)).toBe('after-rotation-check');
    }
  });

  it('换掉 SETTINGS_ENCRYPTION_KEY 则解不开（密文只归属于该密钥）', () => {
    const before = serviceOf({ SETTINGS_ENCRYPTION_KEY: SETTINGS_KEY });
    const cipher = before.encrypt('belongs-to-one-key');
    const other = serviceOf({ SETTINGS_ENCRYPTION_KEY: 'T'.repeat(44) });

    // 解不开时返回 null（而不是异常），调用方据此判定"密钥不匹配"
    expect(other.decrypt(cipher)).toBeNull();
  });
});

describe('CryptoService HMAC 签名（导出下载令牌，B0.4 第 3 步）', () => {
  it('同一载荷签名稳定，且可用 verifyHmac 校验', () => {
    const service = serviceOf({ SETTINGS_ENCRYPTION_KEY: SETTINGS_KEY });
    const payload = 'job-1|w-1|1730000000';
    const signature = service.hmac(payload);

    expect(signature).toMatch(/^[0-9a-f]{64}$/);
    expect(service.hmac(payload)).toBe(signature);
    expect(service.verifyHmac(payload, signature)).toBe(true);
  });

  it('载荷被篡改或签名错误 → 校验失败', () => {
    const service = serviceOf({ SETTINGS_ENCRYPTION_KEY: SETTINGS_KEY });
    const signature = service.hmac('job-1|w-1|1730000000');

    expect(service.verifyHmac('job-2|w-1|1730000000', signature)).toBe(false);
    expect(service.verifyHmac('job-1|w-1|1730000000', 'deadbeef')).toBe(false);
    expect(service.verifyHmac('job-1|w-1|1730000000', '')).toBe(false);
  });

  it('不同主密钥签出的令牌互不通过（轮换后旧令牌失效）', () => {
    const first = serviceOf({ SETTINGS_ENCRYPTION_KEY: SETTINGS_KEY });
    const other = serviceOf({ SETTINGS_ENCRYPTION_KEY: 'T'.repeat(44) });
    const payload = 'job-1|w-1|1730000000';

    expect(other.verifyHmac(payload, first.hmac(payload))).toBe(false);
  });
});
