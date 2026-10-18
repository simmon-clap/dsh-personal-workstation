# 发布流程（W4）

> 目标：一次发布 = 可复现的 tarball + 校验和 + 本地 tag + 干净机器安装验证。发布前先过 W5 终验。

## 1 · 前置

- 工作树干净（所有改动已提交）；版本已递增（`package.json` / `CHANGELOG.md`）。
- `npm test`、`npm run verify` 全绿；`npm run verify:clean-install`、`npm run verify:public` 通过。
- `cordis.patch.yml` 仍是**模板**（不含作者绝对路径/个人工作区 ID）。

## 2 · 打包与打 tag

```bash
cd workstation
node scripts/release.mjs            # 打包 + SHA256SUMS + 本地 tag v<version>
node scripts/release.mjs --dry-run  # 只做发布前检查
```

产物：`releases/dsh-personal-workstation-<version>.tgz`、`releases/SHA256SUMS`。

## 3 · 推送公开仓库

```bash
/usr/bin/git remote add origin <GitHub 地址>
/usr/bin/git push -u origin main
/usr/bin/git push origin v<version>
```

## 4 · 装机与回滚

- 安装：按 `README.md` 的 4 步（构建/打包 → profile 指向 tgz → 改 `cordis.patch.yml` → 重启 DSH）。
- 验证：重启后 `node prototype/live-acceptance.mjs`（或 token 模式 `WORKSTATION_TOKEN_URL=...`）。
- 回滚：保留上一版 tgz + `backups/` 里的数据库 `.backup`；把 profile 指回旧 tgz 并重启。
