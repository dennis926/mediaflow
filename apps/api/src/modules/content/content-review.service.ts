import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ContentStatus } from '@mediaflow/shared';
import { DataSource, Repository } from 'typeorm';
import { AuditService } from '../../audit/audit.service';
import { WorkspaceContextService } from '../../common/workspace-context.service';
import { NotificationService } from '../notification/notification.service';
import { Content } from './entities/content.entity';
import { ContentReview, ReviewStatus } from './entities/content-review.entity';
import { QueryReviewDto, ReviewDecisionDto, SubmitReviewDto } from './dto/review.dto';

export interface ReviewActor {
  id?: string | null;
  name?: string | null;
}

export interface ReviewView extends ContentReview {
  contentTitle?: string;
}

export interface ReviewPage {
  items: ReviewView[];
  meta: { page: number; pageSize: number; total: number; totalPages: number };
  pendingCount: number;
}

const CHECKLIST_LABELS: Record<string, string> = {
  compliance: '合规表述',
  aiDisclosure: 'AI 标识',
  facts: '事实准确性',
  typos: '文字差错',
  brandVoice: '品牌口吻',
};

/** 内容审核工作流：提交 → 审核 → 通过后才可进入发布（发布侧按配置校验）。 */
@Injectable()
export class ContentReviewService {
  private readonly logger = new Logger(ContentReviewService.name);

  constructor(
    @InjectRepository(Content) private readonly contents: Repository<Content>,
    @InjectRepository(ContentReview) private readonly reviews: Repository<ContentReview>,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
    private readonly workspaceContext: WorkspaceContextService,
    private readonly dataSource: DataSource,
  ) {}

  /** 提交审核：内容必须非空；同一内容不允许存在多条待审核记录。 */
  async submit(dto: SubmitReviewDto, actor: ReviewActor): Promise<ContentReview> {
    const scope = await this.workspaceContext.current();
    const content = await this.contents.findOne({ where: { id: dto.contentId, workspaceId: scope.workspaceId } });
    if (!content) throw new NotFoundException('内容不存在');
    if (content.status === ContentStatus.Archived) throw new BadRequestException('已归档内容不能提交审核');
    if (!content.title.trim() || !content.body.trim()) throw new BadRequestException('标题和正文不能为空才能提交审核');

    const pending = await this.reviews.findOne({ where: { contentId: content.id, status: 'pending' } });
    if (pending) throw new BadRequestException(`该内容已有待审核记录（第 ${pending.round} 轮），请先处理`);

    const maxRound = await this.reviews
      .createQueryBuilder('review')
      .select('MAX(review.round)', 'max')
      .where('review.contentId = :id', { id: content.id })
      .getRawOne<{ max: string | null }>();

    const review = await this.reviews.save(
      this.reviews.create({
        tenantId: scope.tenantId,
        workspaceId: scope.workspaceId,
        contentId: content.id,
        submittedBy: actor.id ?? null,
        submittedByName: actor.name ?? null,
        reviewerId: null,
        reviewerName: null,
        round: Number(maxRound?.max ?? 0) + 1,
        status: 'pending',
        comments: dto.comments ?? null,
        checklist: {},
        decidedAt: null,
      }),
    );

    await this.contents.update({ id: content.id }, { status: ContentStatus.Reviewing });
    await this.record('review.submit', review, actor, { round: review.round, title: content.title, comments: dto.comments ?? null });
    await this.notifications.notify({
      type: 'review.submitted',
      level: 'info',
      title: `内容待审核：${content.title}`,
      body: `${actor.name ?? '成员'} 提交了第 ${review.round} 轮审核${dto.comments ? `，说明：${dto.comments}` : ''}`,
      resourceType: 'content_review',
      resourceId: review.id,
      payload: { contentId: content.id, round: review.round },
    });

    this.logger.log(`内容进入审核：${content.title}（第 ${review.round} 轮）`);
    return review;
  }

  async list(query: QueryReviewDto): Promise<ReviewPage> {
    const scope = await this.workspaceContext.current();
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;

    // 用实体关系 join，TypeORM 才会把 content.title 映射到 review.content（手写 join 取不到值）
    const builder = this.reviews
      .createQueryBuilder('review')
      .leftJoin('review.content', 'content')
      .addSelect(['content.id', 'content.title'])
      .where('review.workspaceId = :workspaceId', { workspaceId: scope.workspaceId });

    if (query.status) builder.andWhere('review.status = :status', { status: query.status });
    if (query.contentId) builder.andWhere('review.contentId = :contentId', { contentId: query.contentId });

    builder.orderBy('review.createdAt', 'DESC').skip((page - 1) * pageSize).take(pageSize);
    const [items, total] = await builder.getManyAndCount();
    const pendingCount = await this.reviews.count({ where: { workspaceId: scope.workspaceId, status: 'pending' } });

    return {
      items: items.map((review) => Object.assign(review, { contentTitle: review.content?.title })),
      meta: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) || 1 },
      pendingCount,
    };
  }

  /** 详情：始终按工作区过滤，避免跨工作区越权读取。 */
  async get(id: string): Promise<ReviewView> {
    const scope = await this.workspaceContext.current();
    const review = await this.reviews.findOne({ where: { id, workspaceId: scope.workspaceId } });
    if (!review) throw new NotFoundException('审核记录不存在');
    const content = await this.contents.findOne({ where: { id: review.contentId } });
    return Object.assign(review, { contentTitle: content?.title });
  }

  async history(contentId: string): Promise<ContentReview[]> {
    const scope = await this.workspaceContext.current();
    const content = await this.contents.findOne({ where: { id: contentId, workspaceId: scope.workspaceId } });
    if (!content) throw new NotFoundException('内容不存在');
    return this.reviews.find({ where: { contentId, workspaceId: scope.workspaceId }, order: { round: 'DESC' } });
  }

  /**
   * 审核结论。约束：
   * 1. 只能处理待审核记录；
   * 2. 不能审核自己提交的内容（职责分离）；
   * 3. 驳回/要求修改必须写明原因，否则提交人无从修改。
   */
  async decide(id: string, dto: ReviewDecisionDto, actor: ReviewActor): Promise<ReviewView> {
    const scope = await this.workspaceContext.current();
    const review = await this.reviews.findOne({ where: { id, workspaceId: scope.workspaceId } });
    if (!review) throw new NotFoundException('审核记录不存在');
    if (review.status !== 'pending') throw new BadRequestException('该审核记录已处理');
    if (review.submittedBy && actor.id && review.submittedBy === actor.id) {
      throw new ForbiddenException('不能审核自己提交的内容，请由其他成员审核');
    }
    if (dto.decision !== 'approved' && !dto.comments?.trim()) {
      throw new BadRequestException('驳回或要求修改时必须填写原因');
    }

    review.status = dto.decision as ReviewStatus;
    review.comments = dto.comments?.trim() ?? review.comments;
    review.reviewerId = actor.id ?? null;
    review.reviewerName = actor.name ?? null;
    review.checklist = (dto.checklist ?? review.checklist ?? {}) as Record<string, boolean>;
    review.decidedAt = new Date();

    const nextStatus =
      dto.decision === 'approved' ? ContentStatus.Approved : dto.decision === 'rejected' ? ContentStatus.Rejected : ContentStatus.Draft;

    // 审核记录与内容状态必须同时生效，否则会出现"审核已通过但内容仍是草稿"这类不一致。
    const saved = await this.dataSource.transaction(async (manager) => {
      const persisted = await manager.save(review);
      await manager.update(Content, { id: review.contentId }, { status: nextStatus });
      return persisted;
    });

    const content = await this.contents.findOne({ where: { id: review.contentId } });
    if (content) {

      await this.notifications.notify({
        type: `review.${dto.decision}`,
        level: dto.decision === 'approved' ? 'info' : 'warning',
        title: dto.decision === 'approved' ? `审核通过：${content.title}` : `审核未通过：${content.title}`,
        body:
          dto.decision === 'approved'
            ? `${actor.name ?? '审核人'} 通过了第 ${review.round} 轮审核`
            : `${actor.name ?? '审核人'} ${dto.decision === 'rejected' ? '驳回' : '要求修改'}：${review.comments ?? ''}`,
        resourceType: 'content',
        resourceId: content.id,
        payload: { contentId: content.id, round: review.round, decision: dto.decision },
      });
    }

    await this.record(`review.${dto.decision}`, review, actor, {
      contentId: review.contentId,
      round: review.round,
      decision: dto.decision,
      checklist: review.checklist,
    });
    this.logger.log(`审核结论：${review.id} → ${dto.decision}`);
    return this.get(saved.id);
  }

  /** 供内容列表/编辑器展示「最近一次审核意见」。 */
  async latestReviewOf(contentId: string): Promise<ContentReview | null> {
    const scope = await this.workspaceContext.current();
    return this.reviews.findOne({
      where: { contentId, workspaceId: scope.workspaceId },
      order: { round: 'DESC' },
    });
  }

  checklistLabels(): Record<string, string> {
    return CHECKLIST_LABELS;
  }

  private async record(action: string, review: ContentReview, actor: ReviewActor, payload: Record<string, unknown>): Promise<void> {
    await this.audit.record({
      action,
      resourceType: 'content_review',
      resourceId: review.id,
      tenantId: review.tenantId,
      workspaceId: review.workspaceId,
      actorId: actor.id ?? null,
      actorName: actor.name ?? null,
      payload,
    });
  }
}
