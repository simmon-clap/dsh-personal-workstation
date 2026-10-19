/** 门禁 11（状态文字）：绿点 / 赭色 / 虚线旁必须有对应文字。
 *
 *  依据：VI §13 门禁 11、V4「安静靠秩序」；宪章第六条品味「颜色不能单独承担判断」。
 *  机械判据：
 *    ① 每个 [data-state]（纯色状态点 / 状态芯片）——**它自己**或它所在的行卡里，
 *       必须出现该状态对应的中文文字；只靠颜色一律算失败。
 *    ② 每个虚线边框的元素必须有非空文字（虚线本身是"未同步/待补"的信号）。
 *
 *  取证纪律（前几轮踩过的坑）：
 *    · 只扫**当前可见视图**（.view.active）—— 否则隐藏视图里的元素会被误报；
 *    · 真数据播种 —— 否则页面上根本没有状态点，检查会空转通过。
 *  用法：node prototype/status-audit.mjs
 */
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {httpRoute} from '../src/http-route.mjs';
import {WorkstationStore} from '../src/store.mjs';
import {ExecutionStore} from '../src/execution-store.mjs';
import {seedVisualStore} from './visual-seed.mjs';
import {puppeteer, chromeExecutable} from '../dev-deps.mjs';

const chrome = chromeExecutable();

/** data-state 的取值 → 界面上必须出现的文字（两份口径：收件箱状态点、资料核对状态芯片）。 */
export const STATE_LABELS = {
  draft: '待确认', conflict: '需补充', committed: '已处理', cancelled: '已取消',
  current: '一致', changed: '已变化', missing: '不存在', ungranted: '未授权', unknown: '无法确认',
};

const store = new WorkstationStore(':memory:');
const executions = new ExecutionStore(store);
seedVisualStore(store);
// 播一条待决定项：否则收件箱没有状态点，这项检查会空转通过（前几轮踩过）。
const ctx = {workspace: 'w', actor: 'status-audit', canWrite: true};
const batch = store.draft(ctx, {title: '门禁 11 播种用', changes: [
  {op: 'create', id: 't-status', kind: 'task', data: {title: '播种任务'}},
]});

const connection = {admit: () => ({peer: {id: 'operator'}}), requestRejection: () => undefined};
const route = httpRoute({
  store, executions, connection,
  workspaceRegistry: {list: () => [{id: 'w', title: '个人空间'}], get: id => (id === 'w' ? {id: 'w'} : null)},
  allowedWorkspaces: ['w'],
});
const server = createServer((request, response) => route.handler(request, response));
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

/** 只扫可见视图，返回违规清单。抽成函数是为了能注入违规做自检（证明门禁不是摆设）。 */
const collect = () => {
  const scope = document.querySelector('.view.active') ?? document.body;
  const violations = [];
  const states = [];
  for (const element of scope.querySelectorAll('[data-state]')) {
    const container = element.closest('[data-inboxitem],[data-batch],.inboxcard,.chip,.surface,.calchip') ?? element.parentElement;
    const selfText = (element.textContent || '').trim();
    const containerText = (container?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    states.push({state: element.dataset.state});
    const expect = STATE_LABELS[element.dataset.state];
    if (!expect) { violations.push(`未知状态 ${element.dataset.state}（登记表里没有对应文字）`); continue; }
    if (!(selfText.includes(expect) || containerText.includes(expect))) {
      violations.push(`状态点 data-state="${element.dataset.state}" 旁没有文字「${expect}」`);
    }
  }
  const dashed = [...scope.querySelectorAll('*')].filter(element => getComputedStyle(element).borderStyle.includes('dashed'));
  for (const element of dashed) {
    if (!(element.textContent || '').trim()) violations.push(`虚线元素 .${String(element.className).slice(0, 40)} 没有文字（虚线单独承担了状态）`);
  }
  return {violations, stateCount: states.length, dashedCount: dashed.length};
};
globalThis.__statusCollect = collect;

const results = [];
const check = (label, ok, detail = '') => { results.push({label, ok}); console.log((ok ? 'PASS' : 'FAIL').padEnd(5) + label + (detail ? '  → ' + detail : '')); };

/** 在浏览器里跑的判定：只扫可见视图；返回违规清单。作为**参数**传进页面（不在页面里定义全局）。 */
const probe = labels => {
  const scope = document.querySelector('.view.active') ?? document.body;
  const violations = [];
  let stateCount = 0;
  for (const element of scope.querySelectorAll('[data-state]')) {
    stateCount += 1;
    const container = element.closest('[data-inboxitem],[data-batch],.inboxcard,.chip,.surface,.calchip') ?? element.parentElement;
    const selfText = (element.textContent || '').trim();
    const containerText = (container?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    const expect = labels[element.dataset.state];
    if (!expect) { violations.push('未知状态 ' + element.dataset.state + '（登记表里没有对应文字）'); continue; }
    if (!(selfText.includes(expect) || containerText.includes(expect))) {
      violations.push('状态点 data-state="' + element.dataset.state + '" 旁没有文字「' + expect + '」');
    }
  }
  const dashed = [...scope.querySelectorAll('*')].filter(element => getComputedStyle(element).borderStyle.includes('dashed'));
  for (const element of dashed) {
    if (!(element.textContent || '').trim()) violations.push('虚线元素 .' + String(element.className).slice(0, 40) + ' 没有文字（虚线单独承担了状态）');
  }
  return {violations, stateCount, dashedCount: dashed.length};
};

const browser = await puppeteer.launch({executablePath: chrome, headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu']});
try {
  const page = await browser.newPage();
  await page.setViewport({width: 1440, height: 1000});
  await page.goto('http://127.0.0.1:' + port + '/personal-workstation', {waitUntil: 'networkidle0'});
  await page.waitForFunction(() => document.querySelectorAll('.view').length > 0, {timeout: 15000});

  const visit = async (label, view, tabSelector, tab) => {
    await page.evaluate(name => document.querySelector('.nav [data-view="' + name + '"]')?.click(), view);
    await new Promise(resolve => setTimeout(resolve, 500));
    if (tabSelector && tab) {
      await page.evaluate((selector, name) => document.querySelector(selector + ' [data-' + selector.replace('#', '').replace('tabs', '') + '="' + name + '"]')?.click(), tabSelector, tab);
      await new Promise(resolve => setTimeout(resolve, 400));
    }
    const found = await page.evaluate(probe, STATE_LABELS);
    check(label + '：状态点 ' + found.stateCount + ' 个 · 虚线 ' + found.dashedCount + ' 个', found.violations.length === 0, found.violations.slice(0, 3).join('；'));
    return found.violations;
  };

  const all = [];
  for (const view of ['home', 'inbox', 'space', 'projects', 'tasks', 'knowledge', 'personal']) all.push(...await visit(view, view));
  for (const tab of ['topics', 'brief', 'files', 'memory']) all.push(...await visit('knowledge · ' + tab, 'knowledge', '#knowtabs', tab));
  for (const tab of ['calendar', 'travel', 'invoice']) all.push(...await visit('personal · ' + tab, 'personal', '#persontabs', tab));

  // 自检：注入一个"只有颜色、没有文字"的状态点，证明这项检查抓得到（不是摆设）。
  await page.evaluate(() => {
    const holder = document.createElement('div');
    holder.id = 'gate11selftest';
    holder.innerHTML = '<span class="statusdot" data-state="draft"></span>';
    (document.querySelector('.view.active') ?? document.body).append(holder);
  });
  const injected = await page.evaluate(probe, STATE_LABELS);
  check('自检：裸色点会被抓到', injected.violations.some(text => text.includes('data-state="draft"')), injected.violations.slice(0, 1).join(''));
  await page.evaluate(() => document.querySelector('#gate11selftest')?.remove());

  console.log('─'.repeat(56));
  const failed = results.filter(item => !item.ok);
  if (failed.length) {
    console.log('FAIL: ' + failed.length + ' 项未通过（' + all.length + ' 处状态只靠颜色/形状表达）');
    process.exitCode = 1;
  } else {
    console.log('PASS: 每个状态点与虚线旁都有对应文字；且自检证明裸色点会被抓到（只扫可见视图，已播真实数据）。');
  }
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
  store.close();
}
