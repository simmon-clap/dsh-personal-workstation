/** 做工门禁（VI §2/§4/§11/§13）：在真实浏览器里量**渲染结果**，而不是扫源码字符串。
 *
 *  为什么需要它：审计发现「标尺外像素=0 / 字阶外字号=0」长期只查字面量写法；
 *  圆角、颜色语义、对比度范围、焦点环颜色这四项**从来没有渲染级门禁**。
 *
 *  第 3 轮补的一个洞：原版只扫 7 个页面，**弹窗内部完全没扫** —— 而用户点名的
 *  「收件箱弹窗占比大 / 内容不精致 / 按键排列不对齐」恰恰全在弹窗里。
 *  现在逐个打开弹窗，只量浮层内部（遮罩之外的页面元素不算）。
 *
 *  判据：
 *    圆角 —— 控件 8 / 内容容器 12 / 居中弹窗 20 / 标签 999（VI §4）
 *    间距 —— padding / gap 必须是标尺值 4/8/12/16/24/32/48/64/96
 *    对比度 —— 整页与弹窗逐文本节点，正文 4.5:1、大字 3:1（VI §11）
 *    焦点环 —— 宽度 ≥3px 且对纸底 ≥3:1
 *    语义色 —— knowledge 紫只表达知识/记忆/AI 判断
 *
 *  用法：node prototype/craft-audit.mjs
 */
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {mkdirSync} from 'node:fs';
import {readFileSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {httpRoute} from '../src/http-route.mjs';
import {WorkstationStore} from '../src/store.mjs';
import {ExecutionStore} from '../src/execution-store.mjs';
import {seedVisualStore} from './visual-seed.mjs';

import {SCALE, RADIUS, measureInPage} from './measure-page.mjs';
import {puppeteer, chromeExecutable} from '../dev-deps.mjs';

const chrome = chromeExecutable();

const store = new WorkstationStore(':memory:');
const executions = new ExecutionStore(store);
seedVisualStore(store);
// 夹具里**必须有一个长名字的项目**：真入口复验时，「示例科技 · 示例产品技术适配与合作研判」
// 这种真名字把原来写死 70px 的 .meter span 挤成了四行竖条 —— 而演示数据全是「技术适配」这种四个字，
// 本地门禁一路全绿。夹具覆盖不到真实形状，门禁就只是自娱自乐。
store.draft({workspace: 'w', actor: 'craft', canWrite: true}, {
  title: '长名字项目',
  changes: [
    {op: 'create', id: 'p-longname', kind: 'project', data: {title: '示例科技 · 示例产品技术适配与合作研判', stage: '验证', importance: 'high'}},
  ],
}).id && store.commit({workspace: 'w', actor: 'craft', canWrite: true}, {batchId: store.inbox({workspace: 'w', actor: 'craft', canWrite: true})[0].id, revision: 1, key: 'craft-longname'});
store.draft({workspace: 'w', actor: 'craft', canWrite: true}, {
  title: '会前材料归档',
  changes: [
    {op: 'create', id: 'craft-a', kind: 'artifact', data: {title: '会前材料', path: 'notes/a.md', fileGrantId: 'voice-inbox', fileVersion: 'v1', content: '要点'}},
    {op: 'update', id: 'p-a', expectedRevision: 1, data: {title: '联合验证', stage: '方案'}},
  ],
});
const connection = {admit: () => ({peer: {id: 'craft'}}), requestRejection: () => undefined};
const route = httpRoute({
  store, executions, connection,
  workspaceRegistry: {list: () => [{id: 'w', title: '个人空间'}], get: () => ({id: 'w'})},
  allowedWorkspaces: ['w'],
  files: {grants: [{id: 'voice-inbox', workspace: 'w', root: process.cwd(), read: true, write: false, label: '语音目录（只读）'}]},
});
const server = createServer((request, response) => route.handler(request, response));
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + server.address().port + '/personal-workstation';

const browser = await puppeteer.launch({executablePath: chrome, headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu']});
const page = await browser.newPage();
await page.setViewport({width: 1440, height: 940});
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const shots = fileURLToPath(new URL('./screenshots/craft/', import.meta.url));
mkdirSync(shots, {recursive: true});
const sections = [];
let canary = {caught: false, detail: "探针没跑到"};
// 已登记的"信息架构度量"（如侧栏宽 204px）：它们是验收测试直接断言的真实像素值，
// 不是随手写的间距，所以按登记值放行（登记表在 spec/registry.json 的 contractValues）。
const here = dirname(fileURLToPath(import.meta.url));
const registry = JSON.parse(readFileSync(join(here, '..', '..', 'spec', 'registry.json'), 'utf8'));
const CONTRACT = (registry.contractValues?.items ?? []).map(row => Number(row.value)).filter(Number.isFinite);
const collect = async (label, rootSelector) => {
  sections.push({label, ...(await page.evaluate(measureInPage, RADIUS, SCALE, rootSelector, CONTRACT))});
};

try {
  await page.goto(base, {waitUntil: 'networkidle0'});
  await page.waitForFunction(() => document.querySelectorAll('#projectstrip [data-project]').length > 0, {timeout: 15000});
  for (const view of ['home', 'inbox', 'space', 'projects', 'tasks', 'knowledge', 'personal']) {
    await page.evaluate(v => document.querySelector('.nav [data-view="' + v + '"]')?.click(), view);
    await wait(450);
    await collect('页面 · ' + view, 'body');
    await page.screenshot({path: shots + view + '.png'});
  }

  const dialogs = [
    ['新建菜单', async () => { await page.click('#create'); }],
    ['新建项目', async () => { await page.click('#create'); await wait(400); await page.evaluate(() => document.querySelector('#detailbody [data-kind="project"]')?.click()); }],
    ['项目详情', async () => { await page.evaluate(() => document.querySelector('.nav [data-view="projects"]')?.click()); await wait(500); await page.evaluate(() => document.querySelector('#projectsbody [data-project]')?.click()); }],
    ['设置', async () => { await page.click('#settings'); }],
    ['收件箱批次', async () => { await page.evaluate(() => document.querySelector('.nav [data-view="inbox"]')?.click()); await wait(500); await page.evaluate(() => document.querySelector('#inboxbody [data-batch]')?.click()); }],
    ['任务详情', async () => { await page.evaluate(() => document.querySelector('.nav [data-view="tasks"]')?.click()); await wait(500); await page.evaluate(() => document.querySelector('#tasksbody [data-task]')?.click()); }],
  ];
  for (const [name, open] of dialogs) {
    await page.goto(base, {waitUntil: 'networkidle0'});
    await page.waitForFunction(() => document.querySelectorAll('#projectstrip [data-project]').length > 0, {timeout: 15000});
    await open();
    await wait(1000);
    const opened = await page.evaluate(() => document.querySelector('#veil')?.classList.contains('open') ?? false);
    if (!opened) { sections.push({label: '弹窗 · ' + name, missing: true, radius: [], spacing: [], texts: [], purple: []}); continue; }
    await collect('弹窗 · ' + name, '#veil');
    await page.screenshot({path: shots + 'dialog-' + name.replace(/[^\u4e00-\u9fa5]/g, '') + '.png'});
  }

  await page.goto(base, {waitUntil: 'networkidle0'});
  await page.evaluate(() => document.querySelector('.nav [data-view="space"]')?.click());
  await wait(600);
  const focus = await page.evaluate(() => {
    const out = [];
    for (const selector of ['#graphsearch', '#create', '.viselect-button']) {
      const el = document.querySelector(selector);
      if (!el) continue;
      el.focus();
      out.push({selector, width: getComputedStyle(el).outlineWidth, color: getComputedStyle(el).outlineColor});
      el.blur();
    }
    return out;
  });
  sections.push({label: '焦点环', focus, radius: [], spacing: [], texts: [], purple: []});

  // 金丝雀：故意放一个不达标的元素，探测器必须抓到它（抓不到 = 这道门禁什么都没在量）。
  await page.goto(base, {waitUntil: 'networkidle0'});
  await wait(600);
  await page.evaluate(() => {
    const probe = document.createElement('div');
    probe.id = 'craftprobe';
    probe.style.cssText = 'position:fixed;left:0;top:0;width:80px;height:24px;display:block';
    const child = document.createElement('span');
    child.textContent = '探针';
    child.style.cssText = 'display:inline-block;border-radius:5px;padding:13px';
    probe.append(child);
    document.body.append(probe);
  });
  const canaryMeasured = await page.evaluate(measureInPage, RADIUS, SCALE, '#craftprobe');
  canary = {
    caught: (canaryMeasured.radius?.length ?? 0) > 0 && (canaryMeasured.spacing?.length ?? 0) > 0,
    detail: 'radius=' + (canaryMeasured.radius?.length ?? 0) + ' spacing=' + (canaryMeasured.spacing?.length ?? 0),
  };
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
  store.close();
}

let failed = 0;
const uniq = (list, key) => [...new Map(list.map(item => [key(item), item])).values()];
const report = (title, rows, key, line) => {
  console.log('── ' + title);
  const unique = uniq(rows, key);
  for (const item of unique) { console.log('  ⚠ ' + line(item)); failed += 1; }
  if (!unique.length) console.log('  ok');
};

const flat = field => sections.flatMap(section => (section[field] ?? []).map(row => ({...row, where: section.label})));

// ── 金丝雀（2026-10-16 红队实测：把 measureInPage 改成返回空对象 → 同一份违规全 ok / PASS）──
// 度量函数只返回**违规项**，所以"0 行"本身是正常的（可能真没违规），不能拿它当样本量。
// 能问的只有一个问题：**这个探测器还看得见违规吗**。所以故意放一个不达标的元素，必须被抓到。
if (!canary.caught) {
 console.log('FAIL: 做工门禁的探测器失灵了 —— 故意放的违规元素没被抓到（' + canary.detail + '）。');
 console.log('      这意味着"全 ok"不代表达标，而是什么都没在量。');
 process.exit(1);
}
console.log('（金丝雀：故意放的违规圆角/间距被抓到 → 探测器有效）');

report('圆角（VI §4：控件 8 · 内容容器 12 · 居中弹窗 20 · 标签 999）', flat('radius'),
  row => row.cls + row.radius,
  row => row.where.padEnd(18) + row.cls.padEnd(24) + String(row.radius).padEnd(8) + ' 父=' + row.parent + '  «' + row.sample + '»');

report('间距（VI §4 标尺 4/8/12/16/24/32/48/64/96）', flat('spacing'),
  row => row.cls + row.prop + row.value,
  row => row.where.padEnd(18) + row.cls.padEnd(24) + row.prop + ':' + row.value + '  «' + row.sample + '»');

report('对比度（VI §11：整页 + 弹窗逐文本节点）', flat('texts'),
  row => row.cls + row.color + row.bg,
  row => row.where.padEnd(18) + row.cls.padEnd(20) + row.got + ':1（需 ' + row.need + '）' + row.size + 'px  «' + row.text + '»  ' + row.color + ' on ' + row.bg);

report('语义色（VI §2：knowledge 紫只表达知识/记忆/AI 判断）', flat('purple'),
  row => row.cls + row.text,
  row => row.where.padEnd(18) + row.cls.padEnd(24) + '«' + row.text + '»');

console.log('── 焦点环（VI §11：≥3:1、3px）');
const lum = rgb => {
  const [r, g, b] = rgb.map(v => v / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
for (const item of sections.flatMap(section => section.focus ?? [])) {
  const parts = (item.color.match(/rgba?\(([^)]+)\)/) ?? [])[1];
  const rgb = parts ? parts.split(',').map(Number).slice(0, 3) : null;
  const [hi, lo] = rgb ? [lum(rgb), lum([248, 249, 247])].sort((a, b) => b - a) : [0, 0];
  const got = rgb ? (hi + 0.05) / (lo + 0.05) : 0;
  const ok = Number.parseFloat(item.width) >= 3 && got >= 3;
  console.log('  ' + (ok ? 'ok ' : '⚠ ') + item.selector.padEnd(18) + item.width + ' ' + item.color + '  对比 ' + (Math.round(got * 100) / 100) + ':1');
  if (!ok) failed += 1;
}

const missed = sections.filter(section => section.missing).map(section => section.label);
if (missed.length) { console.log('（未覆盖：' + missed.join('、') + '）'); failed += missed.length; }

console.log(failed ? '\nFAIL: 做工门禁发现 ' + failed + ' 处。' : '\nPASS: 圆角/间距/对比度/焦点环/语义色在页面与弹窗里都达标。');
process.exit(failed ? 1 : 0);
