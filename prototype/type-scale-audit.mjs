/** 字阶门禁（VI §3）：把**真实渲染**的字号逐个量出来，凡是不在字阶内的都算失败。
 *
 *  为什么必须有这个脚本：VI §13 门禁 3 写的是「字阶外字号 = 0」，但 style-check.mjs 只扫
 *  自己新增的 CSS，扫不到 v7-shell.html 的内联样式与 --proto-font-* 变量；于是 9/10/24/25/26/29px
 *  一路进了发布包。门禁必须量**渲染结果**，不能只扫源码字符串。
 *
 *  用法：node prototype/type-scale-audit.mjs
 *  字阶（唯一一套，不得新增）：32 / 22 / 18 / 15 / 14 / 13 / 12 / 11（13–15 同为「小标题·标签」档）。
 */
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {httpRoute} from '../src/http-route.mjs';
import {WorkstationStore} from '../src/store.mjs';
import {ExecutionStore} from '../src/execution-store.mjs';
import {seedVisualStore} from './visual-seed.mjs';
import {puppeteer, chromeExecutable} from '../dev-deps.mjs';

const chrome = chromeExecutable();

export const SCALE = ['32px', '22px', '18px', '15px', '14px', '13px', '12px', '11px'];
export const VIEWS = ['home', 'inbox', 'space', 'projects', 'tasks', 'knowledge', 'personal'];

export async function measure({views = VIEWS, port = 0} = {}) {
  const store = new WorkstationStore(':memory:');
  const executions = new ExecutionStore(store);
  seedVisualStore(store);
  const connection = {admit: () => ({peer: {id: 'audit'}}), requestRejection: () => undefined};
  const route = httpRoute({
    store, executions, connection,
    workspaceRegistry: {list: () => [{id: 'w', title: '个人空间'}], get: () => ({id: 'w'})},
    allowedWorkspaces: ['w'],
  });
  const server = createServer((request, response) => route.handler(request, response));
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  const browser = await puppeteer.launch({executablePath: chrome, headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu']});
  const page = await browser.newPage();
  await page.setViewport({width: 1440, height: 940});
  const report = {};
  try {
    await page.goto('http://127.0.0.1:' + server.address().port + '/personal-workstation', {waitUntil: 'networkidle0'});
    await page.waitForFunction(() => document.querySelectorAll('#projectstrip [data-project]').length > 0, {timeout: 15000});
    for (const view of views) {
      await page.evaluate(v => document.querySelector('.nav [data-view="' + v + '"]')?.click(), view);
      await new Promise(resolve => setTimeout(resolve, 600));
      report[view] = await page.evaluate(() => {
        const tally = {}, examples = {};
        // 2026-10-17 补两类检查（之前只查字号，于是漏了）：
        //  · 字重：浏览器给 h1–h6 的默认是 700，不在 VI 标尺 400/550/600 —— 实测 h3 就是 700，
        //    而门禁只扫源码里的 `font-weight:700`，一直没发现；
        //  · 11px 的**用法**：规范允许 11，但只用于「时间、坐标等非关键信息」。
        //    原型把它用在导航组标题、指标标签、按钮上，属于用错档。
        const badWeight = [], misusedMin = [];
        for (const el of document.querySelectorAll('body *')) {
          const rect = el.getBoundingClientRect();
          if (rect.width < 1 || rect.height < 1) continue;
          const cs = getComputedStyle(el);
          if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) continue;
          const text = (el.textContent || '').trim();
          if (!text || el.children.length) continue;
          const cls = typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : el.tagName.toLowerCase();
          const key = cs.fontSize + '/' + cs.fontWeight;
          tally[key] = (tally[key] || 0) + 1;
          if (!examples[key]) examples[key] = text.slice(0, 28);
          if (!['400', '550', '600'].includes(cs.fontWeight)) badWeight.push({value: cs.fontWeight, el: cls, sample: text.slice(0, 16)});
          // 11px 的合法用法：**时间**（<time> / .caldate）与**坐标/比例读数**（画布缩放百分比 #zoomlabel）。
          // 规范原文：「11（仅时间、坐标等非关键信息）」。
          const isTimeLike = el.tagName === 'TIME' || el.classList.contains('caldate') || el.id === 'zoomlabel';
          if (cs.fontSize === '11px' && !isTimeLike) misusedMin.push({el: cls, sample: text.slice(0, 16)});
        }
        return {tally, examples, badWeight, misusedMin};
      });
    }
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
    store.close();
  }
  return report;
}

if (process.argv[1]) {
  const report = await measure();
  const offScale = [];
  const badWeight = [];
  const misusedMin = [];
  for (const [view, {tally, examples, badWeight: bw = [], misusedMin: mm = []}] of Object.entries(report)) {
    badWeight.push(...bw.map(row => ({view, ...row})));
    misusedMin.push(...mm.map(row => ({view, ...row})));
    console.log('### ' + view);
    for (const [key, count] of Object.entries(tally).sort((a, b) => b[1] - a[1])) {
      const size = key.split('/')[0];
      const ok = SCALE.includes(size);
      if (!ok) offScale.push({view, key, count, example: examples[key]});
      console.log('  ' + (ok ? '  ' : '⚠ ') + key.padEnd(18) + String(count).padStart(4) + '  «' + examples[key] + '»');
    }
  }
  console.log('');
  const problems = [];
  if (offScale.length) {
    problems.push('字阶外字号 ' + offScale.length + ' 种');
    for (const row of offScale) console.log('  · 字阶外 ' + row.view + ' ' + row.key + ' ×' + row.count + ' «' + row.example + '»');
  }
  if (badWeight.length) {
    problems.push('字重不在标尺 ' + badWeight.length + ' 处');
    for (const row of badWeight.slice(0, 8)) console.log('  · 字重 ' + row.view + ' ' + row.value + ' ' + row.el + ' «' + row.sample + '»');
  }
  if (misusedMin.length) {
    problems.push('11px 用在非时间元素 ' + misusedMin.length + ' 处');
    for (const row of misusedMin.slice(0, 8)) console.log('  · 11px ' + row.view + ' ' + row.el + ' «' + row.sample + '»（11 只许用于时间/坐标）');
  }
  if (problems.length) {
    console.log('FAIL: ' + problems.join(' · '));
    process.exit(1);
  }
  console.log('PASS: 所有页面的渲染字号在 VI 字阶内 · 字重都在 400/550/600 · 11px 只用于时间/日期。');

  // ── VI §3.3 字重（2026-10-16 补）──────────────────────────────────────────
  // 为什么补：VI 写的是"字重只有 400 / 550（数据）/ 600（标题）"，但**从来没有任何门禁查字重** ——
  // 于是外壳里留着 620 / 650（"比 600 更重"的随手值）、工作台层留着 500，一直没人管。
  // 渲染级量不到字重，所以这里直接扫**实际会被服务的那份产物**。
  const WEIGHT_ALLOWED = new Set(['400', '550', '600']);
  const path = await import('node:path');
  const fs = await import('node:fs');
  const {fileURLToPath} = await import('node:url');
  const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const weightFiles = [
    path.join(rootDir, 'src', 'v7-shell.html'),
    ...fs.readdirSync(path.join(rootDir, 'src', 'v7')).filter(name => name.endsWith('.css')).map(name => path.join(rootDir, 'src', 'v7', name)),
  ];
  const badWeights = [];
  for (const file of weightFiles) {
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const hit of text.matchAll(/font-weight:\s*([0-9]{3})/g)) {
      if (!WEIGHT_ALLOWED.has(hit[1])) badWeights.push(path.basename(file) + ' → font-weight:' + hit[1]);
    }
  }
  if (badWeights.length) {
    console.log('FAIL: 字阶外的字重 ' + badWeights.length + ' 处（VI §3.3 只允许 400 / 550 / 600）：');
    for (const row of [...new Set(badWeights)].slice(0, 10)) console.log('  · ' + row);
    process.exit(1);
  }
  console.log('PASS: 字重只有 400 / 550 / 600（VI §3.3）。');

  // ── VI §3 正文档（2026-10-16 补）──────────────────────────────────────────
  // 实测：**阅读器（.reader / .mdbody）——全站唯一读长文的地方——用的是 13px**，
  // 也就是说"正文 14/22"这一档在实现里根本不存在。13px 在第 3 节里是"小标题/标签"档，
  // 拿来当正文会让长文偏小。这里把它钉住，防止以后回退。
  const cssAll = weightFiles.filter(f => f.endsWith('.css')).map(f => { try { return fs.readFileSync(f, 'utf8') } catch { return '' } }).join('\n');
  // **两条都要查**（第一版写成"匹配任一即可"，于是 .mdbody 回退成 13px 时它会去看 .reader 然后报通过 —— 又是一次假绿）。
  const readerRules = [
    {name: '.mdbody（Markdown 正文）', re: /\.mdbody\{[^}]*font-size:(\d+)px[^}]*line-height:([\d.]+)px/},
    {name: '.reader（内容阅读器）', re: /\.reader\{[^}]*font-size:(\d+)px[^}]*line-height:([\d.]+)px/},
  ];
  for (const rule of readerRules) {
    const hit = rule.re.exec(cssAll);
    if (!hit) {
      console.log('FAIL: 找不到 ' + rule.name + ' 的字号规则（或它不是"Npx/Npx"写法）—— 正文层级无从判定，不算通过。');
      process.exit(1);
    }
    if (Number(hit[1]) !== 14 || Number(hit[2]) !== 22) {
      console.log('FAIL: ' + rule.name + ' 是 ' + hit[1] + '/' + hit[2] + '，VI §3 规定正文为 14/22。');
      process.exit(1);
    }
  }
  console.log('PASS: 阅读器与 Markdown 正文都是 14/22（VI §3 正文档）。');
}
