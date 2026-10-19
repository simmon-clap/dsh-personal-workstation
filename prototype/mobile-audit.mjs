/** 移动端门禁（VI §11 断点 ≤700 单列 / §13 门禁 7 页面溢出 / 点击区 ≥44×44）。
 *
 *  为什么单独做：宪章判据 2 写的是「出差时手机上能独立完成一次完整的看→判断→决定」，
 *  但前面所有门禁（style-check / craft-audit / type-scale-audit / user-view-audit）都只在 1440 宽下跑。
 *  390 这一档从来没被量过，只有几张人工截图。
 *
 *  判据：
 *    ① 横向溢出 —— 每个一级页面在 390 下 scrollWidth 不得超过视口（VI §13 门禁 7）
 *    ② 点击区 —— 移动端可点控件的命中区 ≥44×44（VI §11）
 *    ③ 字阶 —— 渲染字号仍须在 VI 字阶内
 *    ④ 入口完整 —— 7 个一级入口在窄屏下仍然全部可见可点（VI §11「导航折为顶部紧凑入口，保留全部入口」）
 *    ⑤ 弹窗 —— 在 390 下打开后不横向溢出、底部动作区可见
 *
 *  用法：node prototype/mobile-audit.mjs
 */
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {mkdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {httpRoute} from '../src/http-route.mjs';
import {WorkstationStore} from '../src/store.mjs';
import {ExecutionStore} from '../src/execution-store.mjs';
import {seedVisualStore} from './visual-seed.mjs';
import {puppeteer, chromeExecutable} from '../dev-deps.mjs';

const chrome = chromeExecutable();

const TYPE_SCALE = ['32px', '22px', '18px', '15px', '14px', '13px', '12px', '11px'];
const VIEWS = ['home', 'inbox', 'space', 'projects', 'tasks', 'knowledge', 'personal'];
const MIN_TAP = 44;

const store = new WorkstationStore(':memory:');
const executions = new ExecutionStore(store);
seedVisualStore(store);
store.draft({workspace: 'w', actor: 'mobile', canWrite: true}, {
  title: '会前材料归档',
  changes: [
    {op: 'create', id: 'm-a', kind: 'artifact', data: {title: '会前材料', path: 'notes/a.md', fileGrantId: 'voice-inbox', fileVersion: 'v1', content: '要点'}},
    {op: 'update', id: 'p-a', expectedRevision: 1, data: {title: '联合验证', stage: '方案'}},
  ],
});
const connection = {admit: () => ({peer: {id: 'mobile'}}), requestRejection: () => undefined};
const route = httpRoute({
  store, executions, connection,
  workspaceRegistry: {list: () => [{id: 'w', title: '个人空间'}], get: () => ({id: 'w'})},
  allowedWorkspaces: ['w'],
});
const server = createServer((request, response) => route.handler(request, response));
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + server.address().port + '/personal-workstation';
const shots = fileURLToPath(new URL('./screenshots/mobile/', import.meta.url));
mkdirSync(shots, {recursive: true});

const browser = await puppeteer.launch({executablePath: chrome, headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu']});
const page = await browser.newPage();
await page.setViewport({width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 1});
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const problems = [];
const check = (ok, label, detail = '') => {
  if (!ok) problems.push(label + (detail ? '：' + detail : ''));
  return ok;
};

try {
  await page.goto(base, {waitUntil: 'networkidle0'});
  await page.waitForFunction(() => document.querySelectorAll('#projectstrip [data-project]').length > 0, {timeout: 15000});

  for (const view of VIEWS) {
    await page.evaluate(v => document.querySelector('.nav [data-view="' + v + '"]')?.click(), view);
    await wait(600);
    const rows = await page.evaluate((TYPE_SCALE, MIN_TAP) => {
      const overflow = document.documentElement.scrollWidth - window.innerWidth;
      const wide = [];
      // 页面级溢出才算违规（VI §13 门禁 7）。落在**可横向滚动的容器**里的元素（如甘特表所在的
      // `.surface{overflow:auto}`）本来就可以超出视口——那是设计，不是溢出。
      const scrollable = el => {
        for (let node = el.parentElement; node && node !== document.body; node = node.parentElement) {
          const cs = getComputedStyle(node);
          if (/(auto|scroll)/.test(cs.overflowX) && node.scrollWidth > node.clientWidth + 1) return true;
        }
        return false;
      };
      for (const el of document.querySelectorAll('.view.active *')) {
        const rect = el.getBoundingClientRect();
        if (rect.width < 2 || rect.height < 2) continue;
        if (rect.right > window.innerWidth + 1 && !scrollable(el)) {
          const cls = el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).join('.') : el.tagName.toLowerCase();
          wide.push(cls + '（右边界 ' + Math.round(rect.right) + '）');
        }
      }
      const small = [], offScale = [];
      for (const el of document.querySelectorAll('.view.active button,.view.active [role="button"],.view.active a[href],.view.active input,.view.active .viselect-button')) {
        const rect = el.getBoundingClientRect();
        if (rect.width < 2 || rect.height < 2) continue;
        // 画布（#spaceSvg）是一块可缩放/平移的作图面，节点尺寸随缩放走；VI §9 要求它另外提供
        // 「关系列表」作为等价阅读路径，而不是把每个节点做成 44×44 的静态点击区。
        if (el.closest('#spaceSvg')) continue;
        if (rect.height < MIN_TAP - 0.5 || rect.width < MIN_TAP - 0.5) {
          const cls = el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).join('.') : el.tagName.toLowerCase();
          small.push(cls + ' ' + Math.round(rect.width) + '×' + Math.round(rect.height) + ' «' + (el.textContent || '').trim().slice(0, 10) + '»');
        }
      }
      for (const el of document.querySelectorAll('.view.active *')) {
        const rect = el.getBoundingClientRect();
        if (rect.width < 2 || rect.height < 2) continue;
        if (el.children.length) continue;
        if (!(el.textContent || '').trim()) continue;
        const size = getComputedStyle(el).fontSize;
        if (!TYPE_SCALE.includes(size)) offScale.push(size + ' «' + (el.textContent || '').trim().slice(0, 12) + '»');
      }
      return {overflow, wide, small, offScale};
    }, TYPE_SCALE, MIN_TAP);

    check(rows.overflow <= 1, '移动端横向溢出 · ' + view, '超出 ' + rows.overflow + 'px');
    check(rows.wide.length === 0, '移动端元素超出右边 · ' + view, rows.wide.slice(0, 3).join('、'));
    check(rows.offScale.length === 0, '移动端字阶 · ' + view, [...new Set(rows.offScale)].slice(0, 3).join('、'));
    check(rows.small.length === 0, '移动端点击区 ≥44 · ' + view, rows.small.slice(0, 3).join('、'));
    await page.screenshot({path: shots + view + '.png'});
  }

  // 一级入口在窄屏下必须全部还在（VI §11：导航折为顶部紧凑入口，保留全部入口）
  const entries = await page.evaluate(() => {
    const buttons = [...document.querySelectorAll('.nav [data-view]')];
    return {count: buttons.length, visible: buttons.filter(b => b.getBoundingClientRect().height > 0).length};
  });
  check(entries.count === 7, '移动端一级入口数仍为 7', String(entries.count));
  // VI §11.6 断点：**≤700 单列**（2026-10-16 修）。实测原来在 390 下 .metrics/.projectstrip
  // 仍是 2 列（工作台层显式写的 2 列，且没写理由）—— 规范与实现不符，且**没有任何门禁在管列数**。
  const columns = await page.evaluate(() => {
    const count = selector => {
      const el = document.querySelector(selector);
      if (!el) return null;
      const value = getComputedStyle(el).gridTemplateColumns;
      return value.split(' ').filter(Boolean).length;
    };
    return {metrics: count('.metrics'), strip: count('.projectstrip')};
  });
  check((columns.metrics ?? 1) === 1, 'VI §11.6：≤700 时指标区单列', String(columns.metrics) + ' 列');
  check((columns.strip ?? 1) === 1, 'VI §11.6：≤700 时项目条单列', String(columns.strip) + ' 列');
  check(entries.visible === 7, '移动端一级入口全部可见', entries.visible + '/7');

  // 弹窗：在 390 下打开，不能横向溢出，动作区要在视口内
  for (const [name, open] of [
    ['新建菜单', async () => { await page.click('#create'); }],
    ['设置', async () => { await page.click('#settings'); }],
  ]) {
    await page.goto(base, {waitUntil: 'networkidle0'});
    await page.waitForFunction(() => document.querySelectorAll('#projectstrip [data-project]').length > 0, {timeout: 15000});
    await open();
    await wait(900);
    const dialog = await page.evaluate(() => {
      const veil = document.querySelector('#veil');
      if (!veil.classList.contains('open')) return null;
      const drawer = veil.querySelector('[role="dialog"]');
      const rect = drawer.getBoundingClientRect();
      const actions = drawer.querySelector('.modalactions');
      const actionRect = actions?.getBoundingClientRect();
      return {
        width: Math.round(rect.width), left: Math.round(rect.left), right: Math.round(rect.right),
        overflow: document.documentElement.scrollWidth - window.innerWidth,
        actionsVisible: actionRect ? actionRect.bottom <= window.innerHeight + 1 && actionRect.top >= 0 : true,
        actionsBottom: actionRect ? Math.round(actionRect.bottom) : null,
      };
    });
    check(dialog !== null, '移动端弹窗能打开 · ' + name);
    if (dialog) {
      check(dialog.overflow <= 1, '移动端弹窗不横向溢出 · ' + name, '超出 ' + dialog.overflow + 'px');
      check(dialog.left >= 0 && dialog.right <= 390 + 1, '移动端弹窗在视口内 · ' + name, dialog.left + '→' + dialog.right);
      check(dialog.actionsVisible, '移动端动作区可见 · ' + name, '底边 ' + dialog.actionsBottom);
      if (name === '设置') {
        const first = await page.evaluate(() => {
          const drawer = document.querySelector('#veil [role="dialog"]');
          const screen = document.querySelector('[data-settings-firstscreen]');
          const rect = drawer.getBoundingClientRect();
          const clickables = [...(screen?.querySelectorAll('button,a[href],input,select') ?? [])]
            .filter(el => { const r = el.getBoundingClientRect(); return r.width > 1 && r.height > 1 && r.bottom <= rect.bottom + 1; })
            .map(el => (el.textContent || '').trim()).filter(Boolean);
          return {ratio: drawer.scrollHeight / drawer.clientHeight, clickables,
            timer: document.querySelector('[data-timer-fact]')?.getAttribute('data-timer-state') ?? null};
        });
        check(first.ratio <= 1.05, '设置首屏 ≤1 屏（390）', (first.ratio).toFixed(2) + ' 屏');
        check(first.clickables.length >= 1, '设置首屏至少 1 个可点内容（390）', first.clickables.join('、'));
        check(first.timer !== null, '设置首屏有唯一「定时」事实行（390）');
      }
      await page.screenshot({path: shots + 'dialog-' + (name === '新建菜单' ? 'create' : 'settings') + '.png'});
    }
  }
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
  store.close();
}

console.log('移动端门禁（390×844）：' + (problems.length ? '' : '全部通过'));
for (const problem of problems) console.log('  ⚠ ' + problem);
console.log(problems.length
  ? '\nFAIL: 移动端 ' + problems.length + ' 项未达标（截图：prototype/screenshots/mobile/）。'
  : '\nPASS: 移动端横向溢出/点击区/字阶/入口/弹窗都达标（截图：prototype/screenshots/mobile/）。');
process.exit(problems.length ? 1 : 0);
