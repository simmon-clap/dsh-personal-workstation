#!/usr/bin/env node
/** **在真实运行实例 + 真实数据上**量视觉规范（VI）—— 不是夹具。
 *
 *  为什么另做一个：`npm run verify` 里的视觉门禁全跑在**内存夹具**上，只能证明"逻辑对"。
 *  用户 2026-10-17 说"其实我还觉得有很多问题，特别是在视觉规范上" —— 那就必须对着
 *  **他实际打开的那一页**逐元素量：字号 / 字重 / 颜色 / 圆角 / 间距 / 对比度 / 焦点环。
 *
 *  判据来源：`spec/02-VI规范-v1.0.md`
 *    · 字号：12 / 13 / 14 / 16 / 18 / 22 / 26 / 32（正文档）
 *    · 字重：400 / 550 / 600
 *    · 圆角：8 / 12 / 20 / 999
 *    · 间距：4 / 8 / 12 / 16 / 24 / 32 / 48 / 64 / 96（22 已收敛掉）
 *    · 正文对比度 ≥ 4.5:1；次要文字 ≥ 3:1
 *
 *  输出：每页一张违规清单（含"节点数 / 示例 / 影响面"）+ 截图，退出码只在**有违规**时非零。
 *  用法：node prototype/live-visual-audit.mjs [--json]
 */
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {mkdirSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {puppeteer, chromeExecutable} from '../dev-deps.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SHOTS = join(here, 'screenshots', 'live-visual');
mkdirSync(SHOTS, {recursive: true});

// ── 找实例与登录凭据（与 live-acceptance 同一套：多实例时"端口+cookie 配对试"）──────
const HOME = process.env.HOME ?? '';
const COOKIES = join(HOME, 'Library/Application Support/@deepseek-ai/dsh-desktop/Cookies');
function cookies() {
  try {
    return execFileSync('/usr/bin/sqlite3', ['-separator', '|', COOKIES, "select name,value from cookies where host_key='127.0.0.1' order by last_access_utc desc;"], {encoding: 'utf8'})
      .trim().split('\n').filter(Boolean).map(line => { const at = line.indexOf('|'); return line.slice(0, at) + '=' + line.slice(at + 1); });
  } catch { return []; }
}
function ports() {
  try {
    const out = execFileSync('/usr/sbin/lsof', ['-nP', '-iTCP', '-sTCP:LISTEN'], {encoding: 'utf8'});
    return [...new Set(out.split('\n').filter(line => /127\.0\.0\.1:\d+/.test(line)).map(line => Number(/127\.0\.0\.1:(\d+)/.exec(line)[1])))];
  } catch { return []; }
}
let BASE = null, COOKIE = null;
for (const port of ports()) {
  for (const cookie of cookies()) {
    try {
      const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 1200);
      const response = await fetch('http://127.0.0.1:' + port + '/personal-workstation', {headers: {cookie}, signal: controller.signal}).finally(() => clearTimeout(timer));
      if (response.ok) { BASE = 'http://127.0.0.1:' + port; COOKIE = cookie; break; }
    } catch {}
  }
  if (BASE) break;
}
if (!BASE) { console.log('FAIL: 找不到能打开的工作台实例（不是通过，是没测到）'); process.exit(1); }

// ── 在页面里量：返回违规项 ─────────────────────────────────────────────────
function measure() {
  const FONT_SIZES = [12, 13, 14, 16, 18, 22, 26, 32];
  const WEIGHTS = [400, 550, 600];
  const RADII = [0, 8, 12, 20, 999];
  const SPACING = [0, 4, 8, 12, 16, 24, 32, 48, 64, 96];
  const near = (value, list, tolerance) => list.some(allowed => Math.abs(value - allowed) <= tolerance);
  const describe = el => {
    const cls = typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : el.tagName.toLowerCase();
    return cls + (el.id ? '#' + el.id : '');
  };
  const isHidden = el => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return !r.width || !r.height || cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0; };
  const out = {fontSize: [], fontWeight: [], color: [], radius: [], spacing: [], contrast: [], total: 0};
  // `margin-top:auto` 在计算样式里会变成具体像素（278.219px 这种）—— 那不是我们写的间距，
  // 是"把元素推到底部"的布局结果。先收集"声明过 auto 边距的选择器"，命中的元素不判 margin。
  const autoSelectors = (() => {
    const selectors = [];
    const walk = rules => { for (const rule of rules) {
      if (rule.cssRules && rule.conditionText !== undefined) { try { if (matchMedia(rule.conditionText).matches) walk(rule.cssRules) } catch {} continue; }
      if (rule.selectorText && /margin[^:]*:\s*[^;]*auto/.test(rule.style?.cssText ?? '')) selectors.push(rule.selectorText);
    } };
    for (const sheet of document.styleSheets) { try { walk(sheet.cssRules) } catch {} }
    return selectors;
  })();
  const usesAutoMargin = el => autoSelectors.some(selector => { try { return el.matches(selector) } catch { return false } });
  const seen = new Set();
  for (const el of document.querySelectorAll('body *')) {
    if (isHidden(el)) continue;
    const cs = getComputedStyle(el);
    const text = (el.textContent ?? '').trim();
    const hasText = text.length > 0 && el.children.length === 0;
    out.total += 1;
    const key = describe(el) + '|' + cs.fontSize + '|' + cs.fontWeight + '|' + cs.color + '|' + cs.borderRadius + '|' + cs.padding + '|' + cs.margin;
    if (seen.has(key)) continue;
    seen.add(key);
    const sample = text.slice(0, 18);
    // 字号：只看**有文字的**元素（图标容器/图形没有字号概念）
    const fontSize = Number.parseFloat(cs.fontSize);
    if (hasText && Number.isFinite(fontSize) && !FONT_SIZES.includes(fontSize)) out.fontSize.push({el: describe(el), value: cs.fontSize, sample});
    const weight = Number(cs.fontWeight);
    if (hasText && Number.isFinite(weight) && !WEIGHTS.includes(weight)) out.fontWeight.push({el: describe(el), value: cs.fontWeight, sample});
    // 颜色：只查文字色（背景色多为变量/渐变，单独由门禁查）
    if (hasText) {
      const match = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)/.exec(cs.color);
      if (match) out.color.push({el: describe(el), value: cs.color, sample});
    }
    // 圆角：百分数视为圆形（状态点），不参与标尺
    if (!/%/.test(cs.borderTopLeftRadius)) {
      const radius = Number.parseFloat(cs.borderTopLeftRadius);
      if (Number.isFinite(radius) && !near(radius, RADII, 0.01)) out.radius.push({el: describe(el), value: cs.borderRadius});
    }
    for (const prop of ['padding', 'margin', 'gap']) {
      if (prop === 'margin' && usesAutoMargin(el)) continue;   // 声明了 auto：算出来的像素不是间距
      const value = prop === 'gap' ? cs.gap : cs[prop];
      if (!value || value === 'normal' || /auto/.test(value)) continue;
      const parts = String(value).split(' ').map(v => Number.parseFloat(v)).filter(v => Number.isFinite(v) && v > 0);
      if (parts.some(v => !near(v, SPACING, 0.6))) out.spacing.push({el: describe(el), prop, value});
    }
    // 对比度：文字 vs 最近的不透明背景
    if (hasText) {
      const parse = value => { const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?/.exec(value ?? ''); return m ? {r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4]} : null; };
      const lum = c => { const [r, g, b] = [c.r, c.g, c.b].map(v => v / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
      let bg = null, node = el;
      while (node && node !== document.documentElement) {
        const candidate = parse(getComputedStyle(node).backgroundColor);
        if (candidate && candidate.a > 0.5) { bg = candidate; break; }
        node = node.parentElement;
      }
      const fg = parse(cs.color);
      if (fg && bg) {
        const l1 = lum(fg), l2 = lum(bg);
        const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
        const size = Number.parseFloat(cs.fontSize);
        const big = size >= 18 || (size >= 14 && Number(cs.fontWeight) >= 600);
        const need = big ? 3 : 4.5;
        if (ratio < need) out.contrast.push({el: describe(el), ratio: Number(ratio.toFixed(2)), need, sample, color: cs.color});
      }
    }
  }
  return out;
}

const browser = await puppeteer.launch({executablePath: chromeExecutable(), headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu']});
const page = await browser.newPage();
await page.setViewport({width: 1440, height: 940});
await page.setCookie({name: COOKIE.split('=')[0], value: COOKIE.slice(COOKIE.indexOf('=') + 1), domain: '127.0.0.1', path: '/'});
await page.goto(BASE + '/personal-workstation', {waitUntil: 'networkidle0'});
await new Promise(resolve => setTimeout(resolve, 1800));

const VIEWS = [['home', '总览'], ['inbox', '收件箱'], ['projects', '项目'], ['tasks', '任务'], ['knowledge', '知识'], ['personal', '日程'], ['space', '画布']];
const report = {};
for (const [view, label] of VIEWS) {
  await page.evaluate(v => document.querySelector('.nav [data-view="' + v + '"]')?.click(), view);
  await new Promise(resolve => setTimeout(resolve, 1600));
  report[label] = await page.evaluate(measure);
  await page.screenshot({path: join(SHOTS, view + '.png')});
}
await browser.close();

const json = process.argv.includes('--json');
if (json) { console.log(JSON.stringify(report, null, 1)); process.exit(0); }

let violations = 0;
console.log('实例：' + BASE + '（真实数据）\n');
for (const [label, data] of Object.entries(report)) {
  const rows = [];
  const push = (kind, list, fmt) => { if (list.length) { violations += list.length; rows.push([kind, list.length, fmt(list[0])]); } };
  push('字号不在正文档', data.fontSize, one => one.value + ' «' + one.sample + '» ' + one.el);
  push('字重不在标尺', data.fontWeight, one => one.value + ' «' + one.sample + '» ' + one.el);
  push('圆角不在标尺', data.radius, one => one.value + ' ' + one.el);
  push('间距不在标尺', data.spacing, one => one.prop + ':' + one.value + ' ' + one.el);
  push('对比度不足', data.contrast, one => one.ratio + ':1（需 ' + one.need + ':1）«' + one.sample + '» ' + one.el);
  console.log('【' + label + '】元素 ' + data.total + ' 个 · 违规 ' + rows.reduce((sum, row) => sum + row[1], 0) + ' 处');
  for (const [kind, count, example] of rows) console.log('   ' + String(count).padStart(3) + '  ' + kind.padEnd(10) + ' 例：' + String(example).slice(0, 110));
  if (!rows.length) console.log('   （这一页没有违规）');
}
console.log('\n截图：' + SHOTS);
console.log(violations ? '\nFAIL：共 ' + violations + ' 处视觉偏差（这是**真实实例**上的测量，不是夹具）' : '\nPASS：真实实例上的视觉规范全部达标');
process.exit(violations ? 1 : 0);
