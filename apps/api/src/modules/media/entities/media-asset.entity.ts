import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '../../../database/base.entity';

export type MediaKind = 'image' | 'video' | 'audio' | 'file';

/**
 * 素材库：发布到抖音/小红书等平台必须带本地图片或视频，
 * 之前只能手填外链，等于主流程走不通。这里保存上传记录，磁盘文件按 uuid 命名。
 */
@Entity('media_assets')
export class MediaAsset extends BaseEntity {
  /** 磁盘上的文件名（uuid + 扩展名，避免中文/冲突） */
  @Column({ type: 'varchar', length: 200 })
  storedName!: string;

  /** 上传时的原始文件名，便于运营辨认 */
  @Column({ type: 'varchar', length: 255 })
  originalName!: string;

  @Column({ type: 'varchar', length: 120 })
  mimeType!: string;

  @Index()
  @Column({ type: 'varchar', length: 20 })
  kind!: MediaKind;

  /** 字节数 */
  @Column({ type: 'bigint' })
  size!: string;

  /** 对外可访问地址（可能是本站 /api/public/media/xxx，也可能是配置的 CDN 前缀） */
  @Column({ type: 'varchar', length: 512 })
  url!: string;

  /** 上传者（用户 id 与显示名），便于追责 */
  @Column({ type: 'uuid', nullable: true })
  uploadedBy!: string | null;

  @Column({ type: 'varchar', length: 80, nullable: true })
  uploadedByName!: string | null;

  /** 备注/分组标签，方便按项目归类素材 */
  @Column({ type: 'varchar', length: 80, nullable: true })
  groupName!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  deletedAt!: Date | null;
}
