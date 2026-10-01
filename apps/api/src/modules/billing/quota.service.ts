import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, Repository } from 'typeorm';
import { AuditService } from '../../audit/audit.service';
import { WorkspaceContextService } from '../../common/workspace-context.service';
import { WorkspaceMember } from '../workspace/entities/workspace-member.entity';
import { MediaAsset } from '../media/entities/media-asset.entity';
import { Invoice } from './entities/invoice.entity';
import { Plan, UsageKind } from './entities/plan.entity';
import { Quota } from './entities/quota.entity';
import { Subscription } from './entities/subscription.entity';
import { UsageRecord } from './entities/usage-record.entity';

export interface QuotaStatus {
  kind: UsageKind;
  label: string;
  limit: number;
  used: number;
  remaining: number | null;
  resetAt: string | null;
  planCode: string;
  planName: string;
  /** 0 表示不限制 */
  unlimited: boolean;
}

const KIND_LABELS: Record<UsageKind, string> = {
  ai_tokens: 'AI 调用 token',
  publish: '发布次数',
  upload_mb: '素材存储（MB）',
  member: '工作区成员数',
};

/** 瞬时口径的配额（看"当前值"，不按周期累计） */
const INSTANT_KINDS: UsageKind[] = ['upload_mb', 'member'];

/**
 * B0.7 配额服务。
 *
 * 口径：
 *   - 周期类（`ai_tokens`、`publish`）：按自然月累计，计数器在 `quotas` 表（`period = YYYY-MM`），
 *     每次写入同时落一条 `usage_records` 流水（流水是事实来源，计数器是快路径）；
 *   - 瞬时类（`upload_mb` = 当前素材总大小、`member` = 当前成员数）：用量用实时 COUNT/SUM 计算，
 *     同样写流水备查；
 *   - 上限取自"工作区的有效订阅 → 计划"；没有订阅则用默认计划；**0 表示不限制**。
 *
 * 超限时抛 403 并说明"哪项配额、已用多少、上限多少、什么时候重置"，同时写审计 `quota.exceeded`
 * （只记拒绝事实，不刷屏：拒绝才记）。
 */
@Injectable()
export class QuotaService {
  private readonly logger = new Logger(QuotaService.name);

  constructor(
    @InjectRepository(Plan) private readonly plans: Repository<Plan>,
    @InjectRepository(Subscription) private readonly subscriptions: Repository<Subscription>,
    @InjectRepository(UsageRecord) private readonly usage: Repository<UsageRecord>,
    @InjectRepository(Quota) private readonly quotas: Repository<Quota>,
    @InjectRepository(Invoice) private readonly invoices: Repository<Invoice>,
    @InjectRepository(WorkspaceMember) private readonly members: Repository<WorkspaceMember>,
    @InjectRepository(MediaAsset) private readonly assets: Repository<MediaAsset>,
    private readonly workspaceContext: WorkspaceContextService,
    private readonly audit: AuditService,
  ) {}

  private static periodOf(now = new Date()): string {
    return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  }

  private static periodEndIso(now = new Date()): string {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
  }

  private static limitOf(plan: Plan, kind: UsageKind): number {
    switch (kind) {
      case 'ai_tokens':
        return Number(plan.aiTokenQuota ?? 0);
      case 'publish':
        return Number(plan.publishQuota ?? 0);
      case 'upload_mb':
        return Number(plan.storageQuotaMb ?? 0);
      case 'member':
        return Number(plan.memberQuota ?? 0);
      default:
        return 0;
    }
  }

  /** 工作区当前生效的计划：有效订阅 → 计划；没有订阅则用默认计划。 */
  async effectivePlan(workspaceId?: string): Promise<Plan> {
    const scope = workspaceId ? null : await this.workspaceContext.current();
    const target = workspaceId ?? scope?.workspaceId;
    if (target) {
      const subscription = await this.subscriptions.findOne({
        where: { workspaceId: target, status: 'active' },
        order: { createdAt: 'DESC' },
      });
      if (subscription) {
        const plan = await this.plans.findOne({ where: { id: subscription.planId } });  // tenant-scope-ok: plans 为平台级字典（无 workspace_id 列）
        if (plan) return plan;
      }
    }
    const fallback = await this.plans.findOne({ where: { isDefault: true, isActive: true } });
    if (fallback) return fallback;
    // 极端情况（计划表被清空）：返回一个"全不限制"的内存计划，避免把业务卡死
    return { code: 'fallback', name: '兜底（不限制）', isActive: true } as Plan;
  }

  /** 实时用量（瞬时类）或周期计数器用量。 */
  private async usedOf(kind: UsageKind, workspaceId: string, tenantId: string): Promise<number> {
    if (kind === 'member') {
      return this.members.count({ where: { workspaceId } });
    }
    if (kind === 'upload_mb') {
      const rows = await this.assets
        .createQueryBuilder('asset')
        .select('COALESCE(SUM(asset.size), 0)', 'total')
        .where('asset.workspaceId = :workspaceId AND asset.deletedAt IS NULL', { workspaceId })
        .getRawOne<{ total: string }>();
      return Math.round((Number(rows?.total ?? 0) / (1024 * 1024)) * 100) / 100;
    }
    const row = await this.quotas.findOne({ where: { tenantId, workspaceId, period: QuotaService.periodOf(), kind } });
    return Number(row?.usedValue ?? 0);
  }

  async status(kind: UsageKind): Promise<QuotaStatus> {
    const scope = await this.workspaceContext.current();
    const plan = await this.effectivePlan(scope.workspaceId);
    const limit = QuotaService.limitOf(plan, kind);
    const used = await this.usedOf(kind, scope.workspaceId, scope.tenantId);
    return {
      kind,
      label: KIND_LABELS[kind],
      limit,
      used,
      remaining: limit > 0 ? Math.max(0, limit - used) : null,
      resetAt: INSTANT_KINDS.includes(kind) ? null : QuotaService.periodEndIso(),
      planCode: plan.code,
      planName: plan.name,
      unlimited: limit <= 0,
    };
  }

  async statusAll(): Promise<QuotaStatus[]> {
    const kinds: UsageKind[] = ['ai_tokens', 'publish', 'upload_mb', 'member'];
    return Promise.all(kinds.map((kind) => this.status(kind)));
  }

  /**
   * 配额闸门：超限抛 403（含"哪项、已用、上限、何时重置"），并写审计。
   * 调用点：AI 调用前、创建发布任务前、上传素材前、新增成员前。
   */
  async assertQuota(kind: UsageKind, amount: number): Promise<void> {
    const scope = await this.workspaceContext.current();
    const plan = await this.effectivePlan(scope.workspaceId);
    const limit = QuotaService.limitOf(plan, kind);
    if (limit <= 0) return; // 不限制

    const used = await this.usedOf(kind, scope.workspaceId, scope.tenantId);
    if (used + amount <= limit) return;

    const resetAt = INSTANT_KINDS.includes(kind) ? null : QuotaService.periodEndIso();
    const message =
      `已达配额上限：${KIND_LABELS[kind]}（已用 ${used} / 上限 ${limit}，本次还需 ${amount}）。` +
      (resetAt ? `配额将在 ${resetAt.slice(0, 10)} 重置。` : '请先释放用量（如删除素材或移出成员）。') +
      `当前计划：${plan.name}（${plan.code}）。需要提高上限请联系管理员调整订阅计划。`;

    await this.audit
      .record({
        action: 'quota.exceeded',
        resourceType: 'quota',
        resourceId: null,
        tenantId: scope.tenantId,
        workspaceId: scope.workspaceId,
        payload: { kind, limit, used, requested: amount, planCode: plan.code, resetAt },
      })
      .catch(() => undefined);
    this.logger.warn(`配额拦截：${message}`);
    throw new ForbiddenException(message);
  }

  /**
   * 记录用量：先落流水（事实来源），再更新周期计数器（快路径）。
   * 瞬时类只落流水——它们的"当前用量"实时算，不做累计。
   */
  async recordUsage(
    kind: UsageKind,
    quantity: number,
    options: { unit?: string; sourceType?: string; sourceId?: string | null; meta?: Record<string, unknown> } = {},
  ): Promise<void> {
    if (!Number.isFinite(quantity) || quantity <= 0) return;
    const scope = await this.workspaceContext.current();
    try {
      await this.usage.save(
        this.usage.create({
          tenantId: scope.tenantId,
          workspaceId: scope.workspaceId,
          kind,
          quantity: quantity.toFixed(4),
          unit: options.unit ?? (kind === 'ai_tokens' ? 'token' : kind === 'upload_mb' ? 'mb' : 'count'),
          sourceType: options.sourceType ?? null,
          sourceId: options.sourceId ?? null,
          occurredAt: new Date(),
          meta: options.meta ?? {},
        }),
      );

      if (INSTANT_KINDS.includes(kind)) return;

      const period = QuotaService.periodOf();
      const existing = await this.quotas.findOne({
        where: { tenantId: scope.tenantId, workspaceId: scope.workspaceId, period, kind },
      });
      const plan = await this.effectivePlan(scope.workspaceId);
      if (existing) {
        await this.quotas.update(
          { id: existing.id },
          { usedValue: (Number(existing.usedValue) + quantity).toFixed(4) },
        );
      } else {
        await this.quotas.save(
          this.quotas.create({
            tenantId: scope.tenantId,
            workspaceId: scope.workspaceId,
            period,
            kind,
            limitValue: QuotaService.limitOf(plan, kind).toFixed(4),
            usedValue: quantity.toFixed(4),
            resetAt: new Date(QuotaService.periodEndIso()),
          }),
        );
      }
    } catch (error) {
      // 用量记录失败不能影响业务主流程，但必须留下痕迹
      this.logger.error(`用量记录失败（${kind} ${quantity}）：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** 套餐目录（按价格升序；只列出启用中的计划）。 */
  async plansCatalog(): Promise<Plan[]> {
    return this.plans.find({ where: { isActive: true }, order: { priceCents: 'ASC' } });
  }

  /** 当前工作区的有效计划 + 订阅记录。 */
  async currentSubscription(): Promise<{ plan: Plan; subscription: Subscription | null }> {
    const scope = await this.workspaceContext.current();
    const subscription = await this.subscriptions.findOne({
      where: { workspaceId: scope.workspaceId, status: 'active' },
      order: { createdAt: 'DESC' },
    });
    return { plan: await this.effectivePlan(scope.workspaceId), subscription };
  }

  /** 生成（或读取）指定周期的草稿账单；不给周期则用"上一个自然月"。 */
  async draftInvoiceForPeriod(period?: string): Promise<Invoice> {
    const now = new Date();
    let start: Date;
    let end: Date;
    if (period && /^\d{4}-\d{2}$/.test(period)) {
      const [year, month] = period.split('-').map(Number);
      start = new Date(Date.UTC(year, month - 1, 1));
      end = new Date(Date.UTC(year, month, 1));
    } else {
      // 上一个自然月（本月还没走完，账不该先出）
      start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
      end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    }
    return this.ensureDraftInvoice(start, end);
  }

  /** 本工作区账单列表（最新在前）。 */
  async listInvoices(): Promise<Invoice[]> {
    const scope = await this.workspaceContext.current();
    return this.invoices.find({ where: { workspaceId: scope.workspaceId }, order: { createdAt: 'DESC' }, take: 100 });
  }

  /** 周期用量汇总（账单与设置页用）。 */
  async usageBetween(from: Date, to: Date): Promise<Array<{ kind: UsageKind; quantity: number }>> {
    const scope = await this.workspaceContext.current();
    const rows = await this.usage.find({
      where: { tenantId: scope.tenantId, workspaceId: scope.workspaceId, occurredAt: Between(from, to) },
    });
    const totals = new Map<UsageKind, number>();
    for (const row of rows) {
      totals.set(row.kind, (totals.get(row.kind) ?? 0) + Number(row.quantity));
    }
    return [...totals.entries()].map(([kind, quantity]) => ({ kind, quantity }));
  }

  /**
   * 支付渠道接口（B2 接真实渠道时实现它）。
   * B0.7 只提供接口与"空实现"，不接任何支付网关，也不做扣款。
   */
  paymentProvider(): PaymentProvider {
    return new NoopPaymentProvider();
  }

  /** 账单编号生成（幂等：同一工作区同一周期只出一张草稿）。 */
  async ensureDraftInvoice(periodStart: Date, periodEnd: Date): Promise<Invoice> {
    const scope = await this.workspaceContext.current();
    const period = QuotaService.periodOf(new Date(periodStart));
    const number = `INV-${period.replace('-', '')}-${scope.workspaceId.slice(0, 8)}`;
    const existing = await this.invoices.findOne({ where: { number } });
    if (existing) return existing;

    const plan = await this.effectivePlan(scope.workspaceId);
    const subscription = await this.subscriptions.findOne({
      where: { workspaceId: scope.workspaceId, status: 'active' },
      order: { createdAt: 'DESC' },
    });
    const usage = await this.usageBetween(periodStart, periodEnd);
    const lines = [
      {
        description: `${plan.name}（${plan.code}）订阅费用 · ${period}`,
        quantity: 1,
        unitPriceCents: Number(plan.priceCents),
        amountCents: Number(plan.priceCents),
        note: plan.pricingNote,
      },
      ...usage.map((item) => ({
        description: `用量：${KIND_LABELS[item.kind]}`,
        quantity: item.quantity,
        unitPriceCents: 0,
        amountCents: 0,
        note: '用量不计费（定价待 B2 确认）；此处仅记录事实',
      })),
    ];
    const amountCents = lines.reduce((sum, line) => sum + line.amountCents, 0);

    const invoice = await this.invoices.save(
      this.invoices.create({
        tenantId: scope.tenantId,
        workspaceId: scope.workspaceId,
        subscriptionId: subscription?.id ?? null,
        number,
        status: 'draft',
        currency: plan.currency,
        amountCents: String(amountCents),
        periodStart,
        periodEnd,
        issuedAt: null,
        dueAt: null,
        lines,
        externalRef: null,
      }),
    );
    await this.audit
      .record({
        action: 'billing.invoice_draft_created',
        resourceType: 'invoice',
        resourceId: invoice.id,
        tenantId: scope.tenantId,
        workspaceId: scope.workspaceId,
        payload: { number, amountCents, lines: lines.length, period },
      })
      .catch(() => undefined);
    this.logger.log(`已生成草稿账单：${number}（金额 ${amountCents / 100} ${plan.currency}）`);
    return invoice;
  }
}

/** 支付渠道接口：B2 接支付宝/微信/Stripe 时实现，B0.7 只有空实现。 */
export interface PaymentProvider {
  readonly name: string;
  /** 创建支付单（返回渠道侧单号与支付链接）。B0.7 不实现。 */
  createCharge(input: { invoiceId: string; amountCents: number; currency: string }): Promise<{ externalRef: string; payUrl?: string }>;
}

/** 空实现：不接任何支付渠道，调用即抛错（避免"看起来能收款"）。 */
export class NoopPaymentProvider implements PaymentProvider {
  readonly name = 'noop';
  async createCharge(): Promise<{ externalRef: string; payUrl?: string }> {
    throw new Error('尚未接入支付渠道（B0.7 只提供接口；请在 B2 实现 PaymentProvider 并注入）');
  }
}
