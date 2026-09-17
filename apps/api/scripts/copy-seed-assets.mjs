import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// tsc 不会拷贝 JSON，种子数据文件需要手动带到 dist（否则部署后读不到示例资料）。
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(root, 'src/database/seeds');
const target = join(root, 'dist/database/seeds');

if (!existsSync(source)) process.exit(0);
mkdirSync(target, { recursive: true });

let copied = 0;
for (const name of readdirSync(source)) {
  if (!name.endsWith('.json')) continue;
  copyFileSync(join(source, name), join(target, name));
  copied += 1;
}
process.stdout.write(`已复制 ${copied} 个种子数据文件到 dist\n`);
