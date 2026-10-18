#!/usr/bin/env node
/** 一条命令跑完**全部真实数据验收**：`npm run accept`。
 *
 *  为什么要有它：`npm run verify` 里的 35 道门禁全跑在**内存夹具**上 —— 它们能证明"UI 逻辑对"，
 *  证明不了"真实数据里发生过"。而宪章六条判据里有五条要的正是后者，于是散成了五个脚本：
 *
 *    real-data-check    判据 1 / 3 / 5（真实库副本；判据 1 的场景在副本上造出来跑）
 *    mobile-real-check  判据 2（真实库副本 + 真 390×844 浏览器，走完"看→判断→决定"并查落库）
 *    audio-seek-check   判据 3 的界面层（点依据 → 播放器 → 跳到锚点那一段）
 *    agent-swap-check   判据 4（两个 Agent / 两个适配器实例 / 另起进程读）
 *    live-acceptance    真机实例是不是这一版（**需要 DSH 正在运行**；没重启时会如实报 FAIL）
 *
 *  逐个跑、不互相掩盖：一个失败不影响其它继续跑，最后给一张总表。
 *  任何一项失败 → 整条命令非零退出（"没跑"与"没通过"都不算过）。
 */
import {execFileSync} from 'node:child_process';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const CHECKS = [
  {name: 'real-data-check', what: '判据 1 / 3 / 5（真实库副本）', needsInstance: false},
  {name: 'mobile-real-check', what: '判据 2（真实数据 + 390px 真浏览器）', needsInstance: false},
  {name: 'audio-seek-check', what: '判据 3 界面层（点依据 → 跳到那一段）', needsInstance: false},
  {name: 'agent-swap-check', what: '判据 4（换 Agent 事实与治理不重来）', needsInstance: false},
  {name: 'live-acceptance', what: '真机实例 = 已装包 = 仓库（**需要 DSH 在运行**）', needsInstance: true},
];

const only = process.argv.slice(2).filter(arg => !arg.startsWith('-'));
const selected = only.length ? CHECKS.filter(check => only.includes(check.name)) : CHECKS;
const results = [];

for (const check of selected) {
  console.log('\n' + '═'.repeat(64));
  console.log('▶ ' + check.name + ' —— ' + check.what);
  console.log('═'.repeat(64));
  const started = Date.now();
  let code = 0;
  let tail = '';
  try {
    const output = execFileSync(process.execPath, [join(here, check.name + '.mjs')], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']});
    tail = output;
  } catch (error) {
    code = error.status ?? 1;
    tail = String(error.stdout ?? '') + String(error.stderr ?? '');
  }
  process.stdout.write(tail);
  const verdictLine = tail.split('\n').filter(line => /^(PASS|FAIL)/.test(line.trim())).pop() ?? '（没有给出结论）';
  results.push({...check, code, verdict: verdictLine.trim().slice(0, 96), seconds: ((Date.now() - started) / 1000).toFixed(1)});
}

console.log('\n' + '═'.repeat(64));
console.log('总表');
console.log('═'.repeat(64));
for (const row of results) {
  const mark = row.code === 0 ? 'PASS' : 'FAIL';
  console.log(mark.padEnd(5) + row.name.padEnd(20) + (row.seconds + 's').padEnd(8) + row.verdict);
}
const failed = results.filter(row => row.code !== 0);
if (failed.length) {
  console.log('\nFAIL: ' + failed.length + '/' + results.length + ' 项没通过 —— ' + failed.map(row => row.name).join('、'));
  const instance = failed.filter(row => row.needsInstance);
  if (instance.length && instance.length === failed.length) {
    console.log('（live-acceptance 核对的是"**你正在用的那一份**是不是改过的这一版"：');
    console.log('  DSH 没在运行 → 先启动；刚改完代码 → 先 npm run install:local 再重启 DSH。）');
  }
  process.exit(1);
}
console.log('\nPASS: ' + results.length + ' 项真实数据验收全部通过（' + results.map(row => row.name).join(' · ') + '）。');
