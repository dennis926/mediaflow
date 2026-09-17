import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Max, Min } from 'class-validator';

export type ReviewDecision = 'approved' | 'rejected' | 'changes_requested';
export type ReviewStatusFilter = 'pending' | 'approved' | 'rejected' | 'changes_requested';

export const REVIEW_CHECKLIST_KEYS = ['compliance', 'aiDisclosure', 'facts', 'typos', 'brandVoice'] as const;
export type ReviewChecklistKey = (typeof REVIEW_CHECKLIST_KEYS)[number];

export class SubmitReviewDto {
  @IsUUID('4', { message: 'contentId 必须是合法的 UUID' })
  contentId!: string;

  @IsOptional()
  @IsString()
  @Length(1, 500)
  comments?: string;
}

export class ReviewChecklistDto {
  @IsOptional()
  @IsBoolean()
  compliance?: boolean;

  @IsOptional()
  @IsBoolean()
  aiDisclosure?: boolean;

  @IsOptional()
  @IsBoolean()
  facts?: boolean;

  @IsOptional()
  @IsBoolean()
  typos?: boolean;

  @IsOptional()
  @IsBoolean()
  brandVoice?: boolean;
}

export class ReviewDecisionDto {
  @IsIn(['approved', 'rejected', 'changes_requested'], { message: '审核结论不合法' })
  decision!: ReviewDecision;

  @IsOptional()
  @IsString()
  @Length(1, 500)
  comments?: string;

  @IsOptional()
  @Type(() => ReviewChecklistDto)
  checklist?: ReviewChecklistDto;
}

export class QueryReviewDto {
  @IsOptional()
  @IsIn(['pending', 'approved', 'rejected', 'changes_requested'])
  status?: ReviewStatusFilter;

  @IsOptional()
  @IsUUID('4')
  contentId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number = 20;
}
