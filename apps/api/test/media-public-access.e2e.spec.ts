import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, e2eCredentialsReady, type E2eHarness } from './support/e2e-harness';

/**
 * 素材公开访问的加固验证（审计 P1-3 + P2-5）。
 *
 * 背景：公开素材接口原本是"知道 UUID 就能取"——UUID 不可枚举，但链接一旦泄漏
 * （聊天记录、平台侧日志、referer）文件就永久公开，且爬虫可以无限刷。
 *
 * 本次改为三层：
 * 1. 签名链接（入库即带长期签名 exp=0，可追溯）；签名错误/过期一律 401；
 * 2. 裸 UUID 需要短时访问令牌（X-Media-Token），令牌与文件名绑定；
 * 3. 按来源 IP 限流（阈值可配置），超限 429。
 *
 * 注意：源文件放在用例私有的临时目录里（不是共享的 uploads 目录），
 * 否则用例产物会污染 upload-boundaries 对"临时目录零残留"的断言。
 */
const PREFIX = 'E2E素材访问';

describe.skipIf(!e2eCredentialsReady)('素材公开访问：签名 / 访问令牌 / 限流', () => {
  let h: E2eHarness;
  let token = '';
  let assetId = '';
  let storedName = '';
  let signedUrl = '';
  let signedPath = '';
  let sourceDir = '';

  const auth = () => ({ Authorization: `Bearer ${token}` });
  const server = () => h.app.getHttpServer();

  beforeAll(async () => {
    Object.assign(process.env, {
      // 阈值取 15：前面若干次探测（含被拒的 401）也会计数，这里要保证"打到超限"这件事
      // 一定发生，同时不至于让正常读取也被挡（断言里两条都检查）
      MEDIAFLOW_SETTING_OVERRIDE_MEDIA_PUBLIC_RATE_LIMIT_PER_MINUTE: '15',
    });
    sourceDir = mkdtempSync(join(tmpdir(), 'mf-media-src-'));
    h = await createHarness(PREFIX, { requireApproval: false });
    token = await h.login(process.env.E2E_ADMIN_EMAIL ?? '', process.env.E2E_ADMIN_PASSWORD ?? '');

    // 1x1 透明 PNG（真实文件头，能过 magic bytes 校验）
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      'base64',
    );
    const source = join(sourceDir, `e2e-asset-${randomUUID()}.png`);
    writeFileSync(source, png);

    const upload = await request(server())
      .post('/api/media')
      .set(auth())
      .attach('file', source)
      .expect(201);
    assetId = upload.body.data.id as string;
    signedUrl = upload.body.data.url as string;
    signedPath = signedUrl.startsWith('http') ? new URL(signedUrl).pathname + new URL(signedUrl).search : signedUrl;
    storedName = (upload.body.data.storedName as string) ?? signedUrl.split('/').pop()?.split('?')[0] ?? '';
  });

  afterAll(async () => {
    if (h) await h.close();
    rmSync(sourceDir, { recursive: true, force: true });
  });

  it('入库地址自带签名参数（不再是裸 UUID）', () => {
    expect(signedUrl).toContain('/api/public/media/');
    expect(signedUrl).toContain('sig=');
    expect(signedUrl).toContain('exp=');
    expect(signedUrl).not.toMatch(/\/api\/public\/media\/[a-f0-9-]{36}\.[a-z]+$/);
  });

  it('带正确签名的链接可公开访问（平台抓取路径仍然通）', async () => {
    const response = await request(server()).get(signedPath).expect(200);
    expect(response.headers['content-type']).toContain('image/png');
  });

  it('裸 UUID 不再放行（401），防止链接泄漏等于永久公开', async () => {
    await request(server()).get(`/api/public/media/${storedName}`).expect(401);
  });

  it('签名被篡改 / 过期一律 401（不降级成裸 UUID）', async () => {
    const tampered = signedPath.replace(/sig=[0-9a-f]+/, 'sig=deadbeef');
    await request(server()).get(tampered).expect(401);
    // 篡改 exp 会破坏 HMAC；即便伪造者把 exp 改成过去/未来，签名都对不上
    const expired = signedPath.replace(/exp=\d+/, 'exp=1');
    await request(server()).get(expired).expect(401);
  });

  it('访问链接可签发，且未登录不能签发（越权签发会绕开签名机制）', async () => {
    const issued = await request(server())
      .post(`/api/media/${assetId}/access-token`)
      .set(auth())
      .expect(201);
    expect(issued.body.data.url).toContain('sig=');

    await request(server()).post(`/api/media/${assetId}/access-token`).expect(401);
  });

  it('伪造的访问令牌被拒（裸 UUID 路径的通行证不可自造）', async () => {
    await request(server())
      .get(`/api/public/media/${storedName}`)
      .set('X-Media-Token', '9999999999.deadbeef')
      .expect(401);
  });

  it('按 IP 限流：超过阈值返回 429，正常读取仍可用', async () => {
    // 连打 30 次必然越过阈值：必须出现 429，且不能全是 429（否则正常访问被打死）
    const codes: number[] = [];
    for (let index = 0; index < 30; index += 1) {
      const response = await request(server()).get(signedPath);
      codes.push(response.status);
    }
    expect(codes).toContain(429);
    expect(codes.filter((code) => code === 200).length).toBeGreaterThan(0);
  });
});
