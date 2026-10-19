/** CSS 变量门禁：**在真实浏览器里**断言产物引用的每个 `var(--…)` 都有定义。
 *
 *  为什么必须有这个脚本（2026-10-14 事故，用户点名"字体太大、整体显老"的根因）：
 *  `design-system/build.py` 生成 `v7-visual.css` 的 `:root` 块时，每条自定义属性声明
 *  **漏了结尾分号**。CSS 用分号分隔声明、换行不算分隔符，于是第一条之后的 36 条声明
 *  被并进第一条自定义属性的**值**里：
 *      --ws-tint-264dad → "#264dad\n  --ws-tint-505a66:#505a66\n  … --ws-font-32:32px"
 *  结果 --ws-font-11…32 与全部 --ws-tint-* 在运行时**未定义**：
 *    · body{font-size:var(--ws-font-13)} 变成 invalid-at-computed-value-time
 *      → font-size 回落到继承值 16px，并且因为它在更晚的层，**压掉了外壳里的 13px**；
 *    · 数据层本该 32px 的数字、弹窗标题本该 22px，全部退化成 16px —— 字阶塌成一条平线，
 *      这就是"字体太大、整体显得老龄化"的机制；
 *    · 覆盖层的描边/悬停底色（--ws-tint-*）全部失效，卡片只剩白底。
 *  而当时的门禁 `style-check.mjs` 只做**字符串匹配**（源码里没有字面色值就算过），
 *  它数的是"写成了 var()"，不是"变量解得开" —— 门禁绿着，界面坏着。
 *
 *  所以本门禁只认**渲染结果**：把产物 CSS 里出现的所有变量名收集起来，在页面上逐个求值。
 *
 *  用法：node prototype/css-var-audit.mjs
 */
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {readFileSync,readdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {httpRoute} from '../src/http-route.mjs';
import {WorkstationStore} from '../src/store.mjs';
import {ExecutionStore} from '../src/execution-store.mjs';
import {seedVisualStore} from './visual-seed.mjs';
import {puppeteer, chromeExecutable} from '../dev-deps.mjs';

const chrome = chromeExecutable();

const v7 = fileURLToPath(new URL('../src/v7/', import.meta.url));
const shellFile = fileURLToPath(new URL('../src/v7-shell.html', import.meta.url));

/** 收集三类信息：
 *  referenced —— `var(--x)`（**不带兜底值**；`var(--x, 默认)` 允许未定义，是合法的可选变量）
 *  declaredCss —— 在产物 CSS 里被声明过（应能在 :root 求到值，除非只在 [data-theme] 作用域里）
 *  declaredJs —— 由脚本写在元素 style 上（元素级变量，:root 上本来就不该有值）
 */
function collect() {
  const referenced = new Map(), declaredCss = new Set(), declaredJs = new Set();
  const scanUses = (text, where) => {
    for (const match of text.matchAll(/var\(\s*(--[a-zA-Z0-9_-]+)\s*([,)])/g)) {
      if (match[2] === ',') continue;        // 有兜底值：未定义也合法
      if (!referenced.has(match[1])) referenced.set(match[1], where);
    }
  };
  const scanDecls = (text, into) => {
    for (const match of text.matchAll(/(^|[;{\s])(--[a-zA-Z0-9_-]+)\s*:/g)) into.add(match[2]);
  };
  scanUses(readFileSync(shellFile, 'utf8'), 'v7-shell.html');
  scanDecls(readFileSync(shellFile, 'utf8'), declaredCss);
  for (const name of readdirSync(v7)) {
    const full = join(v7, name);
    if (name.endsWith('.css')) { scanUses(readFileSync(full, 'utf8'), 'v7/' + name); scanDecls(readFileSync(full, 'utf8'), declaredCss); }
    else if (name.endsWith('.mjs')) { scanUses(readFileSync(full, 'utf8'), 'v7/' + name); scanDecls(readFileSync(full, 'utf8'), declaredJs); }
  }
  return {referenced, declaredCss, declaredJs};
}

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
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

const browser = await puppeteer.launch({executablePath: chrome, headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu']});
let failed = 0;
try {
  const page = await browser.newPage();
  await page.setViewport({width: 1440, height: 940});
  await page.goto('http://127.0.0.1:' + server.address().port + '/personal-workstation', {waitUntil: 'networkidle0'});
  await page.waitForFunction(() => document.querySelectorAll('#projectstrip [data-project]').length > 0, {timeout: 15000});

  const {referenced, declaredCss, declaredJs} = collect();
  const names = [...referenced.keys()];
  const rootNames = names.filter(name => declaredCss.has(name));
  const values = await page.evaluate(list => {
    const style = getComputedStyle(document.documentElement);
    const out = {};
    for (const name of list) out[name] = style.getPropertyValue(name).trim();
    return out;
  }, names);

  // ① 真·未定义：既没在产物 CSS 里声明，也没有脚本往元素上写 —— 引用它的声明一定失效（多为拼写错误）。
  const typo = names.filter(name => !declaredCss.has(name) && !declaredJs.has(name));
  // ② 声明过但在浏览器里求不到值（含"只在 [data-theme=dark] 里声明"这类作用域变量，需人工判断）。
  const unresolved = rootNames.filter(name => !values[name]);
  // ③ 值里再出现 " --other:" 说明发生了"声明被并进前一条的值"这类解析事故（缺分号），即使看着有值也不可信。
  const swallowed = rootNames.filter(name => /--[a-zA-Z0-9_-]+\s*:/.test(values[name] ?? ''));

  console.log('产物引用变量 ' + names.length + ' 个（其中 CSS 声明 ' + rootNames.length + ' 个 · 元素级 ' + names.filter(n => declaredJs.has(n) && !declaredCss.has(n)).length + ' 个）');
  if (typo.length) {
    failed += typo.length;
    console.log('FAIL: 引用了从未声明的变量（拼写错误），这些声明会整条失效：');
    for (const name of typo) console.log('  · ' + name + '（' + referenced.get(name) + '）');
  }
  if (swallowed.length) {
    failed += swallowed.length;
    console.log('FAIL: 变量的值里含着别的声明，说明 CSS 声明分隔被写坏（缺分号）：');
    for (const name of swallowed) console.log('  · ' + name + ' = ' + values[name].replace(/\s+/g, ' ').slice(0, 90) + '…');
  }
  if (unresolved.length) {
    // 深色作用域变量（v7-dark.css 里的 --paper/--action/…）在浅色下本来就不该有值。
    // 不搞白名单——真的切到深色再量一次，能量到才算通过。
    const darkValues = await page.evaluate(async list => {
      document.documentElement.dataset.theme = 'dark';
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const style = getComputedStyle(document.documentElement);
      const out = {};
      for (const name of list) out[name] = style.getPropertyValue(name).trim();
      document.documentElement.removeAttribute('data-theme');
      return out;
    }, unresolved);
    const stillMissing = unresolved.filter(name => !darkValues[name]);
    const darkOnly = unresolved.length - stillMissing.length;
    if (darkOnly) console.log('提示：' + darkOnly + ' 个变量只在深色作用域声明（切换深色后能求到值，判为通过）：' + unresolved.filter(n => darkValues[n]).join(' '));
    if (stillMissing.length) {
      failed += stillMissing.length;
      console.log('FAIL: 在产物 CSS 里声明、但浅色与深色下都求不到值：');
      for (const name of stillMissing) console.log('  · ' + name + '（' + referenced.get(name) + '）');
    }
  }

  // 金丝雀：VI §3 正文档 = 14/22（2026-10-18 W2-1 按规范回正；旧断言写成 13px 是把原型缺陷当标准）。
  // body 若回到 16px 或塌成 13px，说明字阶层又断了。
  const body = await page.evaluate(() => getComputedStyle(document.body).fontSize);
  console.log('金丝雀 · body 字号 = ' + body + '（VI §3 正文档应为 14px）');
  if (body !== '14px') { failed++; console.log('FAIL: body 字号不是 14px —— VI 字号变量层没有生效（§3 正文档 14/22）。'); }

  // 金丝雀：cards 的描边来自 --ws-tint-*，变量断掉时卡片会变成"白底无边框"。
  const cardBorder = await page.evaluate(() => {
    const card = document.querySelector('.surface');
    return card ? getComputedStyle(card).borderTopColor : '';
  });
  console.log('金丝雀 · .surface 描边色 = ' + cardBorder);
  if (!cardBorder || cardBorder === 'rgba(0, 0, 0, 0)') { failed++; console.log('FAIL: 卡片没有描边 —— 覆盖层的 --ws-tint-* 没有生效。'); }

  // ── VI §12 宿主主题（2026-10-16 补）──────────────────────────────────────
  // 规范要求「插件**必须消费宿主主题语义变量**，不自行发明一套主题映射」。
  // 实测原来是 0 命中 —— 工作台完全用自己的字面色值，宿主切深色只能靠自带的那份硬撑。
  // 判据分两步，缺一不可：
  //   ① 映射层存在，且写的是 `var(--dsw-…, <兜底>)`（宿主不在时不能变成无色）；
  //   ② **真的会跟随**：注入宿主变量后，--ws-* 必须跟着变。
  const mapping = await page.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    return {ink: root.getPropertyValue('--ws-ink').trim(), action: root.getPropertyValue('--ws-action').trim()};
  });
  const followed = await page.evaluate(() => {
    const style = document.createElement('style');
    style.textContent = ':root{--dsw-alias-label-primary:#010203;--dsw-alias-brand-primary:#040506}';
    document.head.append(style);
    const root = getComputedStyle(document.documentElement);
    const after = {ink: root.getPropertyValue('--ws-ink').trim(), action: root.getPropertyValue('--ws-action').trim()};
    style.remove();
    return after;
  });
  console.log('金丝雀 · 宿主主题：--ws-ink ' + mapping.ink + ' → 注入 --dsw-alias-label-primary 后 ' + followed.ink);
  if (!/^#010203$/i.test(followed.ink)) {
    failed += 1;
    console.log('FAIL: 注入宿主主题变量后 --ws-ink 没有跟随（VI §12：必须消费宿主主题语义变量）—— 实得 ' + followed.ink);
  }
  if (!/^#040506$/i.test(followed.action)) {
    failed += 1;
    console.log('FAIL: 注入宿主品牌色后 --ws-action 没有跟随（VI §12）—— 实得 ' + followed.action);
  }

  // 深色段不能丢（我踩过的坑）：映射层加载在 tokens 之后，若只写 `:root{}`，
  // 会把 tokens 里的 `[data-theme="dark"]{}` 整段盖掉 —— 深色页变成"浅底深字"，
  // 深色对比度门禁当场从通过掉到 50 个节点不达标。这里直接量一次。
  const darkInk = await page.evaluate(() => {
    const previous = document.documentElement.dataset.theme;
    document.documentElement.dataset.theme = 'dark';
    const value = getComputedStyle(document.documentElement).getPropertyValue('--ws-ink').trim();
    if (previous === undefined) delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = previous;
    return value;
  });
  const lightInk = mapping.ink;
  console.log('金丝雀 · 深色下的 --ws-ink = ' + darkInk + '（浅色是 ' + lightInk + '）');
  if (darkInk.toLowerCase() === lightInk.toLowerCase()) {
    failed += 1;
    console.log('FAIL: 深色下 --ws-ink 与浅色相同 —— 宿主主题映射层把 tokens 的深色段盖掉了（VI §11 深色不可倒退）。');
  }
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
  store.close();
}

// VI §4 断点（2026-10-16 补）：规范是 ≥1200 全量 / 701–1199 双列 / ≤700 单列。
// 实测原型写的是 1150 —— 1151–1199 这一段会走全量，与规范不符。这里把它钉住。
{
  const {readFileSync} = await import('node:fs');
  const {join, dirname} = await import('node:path');
  const {fileURLToPath} = await import('node:url');
  const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
  let shell = '';
  try { shell = readFileSync(join(rootDir, 'src', 'v7-shell.html'), 'utf8'); } catch { shell = ''; }
  if (!shell) { console.log('FAIL: 读不到外壳产物，断点无从判定（不算通过）。'); failed += 1; }
  else {
    if (/max-width:1150px/.test(shell)) { console.log('  ⚠ 外壳里还有 max-width:1150px —— VI §4 要求双列区间是 701–1199。'); failed += 1; }
    if (!/max-width:1199px/.test(shell)) { console.log('  ⚠ 外壳里没有 max-width:1199px —— 双列断点与 VI §4 不一致。'); failed += 1; }
    if (!/max-width:700px/.test(shell)) { console.log('  ⚠ 外壳里没有 max-width:700px —— 单列断点缺失。'); failed += 1; }
  }
}

console.log(failed ? 'FAIL: CSS 变量门禁未通过（' + failed + ' 项）。' : 'PASS: 产物引用的变量全部有定义，字号与描边变量层生效；断点符合 VI §4。');
process.exit(failed ? 1 : 0);
