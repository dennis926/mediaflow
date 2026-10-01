import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, e2eCredentialsReady, type E2eHarness } from './support/e2e-harness';
import { SettingsService } from '../src/modules/settings/settings.service';

/**
 * 临时密码强制改密（审计 P1-4 回归）。
 *
 * 背景：`jwt-auth.guard.ts` 曾经把 `mustChangePassword` 硬编码成 false，前端那条提示可以
 * 直接忽略 —— 管理员重置密码后，用户不修改也能继续用全部功能。现在服务端强制：
 * 持临时密码时除白名单（改密/读自己/登出/续期/切换工作区/公开接口）外一律 403，
 * 改密后立即恢复（会话快照缓存要主动失效，否则会白等 30 秒）。
 *
 * 注意：只有**不传 password** 时服务端才生成临时密码并置 must_change_password=true
 * （传了 password 视为管理员指定正式密码，不算临时密码）。所以这里故意不传。
 */
const PREFIX = 'E2E强制改密';

describe.skipIf(!e2eCredentialsReady)(`${PREFIX}：临时密码强制改密`, () => {
  let h: E2eHarness;
  let owner = '';
  let email = '';
  let tempPassword = '';
  const newPassword = 'ChangedPass456';

  const server = () => h.app.getHttpServer();
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  /** 建一个持临时密码的账号，返回邮箱与临时密码。 */
  async function createTempUser(suffix: string): Promise<{ id: string; email: string; tempPassword: string }> {
    const created = await request(server())
      .post('/api/users')
      .set(auth(owner))
      .send({ email: `${PREFIX}-${suffix}-${Date.now()}@example.com`, displayName: `${PREFIX}${suffix}`, roleCodes: ['editor'] })
      .expect(201);
    const payload = created.body.data as {
      user?: { id?: string };
      id?: string;
      tempPassword?: string | null;
    };
    const id = (payload.user?.id ?? payload.id) as string;
    if (!id) throw new Error(`创建测试账号失败：${JSON.stringify(created.body).slice(0, 200)}`);
    h.createdUserIds.push(id);
    const rows = await h.dataSource.query('SELECT email, must_change_password FROM users WHERE id = $1', [id]);
    expect(rows[0].must_change_password).toBe(true);
    return { id, email: rows[0].email as string, tempPassword: payload.tempPassword as string };
  }

  beforeAll(async () => {
    h = await createHarness(PREFIX, { requireApproval: false });
    owner = await h.login(process.env.E2E_ADMIN_EMAIL ?? '', process.env.E2E_ADMIN_PASSWORD ?? '');
    const user = await createTempUser('主');
    email = user.email;
    tempPassword = user.tempPassword;
  }, 180_000);

  afterAll(async () => {
    await h?.cleanup();
    await h?.close();
  });

  it('① 持临时密码：业务写操作被拦 403，提示指向改密', async () => {
    const token = await h.login(email, tempPassword);
    const response = await request(server())
      .post('/api/contents')
      .set(auth(token))
      .send({ title: `${PREFIX} 不该被创建 ${Date.now()}`, body: 'x' });
    expect(response.status).toBe(403);
    expect(String(response.body.message)).toContain('初始密码');
  }, 120_000);

  it('② 白名单放行：能读自己、能改密', async () => {
    const token = await h.login(email, tempPassword);

    const me = await request(server()).get('/api/auth/me').set(auth(token)).expect(200);
    expect((me.body.data as { mustChangePassword: boolean }).mustChangePassword).toBe(true);

    await request(server())
      .post('/api/auth/change-password')
      .set(auth(token))
      .send({ currentPassword: tempPassword, newPassword })
      .expect(201);
  }, 120_000);

  it('③ 改密后立即恢复（不必等 30 秒缓存过期）', async () => {
    const token = await h.login(email, newPassword);
    const created = await request(server())
      .post('/api/contents')
      .set(auth(token))
      .send({ title: `${PREFIX} 改密后可创建 ${Date.now()}`, body: 'y', aiFlagType: 'none' })
      .expect(201);
    expect(created.body.data.id).toBeTruthy();

    const me = await request(server()).get('/api/auth/me').set(auth(token)).expect(200);
    expect((me.body.data as { mustChangePassword: boolean }).mustChangePassword).toBe(false);
  }, 120_000);

  it('④ 关掉开关后只提示不拦截（AUTH_FORCE_PASSWORD_CHANGE=false）', async () => {
    const user = await createTempUser('关闭开关');

    /**
     * runtime() 是"按工作区缓存的快照"，不是每次读环境变量。生产里改这个开关会走
     * 「保存设置 → refreshRuntimeConfig()」重建快照，所以测试也必须走同一条路径，
     * 只改 process.env 是不会生效的。
     */
    process.env.MEDIAFLOW_SETTING_OVERRIDE_AUTH_FORCE_PASSWORD_CHANGE = 'false';
    try {
      const settings = h.app.get(SettingsService);
      await settings.refreshRuntimeConfig();

      const token = await h.login(user.email, user.tempPassword);
      const response = await request(server())
        .post('/api/contents')
        .set(auth(token))
        .send({ title: `${PREFIX} 关闭开关后允许 ${Date.now()}`, body: 'z', aiFlagType: 'none' });
      expect(response.status).toBe(201);
    } finally {
      delete process.env.MEDIAFLOW_SETTING_OVERRIDE_AUTH_FORCE_PASSWORD_CHANGE;
      await h.app.get(SettingsService).refreshRuntimeConfig();
    }
  }, 120_000);
});
