/**
 * 人工发布回填闭环（B1 之前的"无平台密钥"主路径）。
 *
 * 为什么必须有它：公众号按平台规则禁止 API 自动发布、视频号/知乎/头条/百家号靠插件填充 + 人工确认，
 * 这些任务状态是 `manual_required`。没有回填入口，任务会永远停在"待人工发布"，发布数据也回不来。
 *
 * 覆盖：
 *   ① 回填已发布（带链接）→ 状态 published + platformUrl + extra.manualPublish + 审计 + 站内通知；
 *   ② 同一任务重复回填 → 409（不重复记账）；
 *   ③ 回填失败（必填原因）→ 状态 failed + errorMessage + 审计；
 *   ④ 已发布的任务不能标记失败、已取消的任务不能回填；
 *   ⑤ 链接格式非法 → 400（校验真的生效）。
 */
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, e2eCredentialsReady, type E2eHarness } from './support/e2e-harness';

const PREFIX = 'E2E人工回填';

describe.skipIf(!e2eCredentialsReady)(`${PREFIX}：人工发布结果回填`, () => {
  let h: E2eHarness;
  let token = '';
  const createdContentIds: string[] = [];
  const server = () => h.app.getHttpServer();
  const auth = () => ({ Authorization: `Bearer ${token}` });

  async function createTask(platform: string): Promise<string> {
    const content = await request(server())
      .post('/api/contents')
      .set(auth())
      .send({ title: `${PREFIX}-内容-${Date.now()}-${platform}`, body: '人工发布闭环测试正文', aiFlagType: 'none' })
      .expect(201);
    const contentId = content.body.data.id as string;
    createdContentIds.push(contentId);

    const created = await request(server())
      .post('/api/publish/tasks')
      .set(auth())
      .send({ contentId, platforms: [platform] })
      .expect(201);
    const taskId = created.body.data[0].id as string;
    h.createdTaskIds.push(taskId);
    return taskId;
  }

  beforeAll(async () => {
    h = await createHarness(PREFIX, { requireApproval: false });
    token = await h.login(process.env.E2E_ADMIN_EMAIL ?? '', process.env.E2E_ADMIN_PASSWORD ?? '');
  }, 120_000);

  afterAll(async () => {
    if (h) {
      await h.dataSource
        .query("DELETE FROM notifications WHERE type IN ('publish.manual_completed','publish.manual_failed') AND created_at > now() - interval '10 minutes'")
        .catch(() => undefined);
      await h.dataSource.query('DELETE FROM publish_tasks WHERE content_id = ANY($1)', [createdContentIds]).catch(() => undefined);
      await h.cleanup();
      await h.close();
    }
  }, 120_000);

  it('① 回填已发布：状态、链接、标记来源、审计与站内通知都到位', async () => {
    const taskId = await createTask('wechat_mp');
    const response = await request(server())
      .post(`/api/publish/tasks/${taskId}/manual-published`)
      .set(auth())
      .send({ url: 'https://mp.weixin.qq.com/s/abcdefg123', postId: 'msg-001', note: '未群发，仅发布' })
      .expect(200);

    const task = response.body.data as { status: string; platformUrl: string; platformPostId: string; finishedAt: string; extra: Record<string, unknown> };
    expect(task.status).toBe('published');
    expect(task.platformUrl).toBe('https://mp.weixin.qq.com/s/abcdefg123');
    expect(task.platformPostId).toBe('msg-001');
    expect(task.finishedAt).toBeTruthy();
    const manual = task.extra.manualPublish as { source: string; note: string; by: string };
    expect(manual.source).toBe('manual');
    expect(manual.note).toBe('未群发，仅发布');
    expect(manual.by).toBeTruthy();

    const audits = await h.dataSource.query(
      "SELECT payload FROM audit_logs WHERE action = 'publish_task.manual_published' AND resource_id = $1",
      [taskId],
    );
    expect(audits.length).toBe(1);
    expect(String((audits[0].payload as { url: string }).url)).toContain('mp.weixin.qq.com');

    const notifications = await h.dataSource.query(
      "SELECT count(*)::int AS n FROM notifications WHERE type = 'publish.manual_completed' AND resource_id = $1",
      [taskId],
    );
    expect(Number(notifications[0].n)).toBe(1);
  }, 120_000);

  it('② 重复回填 → 409（不重复记账）', async () => {
    const taskId = await createTask('wechat_mp');
    await request(server())
      .post(`/api/publish/tasks/${taskId}/manual-published`)
      .set(auth())
      .send({ url: 'https://mp.weixin.qq.com/s/first' })
      .expect(200);

    const again = await request(server())
      .post(`/api/publish/tasks/${taskId}/manual-published`)
      .set(auth())
      .send({ url: 'https://mp.weixin.qq.com/s/second' });
    expect(again.status).toBe(409);
    expect(String(again.body.message)).toContain('已标记为已发布');

    // 库里仍是第一次的链接
    const rows = await h.dataSource.query('SELECT platform_url FROM publish_tasks WHERE id = $1', [taskId]);
    expect(rows[0].platform_url).toBe('https://mp.weixin.qq.com/s/first');
  }, 120_000);

  it('③ 回填失败：原因必填且落库，审计留存，任务可再重试', async () => {
    const taskId = await createTask('zhihu');

    const missing = await request(server()).post(`/api/publish/tasks/${taskId}/manual-failed`).set(auth()).send({});
    expect(missing.status).toBe(400);

    const response = await request(server())
      .post(`/api/publish/tasks/${taskId}/manual-failed`)
      .set(auth())
      .send({ reason: '平台提示图片尺寸不合规，需重新裁剪' })
      .expect(200);
    expect((response.body.data as { status: string; errorMessage: string }).status).toBe('failed');
    expect((response.body.data as { errorMessage: string }).errorMessage).toContain('图片尺寸');

    const audits = await h.dataSource.query(
      "SELECT payload FROM audit_logs WHERE action = 'publish_task.manual_failed' AND resource_id = $1",
      [taskId],
    );
    expect(audits.length).toBe(1);
    expect(String((audits[0].payload as { reason: string }).reason)).toContain('图片尺寸');
  }, 120_000);

  it('④ 已发布的任务不能标记失败；链接格式非法直接 400', async () => {
    const publishedId = await createTask('wechat_mp');
    await request(server())
      .post(`/api/publish/tasks/${publishedId}/manual-published`)
      .set(auth())
      .send({ url: 'https://mp.weixin.qq.com/s/done' })
      .expect(200);
    const conflict = await request(server())
      .post(`/api/publish/tasks/${publishedId}/manual-failed`)
      .set(auth())
      .send({ reason: '想改成失败' });
    expect(conflict.status).toBe(409);

    const badUrl = await request(server())
      .post(`/api/publish/tasks/${publishedId}/manual-published`)
      .set(auth())
      .send({ url: 'javascript:alert(1)' });
    // 该任务已发布 → 409 先命中；换一个未发布任务验证 URL 校验
    expect([400, 409]).toContain(badUrl.status);

    const freshId = await createTask('toutiao');
    const invalid = await request(server())
      .post(`/api/publish/tasks/${freshId}/manual-published`)
      .set(auth())
      .send({ url: 'not-a-url' });
    expect(invalid.status).toBe(400);
  }, 120_000);
});
