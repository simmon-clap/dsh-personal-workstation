/** 冻结原型转换检查（门禁 1/2/3 的收尾预案，**默认只干跑、不写字**）。
 *
 *  背景：`src/v7-shell.html` 由 `build-v7.mjs` 直接读**冻结原型** `工作台-视觉原型-v7.html` 生成，
 *  原型里的颜色/间距/字号都是内联写死的 —— 这是四项红门禁（1 色值 / 2 间距 / 3 字号 / 9 !important）的共同根因。
 *
 *  这个脚本回答"方案 A 到底要改什么、会不会改坏"：
 *    · 色值：**只在值完全等于调色板 token 时**才换写成 var(--ws-*) —— 同值不同写法，渲染不变；
 *    · 间距/字号：只报出"能唯一映射"的数量，**有歧义的（如 10px 在 8 与 12 之间）不擅自取整**，
 *      单独列出来给用户决定；
 *    · 默认 dry-run：打印计划，**一个字节都不写**。加 `--apply` 才真正改（需用户点头后执行）。
 *
 *  用法：node prototype/prototype-conversion-check.mjs [--apply]
 */
import {readFileSync, writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join, dirname, resolve} from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const workspace = resolve(root, '..');
const target = join(root, 'prototype', 'frozen', 'workbench-v7.html');

const tokens = JSON.parse(readFileSync(join(root, 'design-system', 'tokens.json'), 'utf8'));
const registry = JSON.parse(readFileSync(join(root, 'test', 'fixtures', 'registry.json'), 'utf8'));
const apply = process.argv.includes('--apply');

// 色值：值 → 变量名。只做**同值**替换，所以不需要判断，也不可能改坏渲染。
const palette = new Map(Object.entries(tokens.color).map(([name, value]) => [String(value).toUpperCase(), 'var(--ws-' + name + ')']));
// 间距与字号：标尺（唯一），标尺外的值需要人来定"落到哪一档"。
const spaceScale = registry.spacingScale.map(Number);
const typeScale = registry.typeScale.map(Number);

let source = readFileSync(target, 'utf8');
const before = source;

let colours = 0, coloursUnmapped = new Map();
source = source.replace(/#[0-9a-fA-F]{6}\b/g, hex => {
  const hit = palette.get(hex.toUpperCase());
  if (hit) { colours += 1; return hit; }
  coloursUnmapped.set(hex.toLowerCase(), (coloursUnmapped.get(hex.toLowerCase()) ?? 0) + 1);
  return hex;
});

// 间距：只统计"标尺外"的，并把有歧义的（正好落在两档中间）单独列出。
const ambiguous = new Map(), clearCut = new Map();
for (const match of source.matchAll(/\b(padding|margin|gap)(?:-[a-z]+)?\s*:\s*([^;{}\n]+)/g)) {
  for (const px of match[2].matchAll(/(\d+(?:\.\d+)?)px/g)) {
    const value = Number(px[1]);
    if (spaceScale.includes(value)) continue;
    const sorted = [...spaceScale].sort((a, b) => Math.abs(a - value) - Math.abs(b - value));
    const nearest = sorted[0], second = sorted[1];
    const bucket = Math.abs(nearest - value) === Math.abs(second - value) ? ambiguous : clearCut;
    bucket.set(value, (bucket.get(value) ?? 0) + 1);
  }
}

const offType = new Map();
for (const match of source.matchAll(/font-size\s*:\s*(\d+(?:\.\d+)?)px/g)) {
  const value = Number(match[1]);
  if (!typeScale.includes(value)) offType.set(value, (offType.get(value) ?? 0) + 1);
}

const lines = [];
lines.push('冻结原型：' + target);
lines.push('');
lines.push('① 色值（同值换写成变量，渲染不变）');
lines.push('   可换写：' + colours + ' 处');
lines.push('   调色板外的色值（需要新增 token 或改用 color-mix，不能擅自替换）：' + [...coloursUnmapped.values()].reduce((a, b) => a + b, 0) + ' 处');
for (const [hex, count] of [...coloursUnmapped].sort((a, b) => b[1] - a[1]).slice(0, 10)) lines.push('     ' + hex + ' ×' + count);
lines.push('');
lines.push('② 间距（标尺外）');
const totalSpace = [...clearCut.values(), ...ambiguous.values()].reduce((a, b) => a + b, 0);
lines.push('   标尺外共 ' + totalSpace + ' 处；其中**能唯一映射** ' + [...clearCut.values()].reduce((a, b) => a + b, 0) + ' 处，**正落在两档中间、需要你定** ' + [...ambiguous.values()].reduce((a, b) => a + b, 0) + ' 处');
lines.push('   有歧义的值：' + [...ambiguous.keys()].sort((a, b) => a - b).join(' / ') || '   有歧义的值：无');
lines.push('');
lines.push('③ 字号（字阶外）');
lines.push('   共 ' + [...offType.values()].reduce((a, b) => a + b, 0) + ' 处，取值：' + [...offType.keys()].sort((a, b) => a - b).join(' / '));
lines.push('');
lines.push(apply ? '已写入（--apply）' : '干跑：**没有写入任何内容**。确认后再加 --apply。');

console.log(lines.join('\n'));
if (apply) writeFileSync(target, source, 'utf8');
else if (source !== before) console.log('\n（干跑结果与原文不同 ' + (source.length - before.length) + ' 字节 —— 这是换写后的长度差，不是内容差）');
