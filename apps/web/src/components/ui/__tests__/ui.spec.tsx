// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Button } from '../Button';
import { Card } from '../Card';
import { Input } from '../Field';
import { Tag } from '../Tag';

describe('UI 组件', () => {
  it('Button 支持变体、尺寸与加载态', () => {
    const { rerender } = render(<Button variant="primary" size="lg">保存</Button>);
    const button = screen.getByRole('button', { name: '保存' });
    expect(button.className).toContain('sizeLg');

    rerender(<Button loading>保存</Button>);
    expect(screen.getByRole('button').hasAttribute('disabled')).toBe(true);
  });

  it('Input / Card / Tag 正常渲染', () => {
    render(
      <Card title="卡片标题">
        <Input label="标题" name="title" placeholder="请输入" />
        <Tag tone="success">已完成</Tag>
      </Card>,
    );

    expect(screen.getByText('卡片标题')).toBeTruthy();
    expect(screen.getByPlaceholderText('请输入')).toBeTruthy();
    expect(screen.getByText('已完成')).toBeTruthy();
  });
});

function collectStyledFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      return entry === '__tests__' ? [] : collectStyledFiles(path);
    }
    return path.endsWith('.css') || path.endsWith('.tsx') ? [path] : [];
  });
}

describe('设计令牌约束', () => {
  it('tokens.css 提供完整变量', () => {
    const css = readFileSync(join(process.cwd(), '../../packages/design-tokens/dist/tokens.css'), 'utf8');
    for (const variable of ['--mf-color-brand-500', '--mf-space-4', '--mf-radius-md', '--mf-font-size-md']) {
      expect(css).toContain(variable);
    }
  });

  it('界面代码不硬编码颜色（只能引用 var(--mf-*) 或 tokens）', () => {
    const files = collectStyledFiles(join(process.cwd(), 'src'));
    const offenders: string[] = [];
    for (const file of files) {
      const content = readFileSync(file, 'utf8');
      // Hex colours and rgb() literals are forbidden outside the token package.
      if (/#[0-9a-fA-F]{3,8}\b/.test(content) || /rgb\(/.test(content)) offenders.push(file.replace(process.cwd(), ''));
    }
    expect(offenders).toEqual([]);
  });
});
