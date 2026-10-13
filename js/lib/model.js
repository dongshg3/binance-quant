// ============================================================
// model.js · 学习模型加载器
// 每 6 小时由 GitHub Actions 重新训练并发布 data/model.json，
// 前端每次加载拉取最新权重，自动应用最新模型。
// ============================================================
import { setModel } from './quant.js';
import { icon } from './ui.js';

let cached = null;

export async function loadModel() {
  try {
    const res = await fetch('data/model.json?t=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) return null;
    const model = await res.json();
    if (!model || !model.weights) return null;
    cached = model;
    setModel(model);
    return model;
  } catch (e) {
    return null; // 模型文件不存在或网络问题 → 使用静态权重
  }
}

export function getModel() { return cached; }

export function modelBadgeHTML() {
  if (!cached) {
    return '<span class="chip flat" title="权重为手工设定的静态值">权重: 静态</span>';
  }
  const d = new Date(cached.trainedAt);
  const ageH = (Date.now() - d.getTime()) / 36e5;
  const ageTxt = ageH < 1 ? `${Math.round(ageH * 60)} 分钟前` : ageH < 48 ? `${ageH.toFixed(1)} 小时前` : `${Math.round(ageH / 24)} 天前`;
  const ic = cached.oos && (cached.oos.icXS ?? cached.oos.ic) != null ? ` · XS IC ${cached.oos.icXS ?? cached.oos.ic}` : '';
  return `<span class="chip trend" title="权重由岭回归从历史数据学习 · 样本外 IC ${cached.oos?.ic ?? '—'} · 训练于 ${d.toLocaleString()}">${icon('cpu')} 学习权重 v${cached.version} · ${ageTxt}${ic}</span>`;
}
