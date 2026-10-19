/** 全页面截图：7 个一级视图 + 知识的 4 个二级页签 + 手机一档。
 *
 *  用途：让人在外面也能看到每个页面长什么样。
 *  一次性内存库 + 演示数据，不碰生产数据。
 *  用法：node prototype/pages-screenshots.mjs */
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {mkdirSync} from 'node:fs';
import {httpRoute} from '../src/http-route.mjs';
import {WorkstationStore} from '../src/store.mjs';
import {ExecutionStore} from '../src/execution-store.mjs';
import {seedVisualStore} from './visual-seed.mjs';
import {puppeteer, chromeExecutable} from '../dev-deps.mjs';

const chrome = chromeExecutable();

const store = new WorkstationStore(':memory:');
const executions = new ExecutionStore(store);
seedVisualStore(store);
// 补两条判断，让知识页能看出「判断」的样子（真实会议内容）
const ctx = {workspace: 'w', actor: 'shot', canWrite: true};
const batch = store.draft(ctx, {
  title: '截图用判断',
  changes: [
    {op: 'create', id: 'j-1', kind: 'judgment', data: {
      title: '短期难以成立：带宽与成本都不匹配现有客户的价格预期',
      evidence: [
        {kind: 'audio', ref: '示例学校.m4a@0-3600', quote: '示例依据：方案参数与时间安排仍需核对', verified: false},
        {kind: 'note', ref: 'user-said-1', quote: '价格敏感是硬约束', verified: false},
      ],
      uncertainty: '口径未确认，待与对方核对成本基准',
      validFrom: '2026-10-11', reviewBy: '2026-11-11', status: 'checking', projectId: 'p-a',
    }},
    {op: 'create', id: 'j-2', kind: 'judgment', data: {
      title: '合作结构长期有风险',
      evidence: [{kind: 'audio', ref: '示例学校.m4a@4200-4300', quote: '示例依据：合作结构需要分阶段验证', verified: false}],
      uncertainty: '对方商业模式自述无法验证', validFrom: '2026-10-11', status: 'current', projectId: 'p-b',
    }},
  ],
});
store.commit(ctx, {batchId: batch.id, revision: 1, key: 'shots'});

const connection = {admit: () => ({peer: {id: 'operator'}}), requestRejection: () => undefined};
const route = httpRoute({
  store, executions, connection,
  workspaceRegistry: {list: () => [{id: 'w', title: '个人空间'}], get: id => (id === 'w' ? {id: 'w'} : null)},
  allowedWorkspaces: ['w'],
});
const server = createServer((request, response) => route.handler(request, response));
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

const dir = 'prototype/screenshots/pages';
mkdirSync(dir, {recursive: true});
const browser = await puppeteer.launch({executablePath: chrome, headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu']});
const shots = [];
try {
  const views = [['home', '总览'], ['inbox', '收件箱'], ['space', '关联空间'], ['projects', '项目'],
    ['tasks', '任务'], ['knowledge', '知识'], ['personal', '日程与事务']];
  for (const [width, tag] of [[1440, 'desktop'], [390, 'mobile']]) {
    const page = await browser.newPage();
    await page.setViewport({width, height: width === 390 ? 900 : 960});
    await page.goto('http://127.0.0.1:' + port + '/personal-workstation', {waitUntil: 'networkidle0'});
    for (const [view, label] of views) {
      await page.evaluate(target => document.querySelector('.nav [data-view="' + target + '"]').click(), view);
      if (view === 'knowledge') {
        const tab = await page.$('#knowtabs [data-know="topics"]');
        if (tab) await tab.click();
      }
      await new Promise(resolve => setTimeout(resolve, 450));
      const file = dir + '/01-' + tag + '-' + view + '.png';
      await page.screenshot({path: file, fullPage: width === 390});
      shots.push(file);
    }
    await page.close();
  }
  // 知识页四个二级页签（桌面）
  const page = await browser.newPage();
  await page.setViewport({width: 1440, height: 960});
  await page.goto('http://127.0.0.1:' + port + '/personal-workstation', {waitUntil: 'networkidle0'});
  await page.evaluate(() => document.querySelector('.nav [data-view="knowledge"]').click());
  for (const mode of ['topics', 'brief', 'files', 'memory']) {
    const tab = await page.$('#knowtabs [data-know="' + mode + '"]');
    if (tab) await tab.click();
    await new Promise(resolve => setTimeout(resolve, 450));
    const file = dir + '/02-knowledge-' + mode + '.png';
    await page.screenshot({path: file});
    shots.push(file);
  }
  // 判断的「只看待核对」筛选态
  await page.evaluate(() => document.querySelector('#knowtabs [data-know="topics"]').click());
  await new Promise(resolve => setTimeout(resolve, 300));
  await page.evaluate(() => document.querySelector('[data-know-filter]')?.click());
  await new Promise(resolve => setTimeout(resolve, 400));
  await page.screenshot({path: dir + '/03-judgment-waiting-filter.png'});
  shots.push(dir + '/03-judgment-waiting-filter.png');
  await page.close();
} finally {
  await browser.close();
  server.close();
  store.close();
}
console.log(`共 ${shots.length} 张截图：`);
for (const file of shots) console.log('  ' + file);
