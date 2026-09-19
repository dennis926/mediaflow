import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, e2eCredentialsReady, type E2eHarness } from './support/e2e-harness';

/**
 * 类别 6：refresh 轮换与登出（审计 P2-5 / 任务 6）
 *
 * 全部走真实 HTTP + 真实 Redis：刷新令牌是一次性的（旧的重放必须 401），
 * 登出写黑名单后即便令牌未过期也不能再用。单测已用 mock 覆盖，这里是链路级证据。
 */
const PREFIX = 'E2E刷新轮换';

describe.skipIf(!e2eCredentialsReady)('类别 6：refresh 轮换与登出', () => {
  let h: E2eHarness;
  let token = '';

  const auth = (value: string) => ({ Authorization: `Bearer ${value}` });
  const server = () => h.app.getHttpServer();
  const login = () =>
    request(server())
      .post('/api/auth/login')
      .send({ email: process.env.E2E_ADMIN_EMAIL, password: process.env.E2E_ADMIN_PASSWORD });
  const refresh = (refreshToken: string) => request(server()).post('/api/auth/refresh').send({ refreshToken });
  const logout = (refreshToken?: string) =>
    refreshToken === undefined
      ? request(server()).post('/api/auth/logout').send({})
      : request(server()).post('/api/auth/logout').send({ refreshToken });

  beforeAll(async () => {
    h = await createHarness(PREFIX);
    token = await h.login(process.env.E2E_ADMIN_EMAIL ?? '', process.env.E2E_ADMIN_PASSWORD ?? '');
  }, 90_000);

  afterAll(async () => {
    await h?.cleanup();
    await h?.close();
  });

  it('1. 刷新正常轮换：签发新 access + 新 refresh，新访问令牌可用', async () => {
    const initial = await login().expect(201);
    const refreshToken = initial.body.data.refreshToken as string;

    const rotated = await refresh(refreshToken).expect(201);
    expect(rotated.body.data.accessToken).toBeTruthy();
    expect(rotated.body.data.refreshToken).toBeTruthy();
    expect(rotated.body.data.refreshToken).not.toBe(refreshToken);

    await request(server()).get('/api/auth/me').set(auth(rotated.body.data.accessToken as string)).expect(200);
  });

  it('2. 旧刷新令牌复用 → 401（一次性轮换，重放检测）', async () => {
    const initial = await login().expect(201);
    const first = initial.body.data.refreshToken as string;
    await refresh(first).expect(201);

    const replay = await refresh(first);
    expect(replay.status).toBe(401);
    expect(replay.body.code).toBe(40100);
  });

  it('3. 连续轮换链可用：R1 → R2 → R3 每次都能换新', async () => {
    const initial = await login().expect(201);
    const r1 = initial.body.data.refreshToken as string;
    const r2 = (await refresh(r1).expect(201)).body.data.refreshToken as string;
    const r3 = (await refresh(r2).expect(201)).body.data.refreshToken as string;

    expect(new Set([r1, r2, r3]).size).toBe(3);
    // 链路中间被替换掉的两把都要作废
    expect((await refresh(r1)).status).toBe(401);
    expect((await refresh(r2)).status).toBe(401);
    expect((await refresh(r3)).status).toBe(201);
  });

  it('4. 登出后刷新 → 401（黑名单在真实 Redis 生效）', async () => {
    const initial = await login().expect(201);
    const refreshToken = initial.body.data.refreshToken as string;

    const out = await logout(refreshToken).expect(201);
    expect(out.body.data.ok).toBe(true);

    const afterLogout = await refresh(refreshToken);
    expect(afterLogout.status).toBe(401);
    expect(String(afterLogout.body.message)).toContain('已登出');
  });

  it('5. 登出幂等：不带令牌 / 令牌非法都返回成功（不泄露令牌是否有效）', async () => {
    const empty = await logout().expect(201);
    expect(empty.body.data.ok).toBe(true);

    const bogus = await logout('not-a-real-token').expect(201);
    expect(bogus.body.data.ok).toBe(true);
  });

  it('6. 刷新令牌不能当访问令牌使用 → 401', async () => {
    const initial = await login().expect(201);
    const refreshToken = initial.body.data.refreshToken as string;

    const response = await request(server()).get('/api/contents').set(auth(refreshToken));
    expect(response.status).toBe(401);
  });

  it('7. 账号被停用后不能刷新（未过期刷新令牌也失效）', async () => {
    const user = await h.createUser({ roleCodes: ['editor'] });
    const session = await request(server())
      .post('/api/auth/login')
      .send({ email: user.email, password: user.password })
      .expect(201);
    const userRefresh = session.body.data.refreshToken as string;
    await refresh(userRefresh).expect(201); // 停用前正常

    await request(server())
      .patch(`/api/users/${user.id}/status`)
      .set(auth(token))
      .send({ status: 'disabled' })
      .expect(200);

    const blocked = await refresh(userRefresh);
    expect(blocked.status).toBeGreaterThanOrEqual(400);
    expect(blocked.status).toBeLessThan(500);
  });
});
