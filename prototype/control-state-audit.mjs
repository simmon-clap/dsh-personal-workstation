#!/usr/bin/env node
/** 控件四态门禁（VI §13 门禁 5：每个控件默认 / 悬停 / 聚焦 / 禁用齐全）。
 *
 *  为什么单独一道：VI 规范把它列进门禁清单，但**此前没有任何脚本查过它** ——
 *  实测结果是 `.btn` 既没有悬停态也没有禁用态（禁用按钮与可用按钮长得一样，点下去没反应），
 *  而"点了没反应"正是宪章第六条「有重量」点名要拒绝的东西。
 *
 *  判据只看**实际会被服务的那份产物**（外壳 + 工作台层），不做渲染级断言：
 *  渲染级只能验"现在这个元素有没有变化"，验不出"以后新加的控件有没有补四态"。
 *
 *  用法：node prototype/control-state-audit.mjs
 */
import {readFileSync, readdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join, dirname, basename} from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const sheets = [
  join(root, 'src', 'v7-shell.html'),
  ...readdirSync(join(root, 'src', 'v7')).filter(name => name.endsWith('.css')).map(name => join(root, 'src', 'v7', name)),
];
const css = sheets.map(file => { try { return readFileSync(file, 'utf8') } catch { return '' } }).join('\n');
if (!css.trim()) {
  console.log('FAIL: 读不到任何样式产物 —— 门禁没有可检查的对象，不算通过。');
  process.exit(1);
}

/** 每个控件：四态各自"算数"的选择器形态（合并选择器里的任一项命中即算）。 */
const CONTROLS = [
  {
    name: '按钮（.btn）',
    hover: /(^|[,\s])\.btn[^{}]*:hover/,
    focus: /(^|[,\s])\.btn[^{}]*:focus-visible|(^|[,\s])button[^{}]*:focus-visible/,
    disabled: /(^|[,\s])\.btn[^{}]*:disabled|(^|[,\s])button[^{}]*:disabled/,
  },
  {
    // 输入框/下拉/文本域的"悬停"在 VI 里不要求视觉变化（克制：不靠悬停提示可点），
    // 所以它们只对 hover 放宽，聚焦与禁用照查。
    name: '输入框（input）',
    hover: /(^|[,\s])input[^{}]*:hover/,
    focus: /(^|[,\s])input[^{}]*:focus-visible/,
    disabled: /(^|[,\s])input[^{}]*:disabled/,
    hoverOptional: true,
  },
  {
    name: '下拉（select）',
    hover: /(^|[,\s])select[^{}]*:hover/,
    focus: /(^|[,\s])select[^{}]*:focus-visible/,
    disabled: /(^|[,\s])select[^{}]*:disabled/,
    hoverOptional: true,
  },
  {
    name: '文本域（textarea）',
    hover: /(^|[,\s])textarea[^{}]*:hover/,
    focus: /(^|[,\s])textarea[^{}]*:focus-visible/,
    disabled: /(^|[,\s])textarea[^{}]*:disabled/,
    hoverOptional: true,
  },
];

const problems = [];
for (const control of CONTROLS) {
  const missing = [];
  if (!control.hoverOptional && !control.hover.test(css)) missing.push('悬停');
  if (!control.focus.test(css)) missing.push('聚焦');
  if (!control.disabled.test(css)) missing.push('禁用');
  if (missing.length) problems.push(control.name + ' 缺 ' + missing.join(' / ') + ' 态');
}

// 光有"某个按钮"的态不够：这里再确认**通用**禁用态存在（否则新控件又会漏）。
if (!/(^|[,\s])(button|input|select|textarea):disabled/.test(css)) {
  problems.push('没有通用的控件禁用态（button/input/select/textarea:disabled）');
}

if (problems.length) {
  console.log('FAIL: 控件四态不齐（VI §13 门禁 5）：');
  for (const problem of problems) console.log('  · ' + problem);
  console.log('  改法：在 prototype/ 下承载该控件的样式文件里补上缺的那一态（.btn 的四态在 v7-visual.css）；');
  console.log('        禁用态要"看得出来 + 光标说明"，别只靠透明度。');
  process.exit(1);
}
console.log('PASS: 四态齐 — ' + CONTROLS.map(c => c.name).join('、') + '（悬停 / 聚焦 / 禁用），且通用禁用态存在。');
