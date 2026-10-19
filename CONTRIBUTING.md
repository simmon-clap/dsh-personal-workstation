# 贡献指南

感谢你愿意改进个人工作台。这个项目是本地优先的 DSH 插件：数据留在用户机器上，发布物必须保持干净、可复现。

## 开发环境

```bash
npm install       # 需要 Node >= 22.12（推荐 24 LTS）
npm run build:v7  # 从冻结原型生成 src/v7/ 与 src/v7-shell.html
npm test
```

- `src/v7/**` 与 `src/v7-shell.html` 是生成物，**不要手改**；改 UI 请改 `prototype/*.mjs` 后重新构建并提交生成物。
- 构建输入随仓库提供：`prototype/frozen/workbench-v7.html`、`design-system/`、`test/fixtures/registry.json`。
- 完整作者侧门禁 `npm run verify` 依赖仓库外的内部规范与视觉基线；公开环境请至少保证
  `npm test`、`node prototype/public-repo-check.mjs`、`node prototype/private-data-guard.mjs` 通过。

## 提交前

- [ ] 已提交前重新执行 `npm run build:v7`，并确认 `git status` 干净。
- [ ] `npm test` 通过。
- [ ] 没有把业务数据、录音/纪要、真实客户名、作者绝对路径、内网地址、工作区 ID 或凭据写进仓库。
- [ ] 新增界面文案使用用户能懂的话，不出现内部术语。
- [ ] 行为变化有对应测试；门禁失败不是靠放宽断言修好的。

## 隐私边界

- 不要在 issue / PR / 提交信息里粘贴真实业务数据或本机路径；需要复现时请用最小化的合成示例。
- 发现仓库或发布物包含敏感信息时，请按 [SECURITY.md](SECURITY.md) 私下报告，不要开公开 issue。

## 许可证

提交即表示你同意以本仓库的 MIT 许可证发布你的贡献。
