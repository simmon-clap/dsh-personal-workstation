/** 真入口复验：直接量**正在运行的那个工作台**（不是夹具）。
 *
 *  为什么要它：夹具上的门禁全绿，不代表用户浏览器里那一份也对 —— 组件是用户在真入口加载的
 *  那一份产物，用的是他自己 profile 的配置与真实数据。这个脚本把同一套判据搬到真入口上跑。
 *
 *  只读：只做 GET 与"打开弹窗"这类不改数据的动作；不点同意、不保存、不新建。
 *  凭据：从 DSH 桌面端的 Chromium Cookies 库里读本机会话 cookie（127.0.0.1，仅本机回环）。
 *
 *  用法：node prototype/live-entry-check.mjs [--port 19387]
 */
import {createRequire} from 'node:module';
import {mkdirSync, copyFileSync, rmSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {SCALE, RADIUS, measureInPage} from './measure-page.mjs';
import {puppeteer, chromeExecutable} from '../dev-deps.mjs';

const chrome = chromeExecutable();

const TYPE_SCALE = ['32px', '22px', '18px', '15px', '14px', '13px', '12px', '11px'];
const VIEWS = ['home', 'inbox', 'space', 'projects', 'tasks', 'knowledge', 'personal'];

const portFlag = process.argv.indexOf('--port');
const PORT = portFlag > 0 ? Number(process.argv[portFlag + 1]) : 19387;
const BASE = `http://127.0.0.1:${PORT}/personal-workstation`;

/** 从桌面端 Chromium 的 Cookies 库里取本机回环会话（库被锁着时先拷一份再读）。 */
function sessionCookie() {
  const source = `${process.env.HOME}/Library/Application Support/@deepseek-ai/dsh-desktop/Cookies`;
  const scratch = `/tmp/live-entry-cookies-${process.pid}.sqlite`;
  try {
    copyFileSync(source, scratch);
    const row = execFileSync('/usr/bin/sqlite3', [scratch, "select name||'='||value from cookies where host_key='127.0.0.1' limit 1;"], {encoding: 'utf8'}).trim();
    if (!row) throw Error('没有找到本机会话 cookie');
    const at = row.indexOf('=');
    return {name: row.slice(0, at), value: row.slice(at + 1)};
  } finally {
    rmSync(scratch, {force: true});
  }
}

const shots = fileURLToPath(new URL('./screenshots/live/', import.meta.url));
mkdirSync(shots, {recursive: true});

const cookie = sessionCookie();
const browser = await puppeteer.launch({executablePath: chrome, headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu']});
const page = await browser.newPage();
await page.setViewport({width: 1440, height: 940});
await browser.setCookie({name: cookie.name, value: cookie.value, domain: '127.0.0.1', path: '/'});

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const problems = [];
const sections = [];

try {
  await page.goto(BASE, {waitUntil: 'networkidle0'});
  // 真数据要先等渲染出来：空页面上量出来的结论不算数（第 3 轮踩过）。
  await page.waitForFunction(() => document.querySelectorAll('.nav [data-view]').length >= 7, {timeout: 20000});
  await wait(1500);

  const version = await page.evaluate(() => document.querySelector('#subtitle')?.textContent?.trim() ?? '');
  console.log('真入口：' + BASE);
  console.log('页头提示：' + version);

  for (const view of VIEWS) {
    await page.evaluate(v => document.querySelector('.nav [data-view="' + v + '"]')?.click(), view);
    await wait(700);
    const measured = await page.evaluate(measureInPage, RADIUS, SCALE, 'body');
    const scale = await page.evaluate(TYPE_SCALE => {
      const bad = [];
      for (const el of document.querySelectorAll('.view.active *')) {
        const rect = el.getBoundingClientRect();
        if (rect.width < 2 || rect.height < 2 || el.children.length) continue;
        if (!(el.textContent || '').trim()) continue;
        const size = getComputedStyle(el).fontSize;
        if (!TYPE_SCALE.includes(size)) bad.push(size + ' «' + el.textContent.trim().slice(0, 12) + '»');
      }
      return [...new Set(bad)];
    }, TYPE_SCALE);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    sections.push({label: '页面 · ' + view, ...measured, scale, overflow});
    await page.screenshot({path: shots + view + '.png'});
  }

  // 弹窗（只做"打开"，不改数据）
  for (const [name, open] of [
    ['新建菜单', async () => { await page.click('#create'); }],
    ['设置', async () => { await page.click('#settings'); }],
  ]) {
    await page.goto(BASE, {waitUntil: 'networkidle0'});
    await page.waitForFunction(() => document.querySelectorAll('.nav [data-view]').length >= 7, {timeout: 20000});
    await wait(1200);
    await open();
    await wait(1200);
    const opened = await page.evaluate(() => document.querySelector('#veil')?.classList.contains('open') ?? false);
    if (!opened) { problems.push('真入口弹窗打不开：' + name); continue; }
    sections.push({label: '弹窗 · ' + name, ...(await page.evaluate(measureInPage, RADIUS, SCALE, '#veil')), scale: [], overflow: 0});
    await page.screenshot({path: shots + 'dialog-' + (name === '新建菜单' ? 'create' : 'settings') + '.png'});
    await page.keyboard.press('Escape');
    await wait(400);
  }

  // 移动端：横向溢出与点击区
  await page.setViewport({width: 390, height: 844, isMobile: true, hasTouch: true});
  for (const view of VIEWS) {
    await page.goto(BASE, {waitUntil: 'networkidle0'});
    await page.waitForFunction(() => document.querySelectorAll('.nav [data-view]').length >= 7, {timeout: 20000});
    await wait(1200);
    await page.evaluate(v => document.querySelector('.nav [data-view="' + v + '"]')?.click(), view);
    await wait(600);
    const mobile = await page.evaluate(() => {
      const overflow = document.documentElement.scrollWidth - window.innerWidth;
      const small = [];
      const scrollable = el => {
        for (let node = el.parentElement; node && node !== document.body; node = node.parentElement) {
          const cs = getComputedStyle(node);
          if (/(auto|scroll)/.test(cs.overflowX) && node.scrollWidth > node.clientWidth + 1) return true;
        }
        return false;
      };
      for (const el of document.querySelectorAll('.view.active button,.view.active [role="button"],.view.active a[href],.view.active input:not([type=hidden]),.view.active .viselect-button')) {
        const rect = el.getBoundingClientRect();
        if (rect.width < 2 || rect.height < 2) continue;
        if (el.closest('#spaceSvg') || scrollable(el)) continue;
        if (rect.height < 43.5 || rect.width < 43.5) {
          const cls = el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).join('.') : el.tagName.toLowerCase();
          small.push(cls + ' ' + Math.round(rect.width) + '×' + Math.round(rect.height));
        }
      }
      return {overflow, small};
    });
    sections.push({label: '移动端 · ' + view, radius: [], spacing: [], texts: [], purple: [], small: mobile.small, overflow: mobile.overflow, scale: []});
    if (view === 'home') await page.screenshot({path: shots + 'mobile-home.png'});
  }
} finally {
  await browser.close();
}

// 汇总
const flat = field => sections.flatMap(section => (section[field] ?? []).map(row => ({...row, where: section.label})));
const uniq = (list, key) => [...new Map(list.map(item => [key(item), item])).values()];

for (const section of sections) {
  if (section.overflow > 1) problems.push(section.label + ' 横向溢出 ' + section.overflow + 'px');
  for (const size of section.scale ?? []) problems.push(section.label + ' 字阶外字号 ' + size);
}
for (const row of uniq(flat('radius'), r => r.cls + r.radius)) problems.push(row.where + ' 非规范圆角 ' + row.cls + ' ' + row.radius);
for (const row of uniq(flat('spacing'), r => r.cls + r.prop + r.value)) problems.push(row.where + ' 标尺外间距 ' + row.cls + ' ' + row.prop + ':' + row.value);
for (const row of uniq(flat('texts'), r => r.cls + r.color + r.bg)) problems.push(row.where + ' 对比度 ' + row.got + ':1（需 ' + row.need + '）«' + row.text + '»');
for (const row of uniq(flat('purple'), r => r.cls + r.text)) problems.push(row.where + ' 语义色误用 ' + row.cls + ' «' + row.text + '»');
for (const row of uniq(flat('small'), r => r)) problems.push(row);

console.log('截图目录：prototype/screenshots/live/');
if (problems.length) {
  console.log('\nFAIL: 真入口复验 ' + problems.length + ' 项未达标：');
  for (const problem of problems.slice(0, 40)) console.log('  ⚠ ' + problem);
} else {
  console.log('\nPASS: 真入口复验通过 —— 圆角/间距/对比度/语义色/字阶/横向溢出/移动点击区，');
  console.log('      在正在运行的工作台上（' + VIEWS.length + ' 个页面 + 2 个弹窗 + 移动端）全部达标。');
}
process.exit(problems.length ? 1 : 0);
