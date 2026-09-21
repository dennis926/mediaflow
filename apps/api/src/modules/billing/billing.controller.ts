import { Controller, Get, Post, Query } from '@nestjs/common';
import { AuthUser } from '../auth/auth.types';
import { Capability } from '../auth/capabilities';
import { CurrentUser } from '../auth/current-user.decorator';
import { Plan } from './entities/plan.entity';
import { QuotaService, QuotaStatus } from './quota.service';

/**
 * 计费与配额（B0.7）。
 *
 * 只做**读**与"生成草稿账单"：套餐目录任何登录用户可看；工作区自己的配额/订阅/账单需要 owner/admin
 * （沿用 `workspace.manage` 能力点）；**不接支付渠道**（B2）。
 */
@Controller('billing')
export class BillingController {
  constructor(private readonly quota: QuotaService) {}

  /** 套餐目录（全局可见，用于展示"当前计划 + 可选计划"）。 */
  @Get('plans')
  plans(): Promise<Plan[]> {
    return this.quota.plansCatalog();
  }

  /** 当前工作区的配额状态（已用/上限/重置时间）。 */
  @Capability('workspace.manage')
  @Get('quotas')
  quotasStatus(): Promise<QuotaStatus[]> {
    return this.quota.statusAll();
  }

  /** 当前工作区的有效计划与订阅。 */
  @Capability('workspace.manage')
  @Get('subscription')
  async subscription(): Promise<{ plan: Plan; subscription: unknown }> {
    return this.quota.currentSubscription();
  }

  /** 生成（或读取）本月草稿账单：金额按计划价格计算，用量只记录事实、不计费。 */
  @Capability('workspace.manage')
  @Post('invoices/draft')
  draft(@Query('period') period?: string) {
    return this.quota.draftInvoiceForPeriod(period);
  }

  /** 账单列表（本工作区）。 */
  @Capability('workspace.manage')
  @Get('invoices')
  invoices() {
    return this.quota.listInvoices();
  }

  /** 支付渠道能力说明（B0.7 只有接口，未接入任何渠道）。 */
  @Get('payment-provider')
  provider(@CurrentUser() _user?: AuthUser): { name: string; implemented: boolean; note: string } {
    return {
      name: this.quota.paymentProvider().name,
      implemented: false,
      note: 'B0.7 只提供 PaymentProvider 接口与空实现；接入支付宝/微信/Stripe 属于 B2。',
    };
  }
}
