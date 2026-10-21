#!/usr/bin/env node
/** 助理后台 · 真实入口验收（对着**正在运行**的工作台跑，不是夹具）。
 *
 *  为什么单独一支：`npm test` 能证明"逻辑对"，证明不了"你现在打开看到的是这一版"。
 *  这份脚本检查的是**产品承诺**：五个口有没有真的接住、收件箱有没有那两块、回一句话能不能收口。
 *
 *  它要的三件事都已具备才能跑：
 *    ① 运行中的实例已经加载了带 P1–P4 的包（库里有 intake / loop / opening 三张表）
 *    ② 有登录 Cookie（从本机 DSH Web 实例取，与 live-acceptance 同一套）
 *    ③ 时间窗：开口点检查在 09:30 / 21:00 之后的 30 分钟内才可能命中
 *
 *  用法：node prototype/assistant-acceptance.mjs [--json]
 *  退出码：0 全过；1 有失败；2 前置不满足（未加载/未登录）——2 不是失败，是"还验不了"。
 */
import {execFileSync} from 'node:child_process';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {existsSync} from 'node:fs';

const JSON_OUT = process.argv.includes('--json');
const DB = join(homedir(), 'Desktop', 'DSH', '飞书工作区', 'workstation-data', 'workstation.sqlite');

const results = [];
const add = (id, status, text, detail = null) => results.push({id, status, text, detail});

/** 前置①：库里有三张表，说明载入的包带上了 P1–P4。 */
function checkSchema() {
 if (!existsSync(DB)) return add('schema', 'blocked', '找不到数据库：' + DB);
 const db = new DatabaseSync(DB, {readOnly: true});
 try {
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name);
  const need = ['intake', 'loop', 'opening'];
  const missing = need.filter(name => !names.includes(name));
  if (missing.length) {
   add('schema', 'blocked', '运行中的实例还没加载 P1–P4（缺表：' + missing.join('、') + '）。先重启 DSH 让新包生效。');
   return false;
  }
  add('schema', 'pass', '三张表都在：收件本 / 着落本 / 开口记录');
  return true;
 } finally { db.close(); }
}

const read = (sql, ...params) => {
 const db = new DatabaseSync(DB, {readOnly: true});
 try { return db.prepare(sql).all(...params); } finally { db.close(); }
};

/** ② 收件本：五个口是不是真的都接过东西（看来源分布，不要求今天恰好都有）。 */
function checkEntries() {
 const rows = read('SELECT source, count(*) c FROM intake GROUP BY source ORDER BY c DESC');
 const seen = new Map(rows.map(row => [row.source, row.c]));
 const required = ['page', 'chat'];
 const missing = required.filter(source => !seen.get(source));
 if (missing.length) {
  add('entries', 'fail', '收件本里还没见过这些口：' + missing.join('、') + '（至少页面与对话要有）');
 } else {
  const detail = [...seen].map(([source, count]) => source + ' ' + count).join(' · ');
  add('entries', 'pass', '收件本按来源分布：' + detail);
 }
 const others = ['im', 'voice', 'calendar'].filter(source => seen.get(source));
 add('entries', 'info', others.length ? '另外见过：' + others.join('、') : '还没有飞书/语音/日历的记录（要真用过才有）');
}

/** ③ 收件箱两块：汇总数字与"等你一句话"能不能被读出来。 */
function checkInboxSurface() {
 const today = new Date().toISOString().slice(0, 10);
 const summary = read('SELECT state, count(*) c FROM intake WHERE substr(at,1,10)=? GROUP BY state', today);
 const waiting = read("SELECT count(*) c FROM intake WHERE state='needs_you'");
 add('inbox', summary.length ? 'pass' : 'info',
  '今天收入 ' + summary.reduce((sum, row) => sum + row.c, 0) + ' 条（' + (summary.map(row => row.state + ' ' + row.c).join(' · ') || '暂无') + '）');
 add('inbox', waiting[0].c ? 'info' : 'pass',
  waiting[0].c ? '有 ' + waiting[0].c + ' 条等你一句话（收件箱里应当能看到）' : '没有挂起等你回应的');
}

/** ④ 开口：有没有真的开过口；没开要能说清是"没到点"还是"没实现"。 */
function checkOpenings() {
 const rows = read('SELECT day, anchor, at, summary FROM opening ORDER BY rowid DESC LIMIT 5');
 if (!rows.length) {
  add('opening', 'info', '还没有开口记录：要么还没到 09:30/21:00，要么常驻节点没开（开口只在常驻节点发生）');
  return;
 }
 for (const row of rows) add('opening', 'pass', row.day + ' ' + row.anchor + '：' + (row.summary || '（空）'));
}

/** ⑤ 着落本：等待必须有期限（没有期限的就是永久悬案）。 */
function checkLoops() {
 const bad = read("SELECT count(*) c FROM loop WHERE state='waiting' AND (waiting_for IS NULL OR waiting_until IS NULL)");
 add('loops', bad[0].c === 0 ? 'pass' : 'fail', bad[0].c === 0 ? '没有"没有期限的等待"' : '有 ' + bad[0].c + ' 条在等却没有说等谁/等到什么时候');
 const total = read('SELECT state, count(*) c FROM loop GROUP BY state');
 if (total.length) add('loops', 'info', '着落分布：' + total.map(row => row.state + ' ' + row.c).join(' · '));
}

/** ⑥ 常驻节点心跳（宪章 v1.4 第七条）：有记录且不旧。 */
function checkBeat() {
 const rows = read("SELECT at FROM beat WHERE side='resident' ORDER BY seq DESC LIMIT 1");
 if (!rows.length) {
  add('beat', 'blocked', '还没有常驻节点心跳（Mini 没重启或没开 assistant.residentNode）');
  return;
 }
 const minutes = (Date.now() - Date.parse(rows[0].at)) / 60000;
 add('beat', minutes > 45 ? 'fail' : 'pass', '常驻节点最近一次心跳在 ' + Math.round(minutes) + ' 分钟前（超过 45 分钟算停）');
}

const ready = checkSchema();
if (ready) { checkEntries(); checkInboxSurface(); checkOpenings(); checkLoops(); checkBeat(); }

const report = {at: new Date().toISOString(), db: DB, ready, results};
if (JSON_OUT) console.log(JSON.stringify(report, null, 2));
else {
 console.log('助理后台 · 真实入口验收');
 console.log('库：' + DB);
 for (const item of results) console.log('[' + item.status.padEnd(7) + '] ' + item.id.padEnd(8) + item.text);
}
if (!ready) process.exit(2);
process.exit(results.some(item => item.status === 'fail') ? 1 : 0);
