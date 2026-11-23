import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

// Vite 负责页面与模块；云端生成的只读 JSON 作为静态资产原样发布。
// 注意：Node 24 在 Windows 上调用 fs.cpSync 会原生崩溃（0xC0000409），
// 所以这里改成逐文件 copyFileSync，行为等价且稳定。
const root = resolve(import.meta.dirname, '..');
const source = resolve(root, 'data');
const target = resolve(root, 'dist', 'data');

if (!existsSync(resolve(root, 'dist', 'index.html'))) throw new Error('dist/index.html 缺失');
if (!existsSync(source)) throw new Error('data 目录缺失');

function walk(from, to) {
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(from)) {
    const s = resolve(from, name);
    const d = resolve(to, name);
    if (statSync(s).isDirectory()) walk(s, d);
    else copyFileSync(s, d);
  }
}

walk(source, target);
console.log('静态数据已复制到 dist/data');
