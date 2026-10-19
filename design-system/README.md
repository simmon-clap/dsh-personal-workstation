# 设计资产（vendored 子集）

本目录是 dsh-personal-workstation 公开仓库自带的**设计系统最小子集**，用于让干净 clone 能执行
`npm run build:v7` 与测试。它不是设计系统的完整副本：只保留构建/门禁真正读取的文件。

- 来源：仓库外的工作区设计系统（`design-system/` 与 `paper-glass/`），按原文件逐字复制。
- 包含：`tokens.css` / `tokens.json` / `v7-visual.css` / `v7-host-theme.css`、`V7-视觉应用.html`（几何/像素门禁的参考页，示例文案已中性化）、
  `paper-glass/tokens.css` 与图标精灵输入（`paper-glass/icons`、`paper-glass/icons-extra`）、
  `assets/icons`（35 个）、`assets/illustrations`（8 个）、品牌标识（`mark*.svg` / `wordmark.svg` / `app-icon.svg`）。
- 不含：设计手册 HTML、组件总览、截图、构建脚本与完整组件库（这些不参与本仓库的构建与测试）。
- 这些是界面资产，不含业务数据。改视觉请改源设计系统后重新复制，不要只改这里。
