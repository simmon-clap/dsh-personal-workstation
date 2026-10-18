# DSH 个人工作台

个人工作台是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的一个插件：把项目、任务、材料、日程、判断与 Agent 提议的改动收在同一个本地页面里，数据存本机 SQLite，不经过第三方服务器。

## 能做什么

- **总览**：项目、任务、交付项、待办与日程的真实统计；点数字就地弹窗列出那一组对象。
- **收件箱**：Agent 或你自己录入的改动先落成一条待决定项，同意才写进工作台；可撤销。AI 建议必须带依据与不确定性，回答"为什么这么建议"。
- **项目 / 任务**：阶段、交付项、步骤与截止；项目文件夹里的材料可关联；单据字段支持就地编辑。
- **知识**：判断是一等公民——每条判断必须带依据出处、什么时候成立、状态与不确定性；支持核对、推翻留痕、导出。
- **关联空间**：无限画布，把项目、任务、知识、事务与跨项目共享关系连起来；AI 只提候选，确认由你决定。
- **日程与事务**、**文件与资料**、**语音转写**（本机模型）、**主动做事**（定时只留痕，不打扰）。
- **DSH 对话 / IM**：同一份数据；来自飞书等 IM 的写入进同一个收件箱。

## 安装

要求：DSH 桌面端（含 Web UI）、Node.js ≥ 24。

1. 构建并打包：

   ```bash
   cd workstation
   npm run build:v7
   npm pack --pack-destination releases
   ```

2. 把打出来的 `releases/dsh-personal-workstation-<version>.tgz` 设为 DSH profile 的依赖（在 `~/.dsh/profiles/<profile>/package.json` 里用 `file:` 指向该 tgz），然后：

   ```bash
   pnpm --dir ~/.dsh/profiles/<profile> install
   ```

3. **先改配置**：把本仓库的 `cordis.patch.yml` 复制到 profile 的 `cordis.patch.yml`（或合并进已有 patch），把 `dataDirectory` 改成你的绝对路径、`allowedWorkspaces` 填你在 DSH 里登记的工作区 ID。

4. 重启 DSH。打开 DSH 侧栏「个人工作台」。

升级 = 重复 1–2 + 重启。

## 数据与隐私

- 所有业务数据都在你配置的 `dataDirectory` 里（SQLite，WAL 模式）；录音、会议纪要、项目文件夹留在你授权的工作区目录。
- 插件默认不向任何外部服务发送数据；飞书/日历/执行器等外部能力未配置时**如实显示未接入**，不伪造结果。
- 工作台**没有**往飞书发消息的代码；出声通道始终 `ready:false · implemented:false`。
- 备份：用 `sqlite3 <db> ".backup <dest>"`（WAL 模式下直接 `cp` 会拿到旧快照）。

## 开发

```bash
npm install        # 开发依赖（jsdom / puppeteer-core）
npm test           # 单元与集成测试
npm run verify     # 机械门禁（含真实浏览器检查；需要本机 Chrome，可用 CHROME_PATH 指定）
```

- 产品源码：`src/*.mjs`（Host 侧）、`prototype/*.mjs`（UI 源）、`client/client.js`（Web Client 插件）。
- `src/v7/*` 与 `src/v7-shell.html` 是**生成物**，由 `npm run build:v7` 从冻结原型生成，不要手改。
- 界面规范见 `plans/`（内部文档不随包发布）。

## 许可

MIT（见 `LICENSE`）。
