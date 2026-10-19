## 做了什么

<!-- 一句话说明这个改动解决的问题。 -->

## 验证方式

- [ ] `npm test` 通过
- [ ] 提交前执行过 `npm run build:v7`，且 `git status` 干净
- [ ] `node prototype/public-repo-check.mjs` 通过
- [ ] `node prototype/private-data-guard.mjs` 通过

## 边界检查

- [ ] 没有提交业务数据、真实客户名、作者绝对路径、内网地址、工作区 ID 或凭据
- [ ] 没有手改 `src/v7/**` 或 `src/v7-shell.html`（如改了，附重新构建说明）
- [ ] 用户可见行为有测试或说明为什么不需要
