import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, e2eCredentialsReady, type E2eHarness } from './support/e2e-harness';

/**
 * 类别 5：上传边界（审计 P2-3 / 任务 4 的回归防线）
 *
 * 关键点不是"能上传"，而是三条边界都干净：超限不落盘、伪装不入库、失败不留临时文件。
 * 每一个用例都同时校验 HTTP 状态、临时目录、最终目录与素材表四处状态。
 */
const PREFIX = 'E2E上传边界';
/** 上传临时目录（与运行时配置一致；默认 /tmp/mediaflow-upload）。 */
const TEMP_DIR = process.env.MEDIA_TMP_DIR?.trim() || '/tmp/mediaflow-upload';
const MEDIA_DIR = '/www/wwwroot/mediaflow/uploads/media';
const CONCURRENT_LIMIT = 3;

/** 1x1 透明 PNG（魔数校验通过）。 */
const PNG_OK = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);
const PNG_FAKE = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(2048, 7)]);

function listFiles(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir) : [];
}

describe.skipIf(!e2eCredentialsReady)('类别 5：上传边界', () => {
  let h: E2eHarness;
  let token = '';
  const createdIds: string[] = [];

  const auth = () => ({ Authorization: `Bearer ${token}` });
  const server = () => h.app.getHttpServer();
  const tempFiles = () => listFiles(TEMP_DIR);
  const mediaFiles = () => listFiles(MEDIA_DIR);
  const mediaRows = async (): Promise<number> => {
    const rows = await h.dataSource.query('SELECT count(*)::int AS n FROM media_assets WHERE deleted_at IS NULL');
    return rows[0].n as number;
  };
  const upload = (buffer: Buffer, filename: string, fields: Record<string, string> = {}) => {
    let agent = request(server()).post('/api/media').set(auth());
    for (const [key, value] of Object.entries(fields)) agent = agent.field(key, value);
    return agent.attach('file', buffer, { filename, contentType: 'image/png' });
  };
  const removeAsset = async (id: string) => {
    await request(server()).delete(`/api/media/${id}`).set(auth()).expect(200);
  };

  beforeAll(async () => {
    h = await createHarness(PREFIX);
    token = await h.login(process.env.E2E_ADMIN_EMAIL ?? '', process.env.E2E_ADMIN_PASSWORD ?? '');
  }, 90_000);

  afterAll(async () => {
    for (const id of createdIds) {
      // 兜底清理：失败不影响测试结论
      await request(server()).delete(`/api/media/${id}`).set(auth()).catch(() => undefined);
    }
    await h?.cleanup();
    await h?.close();
  });

  it('1. 正常上传成功：临时目录零残留，最终目录与素材表各 +1（随后删除也回到基线）', async () => {
    const beforeRows = await mediaRows();
    const response = await upload(PNG_OK, 'e2e-ok.png', { groupName: 'E2E上传边界' }).expect(201);
    const id = response.body.data.id as string;
    createdIds.push(id);

    expect(tempFiles()).toHaveLength(0);
    expect(await mediaRows()).toBe(beforeRows + 1);
    expect(existsSync(join(MEDIA_DIR, response.body.data.storedName as string))).toBe(true);

    await removeAsset(id);
    createdIds.pop();
    expect(await mediaRows()).toBe(beforeRows);
    expect(existsSync(join(MEDIA_DIR, response.body.data.storedName as string))).toBe(false);
  });

  it('2. 超大文件（>MEDIA_MAX_FILE_MB）→ 413，且不落库、临时目录零残留', async () => {
    const beforeRows = await mediaRows();
    const beforeFiles = mediaFiles().length;
    const oversized = Buffer.concat([PNG_OK, Buffer.alloc(51 * 1024 * 1024)]);

    const response = await upload(oversized, 'e2e-big.png');
    expect(response.status).toBe(413);
    expect(response.body.code).toBe(50000);

    expect(tempFiles()).toHaveLength(0);
    expect(await mediaRows()).toBe(beforeRows);
    expect(mediaFiles().length).toBe(beforeFiles);
  }, 60_000);

  it('3. 伪装文件（exe 改名 png）→ 400，且不入库、不留文件', async () => {
    const beforeRows = await mediaRows();
    const beforeFiles = mediaFiles().length;

    const response = await upload(PNG_FAKE, 'e2e-fake.png');
    expect(response.status).toBe(400);
    expect(response.body.code).toBe(40000);

    expect(tempFiles()).toHaveLength(0);
    expect(await mediaRows()).toBe(beforeRows);
    expect(mediaFiles().length).toBe(beforeFiles);
  });

  it(`4. 并发 5 个上传 → 超过每用户并发上限（${CONCURRENT_LIMIT}）的请求 429，计数归零`, async () => {
    const beforeRows = await mediaRows();
    const concurrent = Buffer.concat([PNG_OK, Buffer.alloc(20 * 1024 * 1024)]);

    const responses = await Promise.all(
      Array.from({ length: 5 }, (_, index) => upload(concurrent, `e2e-conc-${index}.png`, { groupName: 'E2E并发' })),
    );
    const codes = responses.map((response) => response.status);
    const ok = responses.filter((response) => response.status === 201);
    const throttled = responses.filter((response) => response.status === 429);

    expect(ok.length).toBeLessThanOrEqual(CONCURRENT_LIMIT);
    expect(throttled.length).toBe(5 - ok.length);
    expect(throttled.length).toBeGreaterThan(0);

    for (const response of ok) createdIds.push(response.body.data.id as string);
    // 计数器必须归零，否则下一次上传会被永久限流
    expect(await h.redis.keys('upload:concurrent:*')).toHaveLength(0);
    expect(tempFiles()).toHaveLength(0);
    expect(await mediaRows()).toBe(beforeRows + ok.length);
    expect(new Set(codes).size).toBeGreaterThanOrEqual(1);

    for (const id of [...createdIds]) {
      await removeAsset(id);
      createdIds.splice(createdIds.indexOf(id), 1);
    }
    expect(await mediaRows()).toBe(beforeRows);
  }, 120_000);

  it('5. 落库失败（分组名超出列宽）→ 400 业务提示（不是 500 + 数据库原始报错），临时与最终目录都不留文件', async () => {
    const beforeRows = await mediaRows();
    const beforeFiles = mediaFiles().length;

    const response = await upload(PNG_OK, 'e2e-longgroup.png', { groupName: 'X'.repeat(200) });

    expect(response.status).toBe(400);
    expect(String(response.body.message)).toContain('分组名最长 80');
    // 不能把数据库内部错误回显给用户
    expect(JSON.stringify(response.body)).not.toContain('character varying');

    expect(tempFiles()).toHaveLength(0);
    expect(await mediaRows()).toBe(beforeRows);
    expect(mediaFiles().length).toBe(beforeFiles);
  });

  it('6. 临时目录与素材目录权限 700，上传结束后临时目录零残留', async () => {
    expect(statSync(TEMP_DIR).mode & 0o777).toBe(0o700);
    expect(statSync(MEDIA_DIR).mode & 0o777).toBe(0o700);
    expect(tempFiles()).toHaveLength(0);
    expect(createdIds).toHaveLength(0);
  });
});
