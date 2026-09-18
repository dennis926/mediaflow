# 技术债：权限粒度（归档他人内容）

- 记录日期：2026-09-19（阶段 A，任务 3 引入 `content.archive` 能力点时发现）
- 计划处理：阶段 B

## 现状

- 能力点 `content.archive` 默认矩阵：`owner / admin / editor`（任务 3 新增，见 `modules/auth/capabilities.ts`）。
- 含义：**editor 可以归档他人创建的内容**。归档会取消该内容未发出的发布任务，属阻断性操作。
- 现有能力点是"角色 × 操作"粒度，没有资源级（行级）控制：任何 editor 只要拿到 id 就能操作任意内容。

## 风险

1. 内部 10 人小团队可接受（互信、有审计留痕），但对外 SaaS 不可接受；
2. 归档属重要操作，误操作会打断正在排期的发布链路（任务会被自动取消，需重新创建）；
3. 同类资源级问题不止归档：`content.update`、`content.delete`、`media.delete` 同样是"同角色即可操作他人资源"。

## 阶段 B 方案（建议）

1. **资源级授权**：内容表已有 `authorId`；在服务层加"非 owner/admin 只能操作自己创建的资源"（`owner_id = current_user_id`），
   或引入显式共享（`content_collaborators` 表）供协作场景；
2. **收紧默认矩阵**：若短期不做行级控制，把 `content.archive`、`content.delete` 默认收紧为 `owner/admin`；
3. **敏感操作二次确认**：归档/删除可要求 `confirm: true` 或管理员复核（复用 content_reviews 模式）；
4. 补齐测试：editor 归档他人内容 → 403（当前为允许，测试需先按方案调整断言）。

## 当前不展开

按阶段 A 的约束，避免扩散范围；本文件仅作记录，阶段 B 启动时再评估。
