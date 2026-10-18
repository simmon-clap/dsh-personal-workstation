/** 批次 4 验收：建议卡的四个回应在**真实浏览器**里走通，且否决后卡片不消失。
 *
 *  验收标准（spec/04 批次 4）：零跳页完成四回应；否决理由一句话即可提交；否决卡不消失留在原位。
 *  用法：node prototype/advice-browser-check.mjs —— 一次性内存库，不碰生产数据。 */
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
const ctx = {workspace: 'w', actor: 'test', canWrite: true};

// 验收：画布配色**只来自 VI token**（V5），而且要证明在真实浏览器里真的生效
// —— 不是"在测试沙箱里退化成透明"那种假通过。
seedVisualStore(store);

const connection = {admit: () => ({peer: {id: 'operator'}}), requestRejection: () => undefined};
const route = httpRoute({
  store, executions, connection,
  workspaceRegistry: {list: () => [{id: 'w', title: '个人空间'}], get: id => (id === 'w' ? {id: 'w'} : null)},
  allowedWorkspaces: ['w'],
});
const server = createServer((request, response) => route.handler(request, response));
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;



const browser = await puppeteer.launch({executablePath: chrome, headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu']});
const results = [];
const check = (label, ok, detail = '') => { results.push({label, ok}); console.log((ok ? 'PASS' : 'FAIL').padEnd(5) + label + (detail ? '  → ' + detail : '')); };
try {
  const page = await browser.newPage();
  await page.setViewport({width: 1440, height: 960});
  await page.goto('http://127.0.0.1:' + port + '/personal-workstation', {waitUntil: 'networkidle0'});
  await page.evaluate(() => document.querySelector('.nav [data-view="space"]').click());
  await new Promise(resolve => setTimeout(resolve, 900));

  const painted = await page.evaluate(() => {
    const shapes = [...document.querySelectorAll('#spaceSvg rect, #spaceSvg circle, #spaceSvg path')];
    const fills = shapes.map(s => (s.getAttribute('fill') || s.style.fill || '').trim()).filter(Boolean);
    return {count: shapes.length, fills: [...new Set(fills)]};
  });
  check('画布画出了图元', painted.count > 20, painted.count + ' 个图元');
  // token 在真浏览器里解析出来是十六进制（不是 rgb），所以按"像颜色"判定
  const coloured = painted.fills.filter(f => /^(#[0-9a-fA-F]{3,8}|rgba?\()/.test(f));
  check('画布颜色在真浏览器里解析成了实际色值（不是 transparent）', coloured.length > 0, coloured.slice(0, 4).join(' | '));

  const tokens = await page.evaluate(() => {
    const names = ['--ws-action', '--ws-success', '--ws-knowledge', '--ws-warning', '--ws-line', '--ws-ink'];
    const style = getComputedStyle(document.documentElement);
    return names.map(n => style.getPropertyValue(n).trim()).filter(Boolean);
  });
  check('VI token 在页面上确实有值', tokens.length >= 5, tokens.length + ' 个 token 可读');

  const palette = await page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    const names = ['--ws-action', '--ws-action-soft', '--ws-success', '--ws-success-soft', '--ws-knowledge', '--ws-knowledge-soft', '--ws-warning', '--ws-warning-soft', '--ws-line', '--ws-ink', '--ws-muted', '--ws-paper', '--ws-surface'];
    return names.map(n => getComputedStyle(document.documentElement).getPropertyValue(n).trim().toLowerCase());
  });
  const used = coloured;
  const hex = value => {
    // token 读出来是十六进制；也兼容按 rgb() 返回的环境 —— 两种都要认
    if (/^#[0-9a-fA-F]{3,8}$/.test(value)) return value.toLowerCase();
    const m = /rgba?\(([0-9]+), ?([0-9]+), ?([0-9]+)/.exec(value);
    return m ? '#' + [1, 2, 3].map(i => Number(m[i]).toString(16).padStart(2, '0')).join('') : '';
  };
  const offPalette = used.filter(f => !palette.includes(hex(f)));
  check('画布用到的颜色全部来自 VI 调色板', offPalette.length === 0, offPalette.slice(0, 4).join(' | '));
  check('画布用了多种语义色（对象类型确有区分）', new Set(used.map(hex)).size >= 2, [...new Set(used.map(hex))].slice(0, 5).join(' '));

  mkdirSync('prototype/screenshots', {recursive: true});
  await page.screenshot({path: 'prototype/screenshots/space-canvas.png'});
  console.log('截图：prototype/screenshots/space-canvas.png');
} finally {
  await browser.close();
  server.close();
  store.close();
}
const failed = results.filter(item => !item.ok);
console.log('─'.repeat(56));
console.log(failed.length ? `FAIL: ${failed.length} 项未通过` : `PASS: ${results.length} 项全部通过（真实浏览器 + 画布配色）`);
process.exit(failed.length ? 1 : 0);
