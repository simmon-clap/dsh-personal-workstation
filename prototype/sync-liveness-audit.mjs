#!/usr/bin/env node
/**
 * 同步与常驻状态面门禁（S14 / S15 / S16）。
 *
 * 依据：宪章 v1.4 第二条（时时都靠谱）· 第七条（承诺不对称）
 *      · spec/17 C8 v1.1（同步与常驻必须有可读状态面）
 *      · spec/13 §10（判活靠记账，不靠探活）
 *
 * 为什么有这个脚本：2026-10-21 同步自 14:15 起停了 8 小时，
 * 日志里只有一句「对端不可达，跳过这次（不算失败）」，界面无任何显示。
 * 一句话同时掩盖了三种故障（对面关机 / 本机断网 / 本机定时任务没加载）。
 *
 * 判什么：
 *   S1  最后成功同步时间是否可读        —— 只报告，不判红（笔记本离线是常态）
 *   S2  失败不得被折成「不算失败」       —— 红
 *   S3  说「不可达」必须写明哪一侧/哪一跳/什么原因 —— 红
 *   S4  常驻节点心跳（beat）是否可读     —— 阻塞（功能未实现，不是违规）
 *
 * 退出码：0 全过；1 有红；2 有阻塞（前置未实现，接入 verify 前必须先解掉）。
 *
 * 用法：
 *   node prototype/sync-liveness-audit.mjs             # 跑真实日志与真实库
 *   node prototype/sync-liveness-audit.mjs --self-test # canary：4 个夹具必须 4/4 判对
 *   node prototype/sync-liveness-audit.mjs --log <path> --stamp <path> --db <path>
 */
import {readFileSync, existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {homedir} from 'node:os';
import {join, resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const DATA_ROOT = resolve(REPO, '..');

const argOf = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index > 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
};

/* ── 纯函数：只看一行日志，判断它有没有把失败说清楚 ────────────────────── */
const UNREACHABLE = /不可达|不可用|连不上|未连通|unreachable/i;
const DISMISSES = /不算失败|不报错|不报失败|忽略这次|不记录|跳过即可/;
const EXPLAINS = /网络|超时|进程|定时|未加载|断电|跳|一侧|原因|重试/;

/** 日志按 "──── 时间 ────" 切成一趟一趟的。
 *  判红只看**最后一次运行**：门禁管的是"现在的行为对不对"，
 *  历史违规照样统计出来（info），但不该让它永远红着 —— 永远红就是另一种假绿。 */
export function splitRuns(text) {
  return String(text ?? '').split(/\n(?=──── )/).map(block => block.trim()).filter(Boolean);
}

/**
 * @returns {Array<{level:'red'|'blocked', id:string, why:string}>}
 */
export function judgeLines(lines) {
  const findings = [];
  for (const raw of lines) {
    const line = String(raw ?? '').trim();
    if (!line) continue;
    const unreachable = UNREACHABLE.test(line);
    if (!unreachable) continue;
    if (DISMISSES.test(line)) {
      findings.push({
        level: 'red', id: 'S2',
        why: '把「不可达」折成了正常情况：' + line,
      });
      continue; // 同一行只报最重的一条
    }
    if (!EXPLAINS.test(line)) {
      findings.push({
        level: 'red', id: 'S3',
        why: '说了「不可达」但没写哪一侧/哪一跳/什么原因：' + line,
      });
    }
  }
  return findings;
}

/* ── canary：夹具必须 4/4 判对，否则门禁自己不可信 ────────────────────── */
const FIXTURES = [
  ['对端不可达，跳过这次（不算失败）', 'red', 'S2'],
  ['对端不可达', 'red', 'S3'],
  ['对端不可达（本机这一跳：ssh 超时 8s，已重试 3 次），跳过这次', 'ok'],
  ['PASS：两边数据一致。', 'ok'],
  ['本机→常驻节点 未连通（这一跳：ssh 连接超时 30s，已重试 3 次；对端 100.x.x.x）', 'ok'],
];

function selfTest() {
  let pass = 0;
  for (const [line, expected, id] of FIXTURES) {
    const found = judgeLines([line]);
    let ok;
    if (expected === 'ok') ok = found.length === 0;
    else ok = found.some(item => item.level === expected && item.id === id);
    if (!ok) {
      console.error('canary 失败：' + JSON.stringify({line, expected, id, found}));
    } else {
      pass += 1;
    }
  }
  console.log(`canary ${pass}/${FIXTURES.length} ${pass === FIXTURES.length ? 'PASS' : 'FAIL'}`);
  return pass === FIXTURES.length;
}

/* ── 真实检查 ─────────────────────────────────────────────────────────── */
const logPath = argOf('--log', join(homedir(), '.dsh', 'workstation-sync.log'));
const stampPath = argOf('--stamp', join(DATA_ROOT, 'workstation-data', 'workstation.sqlite.lastsync'));
const dbPath = argOf('--db', join(DATA_ROOT, 'workstation-data', 'workstation.sqlite'));

const results = [];
const add = (id, status, text) => results.push({id, status, text});

// S1：最后成功同步时间可读（只报告）
if (existsSync(stampPath)) {
  const stamp = Number(readFileSync(stampPath, 'utf8').trim());
  const hours = Number.isFinite(stamp) ? (Date.now() - stamp) / 3.6e6 : NaN;
  add('S1', 'info', Number.isFinite(hours)
    ? `最后成功同步：${hours.toFixed(1)} 小时前（笔记本离线是常态，只报告不判红）`
    : '最后成功同步时间读不懂');
} else {
  add('S1', 'info', '没有找到最后成功同步时间（' + stampPath + '）');
}

// S2 / S3：日志口径（只看最后一次运行；历史违规单独计数）
if (existsSync(logPath)) {
  const runs = splitRuns(readFileSync(logPath, 'utf8'));
  const latest = runs[runs.length - 1] ?? '';
  const findings = judgeLines(latest.split('\n'));
  if (!findings.length) {
    add('S2', 'pass', '最近一次运行没有把失败折成正常');
    add('S3', 'pass', '最近一次运行的「不可达」写明了原因或跳数');
  } else {
    for (const f of findings) add(f.id, f.level, f.why);
  }
  const window = runs.slice(-20);
  const historical = window.slice(0, -1).reduce((sum, block) => sum + judgeLines(block.split('\n')).length, 0);
  if (historical) add('S2', 'info', `窗口内更早的运行里还有 ${historical} 条旧写法（改脚本前留下的，不再据此判红）`);
} else {
  add('S2', 'blocked', '找不到同步日志：' + logPath);
}

// 最后成功同步距今多少分钟（用来区分"它停了"和"我看不到它"）。
const syncAgeMinutes = (() => {
 if (!existsSync(stampPath)) return null;
 const stamp = Number(readFileSync(stampPath, 'utf8').trim());
 if (!Number.isFinite(stamp)) return null;
 return (Date.now() - stamp) / 60000;
})();

// S4：常驻节点心跳。表在 = 能判；表里没有常驻的记录 = 还判不了（阻塞）；
// 有记录但太旧 = 真故障（红，这是宪章 v1.4 第七条唯一的"必须在线"承诺）。
const readBeat = () => {
  if (!existsSync(dbPath)) return {status: 'blocked', why: '找不到数据库：' + dbPath};
  let tables;
  try {
    tables = execFileSync('/usr/bin/sqlite3', [dbPath,
      "SELECT count(*) FROM sqlite_master WHERE type='table' AND name IN ('beat','resident_beat');"],
      {encoding: 'utf8', timeout: 8000}).trim();
  } catch (error) {
    return {status: 'blocked', why: 'sqlite3 读取失败：' + (error?.message ?? error)};
  }
  if (Number(tables) === 0) return {status: 'blocked', why: '心跳表还没有（beat 表要等插件带上 beat-store 重新加载后才会建）'};
  let latest;
  try {
    latest = execFileSync('/usr/bin/sqlite3', [dbPath,
      "SELECT COALESCE(MAX(at),'') FROM beat WHERE side='resident';"],
      {encoding: 'utf8', timeout: 8000}).trim();
  } catch (error) {
    return {status: 'blocked', why: '心跳表读不出来：' + (error?.message ?? error)};
  }
  if (!latest) return {status: 'blocked', why: '心跳表在，但常驻节点还没有过一条心跳记录'};
  const silent = (Date.now() - Date.parse(latest)) / 60000;
  if (!Number.isFinite(silent)) return {status: 'red', why: '最后一条心跳时间读不懂：' + latest};
  // 关键区分（2026-10-22 实测踩到）：**本机同步停了**时，看到的心跳必然是旧的 ——
  // 那不是"常驻节点停了"，而是"我看不到它"。这两种情况必须分开说，否则门禁会诬告 Mini。
  if (Number.isFinite(syncAgeMinutes) && syncAgeMinutes > 45) {
   return {status: 'blocked', why: `看不到常驻节点：本机同步已经停了 ${Math.round(syncAgeMinutes)} 分钟（最后一条心跳是 ${Math.round(silent)} 分钟前的副本）`};
  }
  if (silent > 45) return {status: 'red', why: `常驻节点已经 ${Math.round(silent)} 分钟没有心跳（承诺 15 分钟一次，超过 45 分钟算停）`};
  return {status: 'pass', why: `常驻节点最近一次心跳在 ${Math.round(silent)} 分钟前`};
};
const beat = readBeat();
add('S4', beat.status, beat.why);

/* ── 输出 ─────────────────────────────────────────────────────────────── */
if (process.argv.includes('--self-test')) {
  process.exit(selfTest() ? 0 : 1);
}

const order = {red: 0, blocked: 1, pass: 2, info: 3};
results.sort((a, b) => order[a.status] - order[b.status]);
for (const item of results) {
  console.log(`[${item.status.padEnd(7)}] ${item.id}  ${item.text}`);
}
const red = results.filter(item => item.status === 'red').length;
const blocked = results.filter(item => item.status === 'blocked').length;
console.log(`\n红 ${red} · 阻塞 ${blocked} · 过 ${results.filter(item => item.status === 'pass').length}`);
if (red) process.exit(1);
if (blocked) process.exit(2);
process.exit(0);
