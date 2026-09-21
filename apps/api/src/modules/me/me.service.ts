import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import JSZip from 'jszip';
import { Repository } from 'typeorm';
import { AuditService } from '../../audit/audit.service';
import { WorkspaceContextService } from '../../common/workspace-context.service';
import { Content } from '../content/entities/content.entity';
import { ContentReview } from '../content/entities/content-review.entity';
import { User } from '../workspace/entities/user.entity';

/**
 * B0.6：`GET /me/export` —— 用户导出**自己的**数据（可携带权/可转移权）。
 *
 * 范围严格限定为"与调用者本人相关"的记录：我的账号与成员关系、我创建的内容、我提交或审核过的审核记录、
 * 我的操作审计、我发起的 AI 调用。**不含**平台凭据、密钥、别人创建的内容。
 *
 * 上限：每类数据最多 5000 行（够个人取证用；需要全量请走工作区导出 `/workspaces/:id/export`，那是 owner/admin 权限）。
 */
@Injectable()
export class MeService {
  private readonly logger = new Logger(MeService.name);
  private static readonly MAX_ROWS = 5000;

  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(Content) private readonly contents: Repository<Content>,
    @InjectRepository(ContentReview) private readonly reviews: Repository<ContentReview>,
    private readonly audit: AuditService,
    private readonly workspaceContext: WorkspaceContextService,
  ) {}

  async exportMe(userId: string): Promise<{ buffer: Buffer; fileName: string; counts: Record<string, number> }> {
    const scope = await this.workspaceContext.current();
    const user = await this.users.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException('账号不存在');

    const memberships = await this.users.query(
      'SELECT workspace_id, role_codes, created_at FROM workspace_members WHERE user_id = $1 ORDER BY created_at',
      [userId],
    );
    const myContents = await this.contents.find({
      where: { authorId: userId },
      order: { createdAt: 'DESC' },
      take: MeService.MAX_ROWS,
    });
    const myReviews = await this.reviews.find({
      where: [{ submittedBy: userId }, { reviewerId: userId }],
      order: { createdAt: 'DESC' },
      take: MeService.MAX_ROWS,
    });
    const myAudit = await this.users.query(
      `SELECT created_at, action, resource_type, resource_id, workspace_id, ip
         FROM audit_logs WHERE actor_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [userId, MeService.MAX_ROWS],
    );
    const myAiCalls = await this.users.query(
      `SELECT created_at, provider, model, task_type, status, tokens_input, tokens_output, cost, content_id
         FROM ai_generations WHERE requested_by = $1 ORDER BY created_at DESC LIMIT $2`,
      [userId, MeService.MAX_ROWS],
    );

    await this.audit.record({
      action: 'me.export.requested',
      resourceType: 'user',
      resourceId: userId,
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
      actorId: userId,
      payload: {},
    });

    const jsonl = (rows: unknown[]): string => rows.map((row) => JSON.stringify(row)).join('\n');
    const zip = new JSZip();
    zip.file(
      'README.txt',
      [
        '本压缩包是你在 MediaFlow 中的个人数据导出（B0.6 合规能力）。',
        '',
        '包含：me.json（账号与成员关系）、data/my-contents.jsonl（你创建的内容）、',
        'data/my-reviews.jsonl（你提交或审核过的记录）、data/my-audit.jsonl（你的操作留痕）、',
        'data/my-ai-calls.jsonl（你发起的 AI 调用）。',
        '',
        `每类数据最多 ${MeService.MAX_ROWS} 行；如需要完整的工作区数据，请使用工作区导出功能（owner/admin 权限）。`,
        `导出人：${user.email}；导出时间：${new Date().toISOString()}`,
        '安全说明：不包含任何平台凭据、密钥或他人数据。',
      ].join('\n'),
    );
    zip.file(
      'me.json',
      JSON.stringify(
        {
          exportedAt: new Date().toISOString(),
          profile: {
            id: user.id,
            email: user.email,
            displayName: user.displayName,
            status: user.status,
            createdAt: user.createdAt,
            mustChangePassword: user.mustChangePassword,
          },
          memberships,
        },
        null,
        2,
      ),
    );
    zip.file('data/my-contents.jsonl', jsonl(myContents.map((row) => ({
      id: row.id,
      workspaceId: row.workspaceId,
      title: row.title,
      summary: row.summary,
      body: row.body,
      status: row.status,
      tags: row.tags,
      aiFlagType: row.aiFlagType,
      aiGenerated: row.aiGenerated,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }))));
    zip.file('data/my-reviews.jsonl', jsonl(myReviews.map((row) => ({
      id: row.id,
      contentId: row.contentId,
      round: row.round,
      status: row.status,
      submittedBy: row.submittedBy,
      reviewerId: row.reviewerId,
      comments: row.comments,
      operatorIp: row.operatorIp,
      operatorUa: row.operatorUa,
      decidedAt: row.decidedAt,
      createdAt: row.createdAt,
    }))));
    zip.file('data/my-audit.jsonl', jsonl(myAudit));
    zip.file('data/my-ai-calls.jsonl', jsonl(myAiCalls));

    const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    const counts = {
      contents: myContents.length,
      reviews: myReviews.length,
      audit: myAudit.length,
      aiCalls: myAiCalls.length,
      memberships: memberships.length,
    };

    await this.audit.record({
      action: 'me.export.downloaded',
      resourceType: 'user',
      resourceId: userId,
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
      actorId: userId,
      payload: { counts, sizeBytes: buffer.length },
    });
    this.logger.log(`个人数据已导出：${user.email}（${JSON.stringify(counts)}，${buffer.length} 字节）`);

    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    return { buffer, fileName: `mediaflow-me-${stamp}.zip`, counts };
  }
}
