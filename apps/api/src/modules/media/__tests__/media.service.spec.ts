import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { MediaService, detectMimeType } from '../media.service';
import { applyRuntimeConfig, runtime } from '../../settings/runtime-config';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(8)]);
const GIF = Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1');

describe('素材库文件类型校验', () => {
  const service = new MediaService({} as never, {} as never, {} as never);

  it('按文件头识别真实类型', () => {
    expect(detectMimeType(PNG)).toBe('image/png');
    expect(detectMimeType(JPEG)).toBe('image/jpeg');
    expect(detectMimeType(GIF)).toBe('image/gif');
    expect(detectMimeType(MP4)).toBe('video/mp4');
    expect(detectMimeType(Buffer.from('MZ\x00\x00'))).toBeNull();
  });

  it('伪装成图片的可执行文件被拒绝（不能只信声明类型）', () => {
    applyRuntimeConfig({});
    const fake = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(64)]);
    expect(() => service.assertAllowed('image/png', fake.length, fake)).toThrow(BadRequestException);
    expect(() => service.assertAllowed('image/png', fake.length, fake)).toThrow(/无法识别的文件内容/);
  });

  it('真实类型不在白名单时被拒绝', () => {
    applyRuntimeConfig({ MEDIA_ALLOWED_TYPES: 'image/png' });
    expect(() => service.assertAllowed('video/mp4', MP4.length, MP4)).toThrow(/不支持的文件类型/);
    expect(() => service.assertAllowed('image/png', PNG.length, PNG)).not.toThrow();
    applyRuntimeConfig({});
  });

  it('声明类型与内容不符时被拒绝（改名绕过）', () => {
    applyRuntimeConfig({});
    expect(() => service.assertAllowed('image/jpeg', PNG.length, PNG)).toThrow(/不符/);
  });

  it('超过大小上限时被拒绝，且上限可配置', () => {
    applyRuntimeConfig({ MEDIA_MAX_FILE_MB: '1' });
    const big = Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024)]);
    expect(() => service.assertAllowed('image/png', big.length, big)).toThrow(/文件过大/);
    expect(runtime().media.maxFileMb).toBe(1);
    applyRuntimeConfig({});
  });
});
