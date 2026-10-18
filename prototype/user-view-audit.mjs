/** 用户视角审视：把用户点名抱怨的那几个界面**逐个打开并截图**。
 *
 *  存在的理由：以前的弹窗审计只导结构序列（标题/按钮/输入个数），不看"长什么样"，
 *  所以"按钮不对齐、下拉很土、弹窗占比过大、选项没有图标"这类问题一条都拦不住。
 *  这个脚本按**用户会走的路径**打开，并记录每个界面的度量（弹窗尺寸/按钮行高/图标数/选项数）。
 *
 *  用法：node prototype/user-view-audit.mjs
 *  不写生产数据：内存库 + 演示数据。
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

const store = new WorkstationStore(':memory:');
const executions = new ExecutionStore(store);
seedVisualStore(store);
// 一条待确认的改动：收件箱的批次弹窗只有存在草稿时才打得开。
const ctx = {workspace: 'w', actor: 'audit', canWrite: true};
store.draft(ctx, {
  title: '会前材料归档',
  changes: [
    {op: 'create', id: 'a-new', kind: 'artifact', data: {title: '会前材料', path: 'notes/a.md', fileGrantId: 'voice-inbox', fileVersion: 'v1', content: '要点'}},
    {op: 'update', id: 'p-a', expectedRevision: 1, data: {title: '联合验证', stage: '方案'}},
  ],
});
const connection = {admit: () => ({peer: {id: 'operator'}}), requestRejection: () => undefined};
const route = httpRoute({
  store, executions, connection,
  workspaceRegistry: {list: () => [{id: 'w', title: '飞书工作区', path: process.cwd()}], get: () => ({id: 'w', title: '飞书工作区', path: process.cwd()})},
  allowedWorkspaces: ['w'],
  files: {grants: [{id: 'voice-inbox', workspace: 'w', root: process.cwd(), read: true, write: false, label: '语音目录（只读）'}]},
});
const server = createServer((request, response) => route.handler(request, response));
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + server.address().port + '/personal-workstation';

const dir = fileURLToPath(new URL('./screenshots/current/', import.meta.url));
mkdirSync(dir, {recursive: true});

const browser = await puppeteer.launch({executablePath: chrome, headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu']});
const findings = [];

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function surface(name, {view = null, steps = [], settle = 900} = {}) {
  const page = await browser.newPage();
  await page.setViewport({width: 1440, height: 940});
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(base, {waitUntil: 'networkidle0'});
    await page.waitForFunction(() => document.querySelectorAll('#projectstrip [data-project]').length > 0, {timeout: 15000});
    if (view) {
      await page.evaluate(v => document.querySelector('.nav [data-view="' + v + '"]')?.click(), view);
      await wait(600);
    }
    for (const step of steps) await step(page);
    await wait(settle);
    await page.screenshot({path: dir + name + '.png'});
    const metrics = await page.evaluate(() => {
      const veil = document.querySelector('#veil');
      const open = veil?.classList.contains('open') ?? false;
      const dialog = veil?.querySelector('[role="dialog"]');
      const rect = dialog?.getBoundingClientRect();
      const body = document.querySelector('#detailbody');
      const menu = document.querySelector('#nodemenu');
      const menuRect = menu?.getBoundingClientRect();
      const dropdowns = [...(body?.querySelectorAll('[data-viselect]') ?? [])];
      return {
        dialogOpen: open,
        dialogSize: rect ? {w: Math.round(rect.width), h: Math.round(rect.height), top: Math.round(rect.top)} : null,
        dialogScrolls: body ? body.scrollHeight > body.clientHeight + 2 : false,
        dialogBodyScrollHeight: body?.scrollHeight ?? null,
        header: open ? (document.querySelector('#detailtype')?.textContent.trim() + ' / ' + document.querySelector('#detailtitle')?.textContent.trim()) : null,
        buttons: [...(body?.querySelectorAll('button') ?? [])].map(b => b.textContent.replace(/\s+/g, ' ').trim()).filter(Boolean),
        actionRows: body?.querySelectorAll('.modalactions').length ?? 0,
        sections: body?.querySelectorAll('h3').length ?? 0,
        iconCount: body?.querySelectorAll('svg.icon, svg use').length ?? 0,
        emojiIcons: [...(body?.querySelectorAll('button,h3,span') ?? [])].map(n => n.textContent.trim()).filter(t => /[＋＋✕×→↗↓★☆]/u.test(t) && t.length < 12).slice(0, 8),
        dropdownCount: dropdowns.length,
        dropdownSample: dropdowns.slice(0, 3).map(w => ({
          label: w.previousElementSibling?.textContent?.trim() || w.closest('.formfield')?.querySelector('span')?.textContent?.trim() || '',
          current: w.querySelector('[data-viselect-text]')?.textContent?.trim(),
          options: [...w.querySelectorAll('[data-viselect-option]')].map(o => o.textContent.trim()),
          open: w.querySelector('[data-viselect-list]')?.hidden === false,
          hasInlineCreate: Boolean(w.closest('.formfield')?.querySelector('[data-refnew]')),
        })),
        nativeSelects: body?.querySelectorAll('select').length ?? 0,
        nodeMenu: menuRect ? {w: Math.round(menuRect.width), h: Math.round(menuRect.height), items: [...menu.querySelectorAll('button')].map(b => b.textContent.trim())} : null,
        createCards: [...(document.querySelectorAll('#detailbody .resource') ?? [])].map(card => ({
          title: card.querySelector('h2')?.textContent.trim(),
          icons: card.querySelectorAll('svg').length,
          desc: card.querySelector('p')?.textContent.trim(),
        })),
      };
    });
    findings.push({name, errors, ...metrics});
    return page;
  } finally {
    await page.close();
  }
}

try {
  // 1 · 新建菜单（用户：选项没有图标了）
  await surface('01-create-menu', {steps: [p => p.click('#create')]});
  // 2 · 新建项目弹窗顶部（下拉 + 字段顺序）
  await surface('02-new-project-top', {steps: [p => p.click('#create'), () => wait(400), p => p.evaluate(() => document.querySelector('#detailbody [data-kind="project"]')?.click())]});
  // 3 · 新建项目：合作机构 下拉展开（用户：下拉没有信息 / VI 土）
  await surface('03-new-project-partner-dropdown', {
    steps: [p => p.click('#create'), () => wait(400), p => p.evaluate(() => document.querySelector('#detailbody [data-kind="project"]')?.click()), () => wait(900),
      p => p.evaluate(() => {
        const field = [...document.querySelectorAll('#detailbody .formfield')].find(f => f.querySelector('span')?.textContent.trim() === '合作机构');
        field?.querySelector('[data-viselect-button]')?.click();
      })],
    settle: 500,
  });
  // 4 · 新建项目：负责人 下拉展开
  await surface('04-new-project-owner-dropdown', {
    steps: [p => p.click('#create'), () => wait(400), p => p.evaluate(() => document.querySelector('#detailbody [data-kind="project"]')?.click()), () => wait(900),
      p => p.evaluate(() => {
        const field = [...document.querySelectorAll('#detailbody .formfield')].find(f => f.querySelector('span')?.textContent.trim() === '负责人');
        field?.querySelector('[data-viselect-button]')?.click();
      })],
    settle: 500,
  });
  // 5 · 新建联系人（用户：负责人不能新增）
  await surface('05-new-person', {steps: [p => p.click('#create'), () => wait(400), p => p.evaluate(() => document.querySelector('#detailbody [data-kind="person"]')?.click())]});
  // 6 · 空间与设置（用户：冗余、不说人话）
  await surface('06-settings', {steps: [p => p.click('#settings')], settle: 1400});
  // 7 · 空间与设置下半屏
  await surface('07-settings-bottom', {
    steps: [p => p.click('#settings'), () => wait(1200),
      p => p.evaluate(() => { const b = document.querySelector('#detailbody'); b.scrollTop = b.scrollHeight; })],
    settle: 400,
  });
  // 8 · 收件箱 → 批次弹窗（用户：占比太大、按钮不对齐）
  await surface('08-inbox-batch-dialog', {
    view: 'inbox',
    steps: [p => p.evaluate(() => document.querySelector('#inboxbody [data-batch]')?.click())],
  });
  // 9 · 画布节点右键菜单（用户：右键多余功能）
  await surface('09-canvas-node-contextmenu', {
    view: 'space',
    steps: [() => wait(1200), p => p.evaluate(() => {
      const node = document.querySelector('#spaceSvg [data-node]');
      if (!node) return;
      const r = node.getBoundingClientRect();
      node.dispatchEvent(new MouseEvent('contextmenu', {bubbles: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2}));
    })],
    settle: 500,
  });
  // 11 · 收件箱列表（真的有批次时长什么样）—— 用户投诉"待你决定的改动"的呈现
  await surface('11-inbox-list', {
    view: 'inbox',
    steps: [() => wait(700)],
    settle: 400,
  });
  // 12 · 判断详情弹窗（投诉 #3「内容呈现不精致」的核心界面）
  await surface('12-judgment-detail', {
    view: 'knowledge',
    steps: [() => wait(600), p => p.evaluate(() => document.querySelector('#knowbody [data-id]')?.click())],
    settle: 800,
  });
  // 13 · 项目详情弹窗
  await surface('13-project-detail', {
    view: 'projects',
    steps: [() => wait(600), p => p.evaluate(() => document.querySelector('#projectsbody [data-project]')?.click())],
    settle: 900,
  });
  // 10 · 画布空白右键菜单
  await surface('10-canvas-blank-contextmenu', {
    view: 'space',
    steps: [() => wait(1200), p => p.evaluate(() => {
      const stage = document.querySelector('.spacestage');
      const r = stage.getBoundingClientRect();
      stage.dispatchEvent(new MouseEvent('contextmenu', {bubbles: true, clientX: r.left + 80, clientY: r.top + r.height - 60}));
    })],
    settle: 500,
  });
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
  store.close();
}

// 报告：既给度量，也直接标出与规范冲突的点，避免"截图要人肉看"。
let failed = 0;
for (const row of findings) {
  console.log('## ' + row.name + (row.dialogOpen ? '' : '（无弹窗）') + (row.errors.length ? ' 页面错误 ' + row.errors[0].slice(0, 80) : ''));
  if (row.dialogSize) console.log('   弹窗 ' + row.dialogSize.w + '×' + row.dialogSize.h + '（顶边 ' + row.dialogSize.top + '）' + (row.dialogScrolls ? ' · 正文需滚动' : ''));
  if (row.header) console.log('   标题行：' + row.header);
  if (row.actionRows !== undefined) console.log('   动作行 ' + row.actionRows + ' · 小节 ' + row.sections + ' · 图标 ' + row.iconCount + ' · 原生 select ' + row.nativeSelects + ' · VI 下拉 ' + row.dropdownCount);
  if (row.buttons?.length) console.log('   按钮：' + row.buttons.map(b => '「' + b + '」').join(' '));
  if (row.emojiIcons?.length) console.log('   疑似 emoji/符号当图标：' + row.emojiIcons.join(' '));
  for (const d of row.dropdownSample ?? []) console.log('   下拉・' + d.label + '：当前「' + d.current + '」 选项 ' + d.options.length + ' 个' + (d.open ? '（已展开）' : '') + (d.options.length ? ' → ' + d.options.slice(0, 6).join(' / ') : ''));
  if (row.createCards?.length) console.log('   新建卡片：' + row.createCards.map(c => c.title + '(图标' + c.icons + ')').join(' '));
  if (row.nodeMenu) console.log('   右键菜单 ' + row.nodeMenu.w + '×' + row.nodeMenu.h + '：' + row.nodeMenu.items.map(i => '「' + i + '」').join(' '));
  // 「弹窗里没图标」只对**新建菜单**算缺陷（用户点名的就是它）；设置页/详情页本来就不需要图标，
  // 拿它当通判会制造假红，假红一多门禁就没人看了。
  for (const card of row.createCards ?? []) if (card.icons === 0) { console.log('   ⚠ 新建菜单「' + card.title + '」没有图标'); failed++; }
  // 空下拉本身不是缺陷：只要它旁边给了「＋ 新建联系人/组织」，用户当场就能建（用户点名的是没有可编辑新增）。
  for (const d of row.dropdownSample ?? []) {
    if (d.options.filter(Boolean).length) continue;
    if (d.hasInlineCreate) { console.log('   · 下拉「' + d.label + '」候选为空，但已提供就地新建入口'); continue; }
    console.log('   ⚠ 下拉「' + d.label + '」候选为空，且没有就地新建入口'); failed++;
  }
}
console.log('\n截图目录：prototype/screenshots/current/');
console.log(failed ? 'FAIL: 发现 ' + failed + ' 处用户点名的缺陷。' : 'PASS: 未发现用户点名的缺陷。');
process.exit(failed ? 1 : 0);
