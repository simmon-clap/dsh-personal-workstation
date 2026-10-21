# 发布流程

> 目标：一次发布 = 可复现的 tarball + 校验和 + git tag + 可核对的发布清单。
> 发布脚本会先构建、再校验工作树干净，避免"仓库/发布包/已装包"三者不一致。

## 1 · 前置

- 版本已递增（`package.json`、`CHANGELOG.md`），且 `CHANGELOG.md` 含当前版本号。
- 工作树干净（所有改动已提交）。发布脚本会在构建后再检查一次 —— 生成物与源码不一致时发布会停下。
- 公开文档齐全：`README.md`、`CHANGELOG.md`、`LICENSE`。
- `cordis.patch.yml` 仍是**模板**（只含 `/ABSOLUTE/PATH/...`、`YOUR-WORKSPACE-ID` 等占位符，不含个人配置）。
- 建议在发布前跑一遍：

  ```bash
  npm install
  npm run build:v7
  npm test
  node prototype/public-repo-check.mjs
  node prototype/private-data-guard.mjs
  ```

## 2 · 打包、校验和与 tag

```bash
cd workstation
node scripts/release.mjs --dry-run   # 只做发布前检查：干净树、tag 未占用、元数据完整
node scripts/release.mjs             # 构建 → 校验干净 → 打包 → SHA256SUMS → 打 tag v<version>
```

- 产物：`releases/dsh-personal-workstation-<version>.tgz` 与 `releases/SHA256SUMS`。
- `scripts/release.mjs` 会先执行 `npm run build:v7`，再校验：
  - 构建后 `git status --porcelain` 为空（生成物已提交且与源码一致）；
  - 包内文件数与「仓库里会发布的那份清单」一致（防止 45 个过期生成物被静默打进包）；
  - 同版本 tag 未被占用（不覆盖已有发布）。
- 打包写入临时目录后再落到 `releases/`；`releases/` 已被 `.gitignore` 排除。

## 3 · 推送公开仓库与 GitHub Release

```bash
/usr/bin/git remote add origin https://github.com/simmon-clap/dsh-personal-workstation.git
/usr/bin/git push -u origin main
/usr/bin/git push origin v<version>
```

GitHub Release 只挂**本次新构建**的产物：

1. 新建 Release，选 tag `v<version>`；
2. 上传 `releases/dsh-personal-workstation-<version>.tgz` 与 `releases/SHA256SUMS`；
3. 正文直接引用 `CHANGELOG.md` 对应段落；
4. **不要把本地 `releases/` 里的历史 tgz 批量上传**：早期包可能包含内部文档或作者环境配置，
   只允许本次由发布脚本重新打出的那一份公开。

## 4 · 发布后验证与回滚

- 安装验证：按 `README.md` 的步骤装到 DSH profile 并重启；用 `node prototype/live-acceptance.mjs`
  （或 `WORKSTATION_ORIGIN=...` 指定实例）核对"看到的 = 装的"。
- 回滚：保留上一版 tgz + 数据库 `.backup`；把 profile 依赖指回旧 tgz 并重启。
- 数据回滚：`sqlite3 <db> ".backup <dest>"`（WAL 模式下直接 `cp` 会拿到旧快照）。

## 5 · 已知边界

- 发布物只带代码、公开文档与配置模板；`design-system/`、`prototype/`、`test/` 不随包发布。
- 作者侧完整门禁 `npm run verify` 的若干项依赖内部规范与视觉基线，不在公开仓库内；
  公开 CI 覆盖构建、测试与两个卫生检查，不等于完整产品验收。
