# 口径对齐验证（同源数据版）：前端 JS 因子引擎 vs 云端训练 Python 特征管线
#
# 用法：
#   1. python train/parity_fetch.py            # 拉取合约 K 线 + 资金费率 → train/parity_klines.json
#   2. 浏览器打开本地站点，在控制台执行 train/parity_browser_snippet.js 的内容
#      （或通过 InAppBrowser evaluate），把返回的 JSON 存为 train/parity_js.json
#   3. python train/parity_check.py            # 对比，输出 PASS/FAIL
#
# 判定：composite 差异 < 0.001 为口径一致（2026-10-14 实测 max 7.1e-15，浮点噪声级）
import json, sys, os
import numpy as np
import importlib.util

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
spec = importlib.util.spec_from_file_location("train_mod", os.path.join(os.path.dirname(os.path.abspath(__file__)), "train.py"))
train = importlib.util.module_from_spec(spec)
spec.loader.exec_module(train)  # main() 有 __name__ 保护，安全

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
model = json.load(open(os.path.join(ROOT, 'data/model.json'), encoding='utf-8'))
GROUPS = train.GROUPS

def resolve_weights(sym):
    """与前端 pickWeights 相同的优先级：逐币 > 板块 > 规模 > 全局"""
    cm = model.get('coinModels') or {}
    if sym in cm and cm[sym].get('weights'):
        return cm[sym]['weights'], cm[sym].get('scoreScale', 0)
    meta = (model.get('symbolMeta') or {}).get(sym)
    if meta and model.get('segments'):
        for kind in ('cat', 'size'):
            seg = model['segments'].get(f"{kind}:{meta[kind]}")
            if seg and seg.get('good') and seg.get('weights'):
                return seg['weights'], seg.get('scoreScale', 0)
    return model['weights'], model.get('scoreScale', 0)

kl = json.load(open(os.path.join(ROOT, 'train/parity_klines.json')))
js = {r['sym']: r for r in json.load(open(os.path.join(ROOT, 'train/parity_js.json')))}

max_g = {g: 0.0 for g in GROUPS}
cds = []
print(f"{'symbol':11s} {'py_comp':>11s} {'js_comp':>11s} {'diff':>9s} {'max组差':>9s} 来源")
for sym, d in kl.items():
    if sym not in js:
        continue
    o = np.array([[0.0] + row for row in d['ohlcv']], dtype=float)
    n = len(o)
    # 前端只在最后一根 bar 应用当前资金费率；ls/oi 两端均无（None → 中性 0）
    fut = ([None] * (n - 1) + [d['fr']], [None] * n, [None] * n)
    out, _ = train.group_scores(o, fut)
    for g in GROUPS:
        max_g[g] = max(max_g[g], abs(float(out[g][-1]) - js[sym]['groups'][g]))
    w, scale = resolve_weights(sym)
    comp = sum(float(w.get(g, 0.0)) * float(out[g][-1]) for g in GROUPS)
    if scale and scale > 0:
        comp = comp / scale * 0.13
    cd = abs(comp - js[sym]['composite'])
    cds.append(cd)
    ws = js[sym].get('ws') or {}
    print(f"{sym:11s} {comp:11.6f} {js[sym]['composite']:11.6f} {cd:9.2e} "
          f"{max(abs(float(out[g][-1]) - js[sym]['groups'][g]) for g in GROUPS):9.2e} {ws.get('kind')}/{ws.get('key')}")

print()
print('各组最大差异:', json.dumps({g: round(v, 10) for g, v in max_g.items()}))
print(f"composite 差异: max={max(cds):.3e} mean={sum(cds)/len(cds):.3e} n={len(cds)}")
print('判定:', 'PASS（口径一致）' if max(cds) < 0.001 else 'FAIL（存在口径漂移，需排查指标实现）')
