# 币安量化系统 · Binance Quant

**🌐 线上地址：https://dongshg3.github.io/binance-quant/**

纯前端量化交易分析系统，数据直连币安公开 API，无需密钥、无需后端，GitHub Pages 一键部署。内置网络自适应：合约 API 不可达时自动降级到币安官方现货镜像，WebSocket 被屏蔽时自动切换 REST 轮询。

## 功能

| 页面 | 内容 |
|---|---|
| `index.html` | 深度分析：多因子信号、蒙特卡洛价格锥预测、Holt/回归预测、多周期共振、条件胜率、ATR 风险管理、合约数据（资金费率/多空比/持仓量） |
| `screener.html` | 全市场扫描：覆盖全部 USDT 永续合约（或现货），八并发、可排序、机会自动挖掘、市场宽度 |
| `backtest.html` | 回测中心：含手续费/滑点/资金费率的滚动回测，夏普/索提诺/最大回撤/卡玛/信号命中率，对比买入持有 |
| `strategy.html` | 策略方法论：完整公开的因子、权重、公式与风控规则 |

## 量化框架

七因子加权评分（趋势 25% · 动量 20% · 均值回归 15% · 量能 15% · 波动率 10% · 合约数据 10% · 位置 5%）→ 市场状态识别（ADX + Kaufman ER + Hurst）→ 概率预测（蒙特卡洛 4000 路径 + Holt 阻尼平滑 + 对数回归通道）→ 仓位管理（目标波动率 + 半 Kelly + ATR 止损）。

## 本地预览

```bash
npm install
npm run dev
```

默认打开 http://localhost:7100/ 。也可直接用任意静态服务器打开 `index.html`。

## 部署到 GitHub Pages

1. 在 GitHub 新建仓库（如 `binance-quant`）
2. 推送本目录：
   ```bash
   git init && git add -A && git commit -m "Binance quant system"
   git branch -M main
   git remote add origin https://github.com/<你的用户名>/binance-quant.git
   git push -u origin main
   ```
3. 仓库 Settings → Pages → Source 选 `main` 分支根目录，保存
4. 访问 `https://<你的用户名>.github.io/binance-quant/`

仓库已含 `.nojekyll`，无需构建——Pages 直接托管源码即可（`npm run build` 仅在你想用打包版时使用）。

## 免责声明

本项目仅供量化研究与学习，不构成投资建议。回测与预测基于历史数据的统计推断，不代表未来收益。加密货币合约交易风险极高，请自行承担全部风险。
