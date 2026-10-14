// 通过 GitHub Contents API 推送整个目录（适用于 github.com 443 被屏蔽但 api.github.com 可用的网络）
// 安全规则（2026-10-14 事故修复）：
//   1. 部署前先把「机器人拥有的数据文件」从远程同步回本地——quant-bot 的 6h 训练 / 1h 消息面
//      快照直接提交在远程 main，盲目上传本地旧副本会把新模型覆盖回旧版（v11→v9 事故）
//   2. 本地对这些文件有未提交改动时视为「有意修改」，保留本地并打印警告
//   3. 内容未变化的文件跳过上传，避免每次部署产生几十个空提交
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join, relative } from 'path';
import { execSync } from 'child_process';

const TOKEN = process.env.GH_TOKEN;
const OWNER = 'dongshg3', REPO = 'binance-quant';
const ROOT = process.cwd();
const EXCLUDE = ['.git', 'node_modules', 'dist', 'deploy-via-api.mjs', '.repo-create.json', '__pycache__', 'data_cache'];
// 机器人（GitHub Actions）拥有的数据产物：远程为准
const BOT_OWNED = ['data/model.json', 'data/evolution.json', 'data/news.json', 'data/news_history.json'];

const headers = {
  'Authorization': `token ${TOKEN}`,
  'Accept': 'application/vnd.github+json',
  'Content-Type': 'application/json',
  'User-Agent': 'kimi-deploy-script',
};

async function api(method, path, body) {
  const res = await fetch(`https://api.github.com${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) throw new Error(`${method} ${path} => ${res.status}: ${json.message || text.slice(0, 200)}`);
  return json;
}

function walk(dir, base = dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (EXCLUDE.includes(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p, base));
    else out.push(relative(base, p).replace(/\\/g, '/'));
  }
  return out;
}

function gitDirty(rel) {
  try { return execSync(`git status --porcelain -- "${rel}"`, { cwd: ROOT }).toString().trim().length > 0; }
  catch { return false; }
}
function localBlobSha(rel) {
  try { return execSync(`git hash-object "${rel}"`, { cwd: ROOT }).toString().trim(); } catch { return null; }
}

// ---- 第 1 步：同步机器人拥有的数据文件（远程 → 本地） ----
console.log('同步云端数据产物…');
for (const f of BOT_OWNED) {
  try {
    const cur = await api('GET', `/repos/${OWNER}/${REPO}/contents/${encodeURI(f)}?ref=main`);
    const remoteBuf = Buffer.from((cur.content || '').replace(/\n/g, ''), 'base64');
    const localPath = join(ROOT, f);
    const localBuf = existsSync(localPath) ? readFileSync(localPath) : null;
    if (localBuf && localBuf.equals(remoteBuf)) { console.log(`  ${f} 一致`); continue; }
    if (localBuf && gitDirty(f)) { console.log(`  ⚠ ${f} 本地有未提交改动，保留本地版本（远程将被覆盖）`); continue; }
    writeFileSync(localPath, remoteBuf);
    console.log(`  ${f} 已同步远程最新版本到本地`);
  } catch (e) {
    console.log(`  ${f} 远程不存在或拉取失败，使用本地版本`);
  }
}

// ---- 第 2 步：逐个上传（跳过内容未变化的文件） ----
const files = walk(ROOT);
console.log(`扫描 ${files.length} 个文件…`);
let pushed = 0, skipped = 0;
for (const f of files) {
  const content = readFileSync(join(ROOT, f)).toString('base64');
  let sha;
  try {
    const cur = await api('GET', `/repos/${OWNER}/${REPO}/contents/${encodeURI(f)}?ref=main`);
    sha = cur.sha;
    const lsha = localBlobSha(f);
    if (lsha && lsha === sha) { skipped++; continue; }  // 内容一致，跳过
  } catch (e) { /* 远程不存在 → 新建 */ }
  await api('PUT', `/repos/${OWNER}/${REPO}/contents/${encodeURI(f)}`, {
    message: `deploy: ${f}`,
    content,
    branch: 'main',
    ...(sha ? { sha } : {}),
  });
  pushed++;
  process.stdout.write('.');
}
console.log(`\n上传 ${pushed} 个变更文件，跳过 ${skipped} 个未变化文件`);

// 开启 GitHub Pages（main 分支根目录）
try {
  const pages = await api('POST', `/repos/${OWNER}/${REPO}/pages`, { source: { branch: 'main', path: '/' } });
  console.log('Pages 已开启:', pages.html_url);
} catch (e) {
  if (e.message.includes('409')) console.log('Pages 已存在，跳过');
  else console.log('Pages 开启结果:', e.message);
}

console.log('\n✅ 部署完成');
console.log('仓库: https://github.com/dongshg3/binance-quant');
console.log('网站: https://dongshg3.github.io/binance-quant/');
