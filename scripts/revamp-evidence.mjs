#!/usr/bin/env node
/** 画布与三页统一改版的**夹具证据**（A5/B5）：用合成的种子数据在离线服务上截 1440/390 的图。
 *
 *  诚实边界（写进 metadata，也写进证据文档）：
 *   · 这是**离线夹具**：自建内存库 + 合成数据 + 本机 Chromium，**不是**正在运行的真实实例；
 *   · 因此它证明的是「实现按预期渲染」，不能替代 `gate:semantic` / `live-acceptance` 的真实实例验收；
 *   · 真实实例验收需要 `npm run install:local` + 重启 DSH，这一条已记账本等用户拍板。
 *
 *  用法：node scripts/revamp-evidence.mjs
 *  产物：../../spec/screenshots/53-canvas-revamp-20261021/*.png + metadata.json
 */
import {createServer} from 'node:http';
import {mkdirSync, writeFileSync, readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {httpRoute} from '../src/http-route.mjs';
import {WorkstationStore} from '../src/store.mjs';
import {ExecutionStore} from '../src/execution-store.mjs';
import {puppeteer, chromeExecutable} from '../dev-deps.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, '..', '..', 'spec', 'screenshots', '53-canvas-revamp-20261021');
mkdirSync(OUT, {recursive: true});

const store = new WorkstationStore(':memory:');
const executions = new ExecutionStore(store);
const ctx = {workspace: 'w', actor: 'evidence', canWrite: true};
// 合成种子：3 类角色 + 未分类 + 未归属 + 一个多角色项目（覆盖分类/未分类/未归属/参与关系）。
const seed = store.draft(ctx, {title: 'evidence seed', changes: [
  {op: 'create', id: 'org-a', kind: 'organization', data: {title: '甲方（客户角色）', defaultRole: '客户'}},
  {op: 'create', id: 'org-b', kind: 'organization', data: {title: '合作方（伙伴角色）', defaultRole: '伙伴'}},
  {op: 'create', id: 'org-c', kind: 'organization', data: {title: '供货方（供应角色）', defaultRole: '供应'}},
  {op: 'create', id: 'org-d', kind: 'organization', data: {title: '还没分类的机构'}},
  {op: 'create', id: 'p-main', kind: 'project', data: {title: '主责项目', stage: '方案', organizationId: 'org-a', roleTemplate: 'delivery', participants: [{organizationId: 'org-a', role: '客户'}, {organizationId: 'org-b', role: '伙伴'}], deliverables: [{id: 'd1', title: '方案 A', done: true}, {id: 'd2', title: '方案 B', done: false}]}},
  {op: 'create', id: 'p-unassigned', kind: 'project', data: {title: '还没归属的项目', stage: '接触', deliverables: [{id: 'd3', title: '初稿', done: true}]}},
  {op: 'create', id: 't-1', kind: 'task', data: {title: '核对接口文档', projectId: 'p-main', status: 'in_progress', steps: [{id: 's1', title: '读文档', done: true}, {id: 's2', title: '对齐字段', done: false}]}},
  {op: 'create', id: 't-2', kind: 'task', data: {title: '等对方回数据', projectId: 'p-main', status: 'waiting', blockedReason: '等对方提供样例'}},
  {op: 'create', id: 't-3', kind: 'task', data: {title: '写验收清单', status: 'todo'}},
]});
store.commit(ctx, {batchId: seed.id, revision: seed.revision, key: 'evidence-seed'});

const route = httpRoute({
  store, executions,
  connection: {admit: () => ({peer: {id: 'evidence'}}), requestRejection: () => undefined},
  workspaceRegistry: {list: () => [{id: 'w', title: '个人空间'}], get: () => ({id: 'w'})},
  allowedWorkspaces: ['w'],
});
const server = createServer((request, response) => route.handler(request, response));
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + server.address().port + '/personal-workstation';
const browser = await puppeteer.launch({executablePath: chromeExecutable(), headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu']});
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const shots = [];

async function capture(page, name) {
  const file = join(OUT, name + '.png');
  await page.screenshot({path: file});
  shots.push({name, file, sha256: createHash('sha256').update(readFileSync(file)).digest('hex')});
}

try {
  // 桌面 1440
  const desktop = await browser.newPage();
  await desktop.setViewport({width: 1440, height: 940});
  await desktop.goto(base, {waitUntil: 'networkidle0'});
  await wait(1200);
  // 1) 画布默认：结构态（按分类分列）
  await desktop.evaluate(() => document.querySelector('.nav [data-view="space"]')?.click());
  await wait(1600);
  await capture(desktop, '1440-canvas-structure');
  // 2) 原地展开：机构 → 项目 → 任务（同 URL，不换页）
  const org = await desktop.$('#spaceSvg [data-node][data-kind="organization"]');
  if (org) {
    await org.click(); await wait(900);
    const project = await desktop.$('#spaceSvg [data-branch-child][data-kind="project"]');
    if (project) { await project.click(); await wait(900); }
    await capture(desktop, '1440-canvas-expanded');
  }
  await desktop.keyboard.press('Escape'); await desktop.keyboard.press('Escape');
  // 3) 项目页 / 4) 任务页 / 5) 收件箱
  await desktop.evaluate(() => document.querySelector('.nav [data-view="projects"]')?.click());
  await wait(900); await capture(desktop, '1440-projects');
  await desktop.evaluate(() => document.querySelector('.nav [data-view="tasks"]')?.click());
  await wait(900); await capture(desktop, '1440-tasks');
  await desktop.evaluate(() => document.querySelector('.nav [data-view="inbox"]')?.click());
  await wait(900); await capture(desktop, '1440-inbox');
  await desktop.close();

  // 手机 390
  const mobile = await browser.newPage();
  await mobile.setViewport({width: 390, height: 844, isMobile: true, hasTouch: true});
  await mobile.goto(base, {waitUntil: 'networkidle0'});
  await wait(1200);
  await mobile.evaluate(() => document.querySelector('.nav [data-view="space"]')?.click());
  await wait(1600); await capture(mobile, '390-canvas-structure');
  await mobile.evaluate(() => document.querySelector('.nav [data-view="tasks"]')?.click());
  await wait(900); await capture(mobile, '390-tasks');
  await mobile.close();
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
  store.close();
}

const layoutRecords = 0; // 夹具里没有写布局（结构态不写业务数据；这是预期）
writeFileSync(join(OUT, 'metadata.json'), JSON.stringify({
  capturedAt: new Date().toISOString(),
  kind: 'fixture',   // 不是真实实例：需要 install:local + 重启 DSH 才能做真实实例验收
  data: {synthetic: true, organizations: 4, projects: 2, tasks: 3, layoutRecords},
  viewports: ['1440x940', '390x844'],
  code: {build: 'npm run build:v7', instance: 'offline httpRoute + in-memory store'},
  shots,
  honesty: '离线夹具截图：证明实现按预期渲染，不替代真实实例验收（gate:semantic / live-acceptance）。',
}, null, 1));
console.log('evidence written:', OUT, shots.length + ' screenshots');
