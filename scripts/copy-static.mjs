import { cpSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

// Vite 负责页面与模块；云端生成的只读 JSON 作为静态资产原样发布。
const root = resolve(import.meta.dirname, '..');
const source = resolve(root, 'data');
const target = resolve(root, 'dist', 'data');
if (!existsSync(resolve(root, 'dist', 'index.html'))) throw new Error('dist/index.html 缺失');
cpSync(source, target, { recursive: true, force: true, dereference: false });
console.log('静态数据已复制到 dist/data');
