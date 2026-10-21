#!/usr/bin/env node
/** 双端同步引擎（按 `spec/06-双端同步设计-v1.0.md` 实现）。
 *
 *  ## 为什么走 SQLite 直连而不是 HTTP
 *  两台机器各自跑一个完整 Host，mini 那边的 HTTP 要访问令牌（只在 App 内存里，不落盘）。
 *  而两边的库都是 SQLite 文件、都能直接读 —— **直连绕开认证，也就能自动化**。
 *  代价：必须在两端都停下写入时跑（见下面的"安全前提"）。
 *
 *  ## 同步范围（按设计 §3）
 *   同步：业务对象（entities 表）+ 材料文件（由调用方 rsync）
 *   不同步：会话记录、凭证、工作台配置（设计明确不跨端）
 *
 *  ## 冲突策略（用户 2026-10-15 拍板：以最新为准）
 *   判新旧：先比 `revision`（高者新），相同再比 `at`（ISO 时间串，可能为空）。
 *   **但"以最新为准"的失败模式是静默** —— 较旧的那次改动被丢掉而做的人不知道，
 *   那正是宪章第八条列在"明确不做"里的**无回执的假成功**。
 *   所以：每一次覆盖都写进 `audit` 表（事件名 `sync.override`，含被覆盖方与原因），
 *   并在报告里逐条列出。**不留痕就不许覆盖。**
 *
 *  ## 安全前提（不做就不许跑）
 *   ① 两端都不能有正在进行的写入（App 会持 WAL）。默认只读检查，`--apply` 才写。
 *   ② 写前先给两端各打一份快照（`--apply` 时自动做）。
 *   ③ 覆盖一律留痕；留不下痕就整体中止，不做部分同步。
 *
 *  用法：
 *    node sync-engine.mjs --local <db> --remote <user@host> --remote-db <path>          # 只看差异
 *    node sync-engine.mjs --local <db> --remote <user@host> --remote-db <path> --apply  # 真同步
 */
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {copyFileSync, existsSync, readFileSync as readFileSync2, writeFileSync, readdirSync} from 'node:fs';
import {dirname, basename, join as joinPath, join} from 'node:path';
import {planSync, planLogSync} from './sync-plan.mjs';

const args = process.argv.slice(2);
const opt = name => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : null; };
const flag = name => args.includes('--' + name);
// 参数可以省略：省略时读 `workstation-data/sync.json`（{local, remote, remoteDb, remoteRoot}）。
// 这样"真同步"就是一条命令：`npm run sync:check` / `npm run sync`，不用每次记一长串参数。
const syncConfig = (() => {
  const explicit = opt('local');
  if (explicit) return {};
  const candidates = [
    join(process.cwd(), '..', 'workstation-data', 'sync.json'),
    join(process.cwd(), 'workstation-data', 'sync.json'),
  ];
  for (const file of candidates) {
    try { if (existsSync(file)) return JSON.parse(readFileSync2(file, 'utf8')); } catch {}
  }
  return {};
})();
const LOCAL = opt('local') ?? syncConfig.local ?? null;
const REMOTE = opt('remote') ?? syncConfig.remote ?? null;
const REMOTE_DB = opt('remote-db') ?? syncConfig.remoteDb ?? null;
const REMOTE_ROOT = opt('remote-root') ?? syncConfig.remoteRoot ?? null;
const APPLY = flag('apply');
// `--check`：**只读核对两端是否真的一致**（不写任何东西）。任何一端有差异就非零退出。
// 这是"真同步"的机制：以后别问"同步过了吗"，跑这一条，它只会回答"这 N 张表逐条比对过，一致/不一致"。
const CHECK_ONLY = flag('check');
// `--remote-local <db>`：把"对端"当成一个本地文件。用途只有一个 —— **让这套同步逻辑能被真的测到**。
// 原来它跟 ssh 绑死，于是"删除会复活""覆盖只写单侧"两个数据丢失级 bug 一直没人发现。
const REMOTE_LOCAL = opt('remote-local');
if (REMOTE_LOCAL) {
  if (!LOCAL) { console.error('用法：node sync-engine.mjs --local <db> --remote-local <db> [--apply]'); process.exit(2); }
} else if (!LOCAL || !REMOTE || !REMOTE_DB) {
  console.error('用法：node sync-engine.mjs --local <db> --remote <user@host> --remote-db <path> [--apply]');
  console.error('  或：node sync-engine.mjs --local <db> --remote-local <db> [--apply]   （只用于测试）');
  process.exit(2);
}
const REMOTE_TARGET = REMOTE_LOCAL ?? REMOTE_DB;
if (!existsSync(LOCAL)) { console.error('本地库不存在：' + LOCAL); process.exit(2); }

const sqlite = (db, sql) => execFileSync('sqlite3', ['-json', db, sql], {encoding: 'utf8', maxBuffer: 1 << 28});
// **SQL 一律走标准输入，不拼进命令行**。
// 原因：execFileSync 的每个参数会被 ssh 拼成一条远程 shell 命令再解析一次，
// 数据里带 `"` 时会被 shell 吃掉引号 —— 实测报 `unrecognized token: "`。
// stdin 不经过 shell，多复杂的 JSON 都原样到达 sqlite3。
// **远程通道可替换**（`SYNC_SSH`）：默认就是 `ssh`。
// 唯一用途是让"远程读写这条路径"在没有第二台机器时也能被**真的测到** ——
// 测试里给一个"假 ssh"，它把 ssh 收到的命令在本地执行一遍：
// 引擎的远程分支（拼命令、走 stdin、解析 JSON、写回）原样跑，只是不跨网络。
// 换成真机时什么都不用改。
const SSH_BIN = process.env.SYNC_SSH || 'ssh';
// ConnectTimeout 只管"连上之前"；连上之后隧道断掉（Tailscale 中继切换）会**永远等**。
// 2026-10-21 实测：一次同步挂住 6 分钟不退出，SSH 早已 100% 丢包而进程还在等。
// 加 ServerAlive：45 秒没回应就自己断，交给上层重试。
const SSH_OPTS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3'];
const sshSqlite = (sql) => {
  if (REMOTE_LOCAL) { const t = sqlite(REMOTE_LOCAL, sql).trim(); return t ? JSON.parse(t) : []; }
  const out = execFileSync(SSH_BIN, [...SSH_OPTS, REMOTE, 'sqlite3', '-json', REMOTE_TARGET], {input: sql, encoding: 'utf8', maxBuffer: 1 << 28});
  return out.trim() ? JSON.parse(out) : [];
};
const sshWrite = (sql) => {
  if (REMOTE_LOCAL) { sqlite(REMOTE_LOCAL, sql); return; }
  execFileSync(SSH_BIN, [...SSH_OPTS, REMOTE, 'sqlite3', REMOTE_TARGET], {input: sql, encoding: 'utf8', maxBuffer: 1 << 28});
};
const rows = (db, sql) => { const t = sqlite(db, sql).trim(); return t ? JSON.parse(t) : []; };
/** 表存在才查 —— 精简库/旧版本库里可能还没有这张表。 */
const tableExists = (db, table, viaSqlite) => {
  const sql = `select name from sqlite_master where type='table' and name='${table}';`;
  try { return viaSqlite(sql).length > 0; } catch { return false; }
};

/** 新旧判据：revision 优先，相同看 at。返回 >0 表示 a 比 b 新。 */
function newer(a, b) {
  if (a.revision !== b.revision) return a.revision - b.revision;
  const ta = a.at || '', tb = b.at || '';
  if (ta === tb) return 0;
  return ta > tb ? 1 : -1;
}

console.log('=== 双端同步 ===');
console.log('本地：' + LOCAL);
console.log('对端：' + (REMOTE_LOCAL ? '（本地文件，仅测试）' : REMOTE) + ' ' + REMOTE_TARGET);

const local = rows(LOCAL, 'select workspace,id,kind,revision,data,archived,author,at from entities;');
const remote = sshSqlite('select workspace,id,kind,revision,data,archived,author,at from entities;');
// 墓碑（宪章 v1.2）：删除的记录。没有它，"这边删了、那边还在"会被当成"对端新增"复活。
const hasLocalTombs = tableExists(LOCAL, 'tombstones', sql => rows(LOCAL, sql));
const hasRemoteTombs = tableExists(REMOTE_TARGET, 'tombstones', sql => sshSqlite(sql));
const localTombs = hasLocalTombs ? rows(LOCAL, 'select workspace,id,kind,revision,at from tombstones;') : [];
const remoteTombs = hasRemoteTombs ? sshSqlite('select workspace,id,kind,revision,at from tombstones;') : [];
console.log(`本地对象 ${local.length} 个 · 对端对象 ${remote.length} 个 · 墓碑 本地 ${localTombs.length} / 对端 ${remoteTombs.length}`);

// **墓碑缺失时不许自动同步**：分不清"这边删掉的"和"那边新增的"，
// 这时候拉过来会复活删除、推过去会误删对端 —— 两种都可能丢数据。宁可不做。
const tombsReady = hasLocalTombs && hasRemoteTombs;
if (!tombsReady && APPLY) {
  console.log('\nFAIL：还不能自动同步 —— ' + (hasLocalTombs ? '对端' : '本地') + '库还没有 tombstones 表。');
  console.log('  说明那一端的运行实例还是**不写墓碑的旧版本**。在两端都重启到新版本之前，');
  console.log('  同步无法区分"这边删了"和"那边新增的"，拉过来会让删掉的东西复活、推过去会误删对端。');
  console.log('  改法：两端各重启一次 DSH，再跑本命令。');
  process.exit(4);
}
if (!tombsReady) console.log('注意：' + (hasLocalTombs ? '对端' : '本地') + '库还没有 tombstones 表 —— 下面的删除判定不可信，仅作参考（不允许 --apply）。');

// **表在 ≠ 运行中的版本会写墓碑**：表可能是别的工具建出来的（实测就发生过 —— 我的脚本建了表，
// 而界面那一端还是旧版本、删除时不写墓碑）。决定性证据只能来自数据本身：
// 跟最近一次快照比，**少了对象却没有对应墓碑** = 删除没留痕 = 这一端不能参与自动同步。
function deletionsWithoutTombstone(db) {
  try {
    const dir = dirname(db), prefix = basename(db) + '.syncbak-';
    const snaps = readdirSync(dir).filter(name => name.startsWith(prefix)).sort();
    if (!snaps.length) return null;                       // 没有快照可比 → 无法判定
    const past = new Set(rows(joinPath(dir, snaps[snaps.length - 1]), 'select workspace,id from entities;')
      .map(r => r.workspace + '\u0000' + r.id));
    const now = new Set(rows(db, 'select workspace,id from entities;').map(r => r.workspace + '\u0000' + r.id));
    const tombs = new Set((hasLocalTombs ? rows(db, 'select workspace,id from tombstones;') : []).map(r => r.workspace + '\u0000' + r.id));
    const vanished = [...past].filter(key => !now.has(key));
    return vanished.filter(key => !tombs.has(key));
  } catch { return null }
}
const localUnrecorded = deletionsWithoutTombstone(LOCAL);
if (localUnrecorded && localUnrecorded.length) {
  console.log('\nFAIL：本地有 ' + localUnrecorded.length + ' 个对象在最近一次快照之后消失了，却没有墓碑。');
  console.log('  这说明**正在运行的那一端还是旧版本**（删除不留墓碑）—— 表存在不代表它会写。');
  console.log('  改法：重启 DSH 到新版本，再做一次删除；然后重新跑本命令。');
  if (APPLY) process.exit(4);
}

const plan = planSync({local, remote, localTombstones: localTombs, remoteTombstones: remoteTombs});
const onlyRemote = plan.upsertsLocal.filter(r => !plan.overrides.some(o => o.id === r.id));
const onlyLocal = plan.upsertsRemote.filter(r => !plan.overrides.some(o => o.id === r.id));
const conflicts = plan.overrides;

console.log(`\n对端新增（要拉过来）  ${onlyRemote.length}`);
for (const r of onlyRemote.slice(0, 8)) console.log(`  + ${r.kind} ${r.id} (rev ${r.revision})`);
if (onlyRemote.length > 8) console.log(`  …还有 ${onlyRemote.length - 8} 个`);
console.log(`本地新增（要推过去）  ${onlyLocal.length}`);
for (const r of onlyLocal.slice(0, 8)) console.log(`  → ${r.kind} ${r.id} (rev ${r.revision})`);
if (onlyLocal.length > 8) console.log(`  …还有 ${onlyLocal.length - 8} 个`);
console.log(`两边一致            ${local.filter(r => remote.some(x => x.workspace === r.workspace && x.id === r.id && x.revision === r.revision)).length}`);
console.log(`两边都改过（冲突）   ${conflicts.length}`);
for (const c of conflicts) {
  console.log(`  ! ${c.kind} ${c.id} —— 取${c.winner === 'local' ? '本地' : '对端'}（${c.reason}：${c.loserRevision} → ${c.winnerRevision}）`);
}
console.log(`删除要生效           本地删 ${plan.deletesLocal.length} · 对端删 ${plan.deletesRemote.length}`);
for (const d of plan.deletesLocal.slice(0, 5)) console.log(`  ✕ 本地删除 ${d.kind} ${d.id}（对端墓碑较新）`);
for (const d of plan.deletesRemote.slice(0, 5)) console.log(`  ✕ 对端删除 ${d.kind} ${d.id}（本地墓碑较新）`);
if (plan.resurrected.length) {
  console.log(`删除后被改过（按新证据保留）  ${plan.resurrected.length}`);
  for (const r of plan.resurrected.slice(0, 5)) console.log(`  ↺ ${r.kind} ${r.id} —— ${r.reason}`);
}

// ── 只读核对（--check）────────────────────────────────────────────────
if (CHECK_ONLY) {
  const names = ['entities', 'tombstones', 'batches'];
  let bad = 0;
  console.log('\n=== 真同步核对（只读，不写任何东西）===');
  for (const name of names) {
    const localHas = tableExists(LOCAL, name, sql => rows(LOCAL, sql));
    const remoteHas = tableExists(REMOTE_TARGET, name, sql => sshSqlite(sql));
    if (!localHas || !remoteHas) { console.log(name + '：' + (localHas ? '' : '本地缺表 ') + (remoteHas ? '' : '对端缺表 ') + '（不一致）'); bad += 1; continue; }
    const where = name === 'batches' ? " where status in ('committed','cancelled')" : '';
    const cols = name === 'entities' ? 'workspace,id,kind,revision' : name === 'tombstones' ? 'workspace,id,kind,revision' : 'workspace,id,revision,status';
    const fingerprint = list => createHash('sha256').update(list.map(row => cols.split(',').map(col => String(row[col])).join('\u0000')).sort().join('\n')).digest('hex').slice(0, 16);
    const localList = rows(LOCAL, 'select ' + cols + ' from ' + name + where + ';');
    const remoteList = sshSqlite('select ' + cols + ' from ' + name + where + ';');
    const same = fingerprint(localList) === fingerprint(remoteList);
    console.log((same ? 'PASS ' : 'FAIL ') + name.padEnd(12) + '本地 ' + String(localList.length).padStart(4) + ' · 对端 ' + String(remoteList.length).padStart(4) + ' · 指纹 ' + fingerprint(localList) + (same ? '' : ' vs ' + fingerprint(remoteList)));
    if (!same) bad += 1;
  }
  console.log(bad === 0 ? '\nPASS：两端逐表一致（真同步）。' : '\nFAIL：有 ' + bad + ' 张表不一致 —— 这不是"同步过了"。');
  process.exit(bad === 0 ? 0 : 1);
}

if (!APPLY) {
  console.log('\n（只读检查。加 --apply 才真同步）');
  process.exit(0);
}

// 安全前提③：**长离线先警告**（设计 §4）。
// 离线太久再同步，一次会覆盖掉很多天里别人做的改动 —— 那正是最难发现、后果最大的一类丢失。
// 所以：间隔超过阈值**且**这次会覆盖东西时，不默默执行，要人明确加 --force。
const STALE_HOURS = 24;
const stampFile = LOCAL + '.lastsync';
let lastSync = 0;
try { lastSync = Number(readFileSync2(stampFile)) || 0; } catch {}
const hours = lastSync ? (Date.now() - lastSync) / 3.6e6 : Infinity;
const willOverride = conflicts.length;
if (willOverride && hours > STALE_HOURS && !flag('force')) {
  console.log(`\n⚠ 距上次同步 ${lastSync ? hours.toFixed(1) + ' 小时' : '从未同步过'}（阈值 ${STALE_HOURS} 小时），`);
  console.log(`  而这次会**覆盖 ${willOverride} 个两边都改过的对象**。`);
  console.log('  离线期间别人做的改动会被盖掉，所以不自动执行。');
  console.log('  看完上面那份冲突清单后，确认没问题再加 --force 重跑。');
  process.exit(3);
}

// ── 真同步 ──────────────────────────────────────────────────────────────
// 安全前提②：写前给两端各打一份快照。出事能回退。
const stamp = new Date().toISOString().replace(/[:.]/g, '-');

/** **WAL 安全的快照**（2026-10-16 修，这是个真问题）。
 *
 *  原来这里是 `copyFileSync(库, 快照)` —— 只拷主文件。而库跑在 **WAL 模式**，
 *  且**插件进程一直开着它**：最近的提交、甚至建表本身都还可能只在 `-wal` 里没落盘。
 *  实测（进程开着时）：这样拷出来的"备份"里 **连 entities 表都没有** —— 它不是"旧一点"，
 *  而是**根本不是一份能用的备份**。磁盘上已经躺着 8 份这样的 `.syncbak-*`。
 *
 *  对外说法是"出事能回退"，实际回退不了 —— 属于最不该有的那种假承诺。
 *  修法：用 sqlite3 的 `.backup`（在线备份，天生处理 WAL）；拿不到 sqlite3 就**如实报错**，
 *  不退回"拷主文件"那种看起来成功、实际没用的做法。
 */
function snapshot(dbPath,snapPath,{remote=null}={}){
 const run=(cmd,args)=>{try{return {ok:true,out:execFileSync(cmd,args,{encoding:'utf8',stdio:['ignore','pipe','pipe']})}}catch(error){return {ok:false,out:String(error.stdout??'')+String(error.stderr??'')+String(error.message??'')}}};
 if(remote){
  const result=run(SSH_BIN,[...SSH_OPTS,remote,`sqlite3 ${JSON.stringify(dbPath)} ".backup ${snapPath}"`]);
  if(!result.ok)throw new Error('对端快照失败（不用"拷主文件"代替）：'+result.out.trim().slice(0,200));
  return;
 }
 const result=run('sqlite3',[dbPath,'.backup '+snapPath]);
 if(!result.ok){
  const alt=run('/usr/bin/sqlite3',[dbPath,'.backup '+snapPath]);
  if(!alt.ok)throw new Error('快照失败：需要 sqlite3 命令行做在线备份（拷主文件在 WAL 下会得到一份没用的备份）。'+result.out.trim().slice(0,160));
 }
 // 验一下：快照必须真的能打开、且表在
 const check=run('sqlite3',[snapPath,'select count(*) from entities;']);
 if(!check.ok||!check.out.trim())throw new Error('快照校验失败：'+snapPath+' 打不开或不完整，已中止同步（宁可不做）');
}

const localSnap = LOCAL + '.syncbak-' + stamp;
snapshot(LOCAL,localSnap);
console.log('\n本地快照：' + localSnap + '（sqlite3 在线备份，含 WAL 里的最近提交）');
const remoteSnap = REMOTE_TARGET + '.syncbak-' + stamp;
snapshot(REMOTE_TARGET,remoteSnap,{remote:REMOTE_LOCAL?null:REMOTE});
console.log('对端快照：' + remoteSnap);

const esc = v => v === null || v === undefined ? 'NULL' : "'" + String(v).replace(/'/g, "''") + "'";
const upsert = r => `insert into entities(workspace,id,kind,revision,data,archived,author,at) values(` +
  [r.workspace, r.id, r.kind, r.revision, r.data, r.archived, r.author, r.at].map(esc).join(',') +
  `) on conflict(workspace,id) do update set kind=excluded.kind,revision=excluded.revision,data=excluded.data,archived=excluded.archived,author=excluded.author,at=excluded.at;`;

/** 覆盖留痕：宪章第八条 —— 不许静默丢掉别人的改动。 */
const auditRow = (workspace, actor, body, event = 'sync.override') =>
  `insert into audit(workspace,actor,event,body,at) values(${esc(workspace)},'sync-engine',${esc(event)},` +
  `${esc(JSON.stringify(body))},${esc(new Date().toISOString())});`;

// 覆盖留痕：宪章 v1.2 —— **被覆盖的那一次必须在两端都留痕**。
// 原来只写"被覆盖的那一侧"，于是本机查不到"我覆盖过谁"（实测 A 侧 0 条 / B 侧 1 条）。
const overrideRows = (side) => plan.overrides.map(o => auditRow(o.workspace, side === 'local' ? 'sync-engine@local' : 'sync-engine@remote', {
  id: o.id, kind: o.kind, winner: o.winner, loserRevision: o.loserRevision, winnerRevision: o.winnerRevision, reason: o.reason, side,
}));

// **复原留痕**（2026-10-16 补）：一端删了、另一端后来改得更多（版本号超过墓碑）时，
// 引擎会"按新证据保留"，也就是**让删掉的东西回来**。原来这一步**两端一条留痕都不写** ——
// 用户会看到东西自己回来了，却查不到为什么。删除被撤销比改动被覆盖更该留痕。
// （实测：同步后 `select * from audit where event like '%resurrect%'` 两边都是 0 条。）
const resurrectRows = (side) => (plan.resurrected ?? []).map(r => auditRow(r.workspace, side === 'local' ? 'sync-engine@local' : 'sync-engine@remote', {
  id: r.id, kind: r.kind, decision: 'kept-after-delete', tombstoneRevision: r.tombstoneRevision ?? null,
  winnerRevision: r.revision ?? null, reason: r.reason, side,
}, 'sync.resurrect'));
const upsertTomb = t => `insert into tombstones(workspace,id,kind,revision,at) values(` +
  [t.workspace, t.id, t.kind, t.revision, t.at].map(esc).join(',') +
  `) on conflict(workspace,id) do update set kind=excluded.kind,revision=excluded.revision,at=excluded.at;`;
const dropTomb = t => `delete from tombstones where workspace=${esc(t.workspace)} and id=${esc(t.id)};`;
const delEnt = d => `delete from entities where workspace=${esc(d.workspace)} and id=${esc(d.id)};`;

const toLocal = plan.upsertsLocal;
const toRemote = plan.upsertsRemote;

if (toLocal.length || plan.deletesLocal.length || plan.tombstonesLocal.length || plan.tombstonesDrop.length || plan.overrides.length || (plan.resurrected ?? []).length) {
  const stmts = [
    ...toLocal.map(upsert),
    ...plan.deletesLocal.map(delEnt),
    ...plan.tombstonesLocal.map(upsertTomb),
    ...plan.tombstonesDrop.map(dropTomb),
    ...overrideRows('local'),
    ...resurrectRows('local'),
  ];
  sqlite(LOCAL, 'begin immediate;\n' + stmts.join('\n') + '\ncommit;');
  console.log(`\n拉到本地：${toLocal.length} 个 · 删除 ${plan.deletesLocal.length} 个 · 墓碑 ${plan.tombstonesLocal.length} 条 · 覆盖留痕 ${plan.overrides.length} 条 · 复原留痕 ${(plan.resurrected ?? []).length} 条`);
}
if (toRemote.length || plan.deletesRemote.length || plan.tombstonesRemote.length || plan.tombstonesDrop.length || plan.overrides.length || (plan.resurrected ?? []).length) {
  const stmts = [
    ...toRemote.map(upsert),
    ...plan.deletesRemote.map(delEnt),
    ...plan.tombstonesRemote.map(upsertTomb),
    ...plan.tombstonesDrop.map(dropTomb),
    ...overrideRows('remote'),
    ...resurrectRows('remote'),
  ];
  sshWrite('begin immediate;\n' + stmts.join('\n') + '\ncommit;');
  console.log(`推到对端：${toRemote.length} 个 · 删除 ${plan.deletesRemote.length} 个 · 墓碑 ${plan.tombstonesRemote.length} 条 · 覆盖留痕 ${plan.overrides.length} 条 · 复原留痕 ${(plan.resurrected ?? []).length} 条`);
}

// ── 状态与留痕对象（宪章 v1.2：它们也要跟着走）────────────────────────────────
// 心跳留痕 / 出声反馈是"它做过什么"的证据，只增不改 → 按 id 取并集即可。
// 不同步的话，两台机器的"上次成功时间""连续失败次数"永远对不上。
const LOG_TABLES = [
  {table: 'heartbeat_runs', cols: ['workspace', 'id', 'startedAt', 'outcome', 'body']},
  {table: 'speak_feedback', cols: ['workspace', 'id', 'at', 'kind', 'body']},
  // **决定历史**（2026-10-16 补）：`batches` 是"你决定过什么"的记录。
  // 实测：新设备同步完拿到 31 个对象，但 batches=0 —— **状态过去了，历史一点没过去**，
  // 在另一台机器上看不到自己做过哪些决定。
  // 只同步**已定案**的（committed / cancelled），**草稿不同步**：
  // 草稿是"还没决定的下一步"，属于设备本地的未决工作，两边都拉过去会出现同一件事被决定两次。
  // 已定案的记录只增不改，按 id 取并集、按 revision 取新的。
  {table: 'batches', cols: ['workspace', 'id', 'revision', 'status', 'body'],
   where: "where status in ('committed','cancelled')",
   upsert: 'on conflict(workspace,id) do update set revision=excluded.revision,status=excluded.status,body=excluded.body where excluded.revision>batches.revision'},
];
for (const {table, cols, where = '', upsert = ''} of LOG_TABLES) {
  // 表可能还不存在（精简的库/测试库只有业务表）—— 那就没有要同步的留痕，安静跳过。
  const existsSql = "select name from sqlite_master where type='table' and name=" + esc(table) + ";";
  let localHas = false, remoteHas = false;
  try { localHas = rows(LOCAL, existsSql).length > 0; } catch {}
  try { remoteHas = sshSqlite(existsSql).length > 0; } catch {}
  if (!localHas || !remoteHas) continue;
  const select = 'select ' + cols.join(',') + ' from ' + table + ' ' + where + ';';
  const localRows = rows(LOCAL, select);
  const remoteRows = sshSqlite(select);
  const {toLocal: lv, toRemote: rv} = planLogSync(localRows, remoteRows);
  const insert = (row) => 'insert into ' + table + '(' + cols.join(',') + ') values(' + cols.map(c => esc(row[c])).join(',') + ') ' + (upsert || 'on conflict do nothing') + ';';
  if (lv.length) sqlite(LOCAL, 'begin immediate;\n' + lv.map(insert).join('\n') + '\ncommit;');
  if (rv.length) sshWrite('begin immediate;\n' + rv.map(insert).join('\n') + '\ncommit;');
  console.log(`${table}：拉到本地 ${lv.length} 条 · 推到对端 ${rv.length} 条`);
}

// ── 材料文件同步（目标要求"业务对象 + 材料文件"两端都要）─────────────────────
// 对象同步完了不算完：资料记录指向的是**文件路径**，文件不在那边，工作台照样打不开。
// 用 rsync 双向：先拉后推（`--update` 保证不会用旧文件盖新文件）。
const FILES = flag('files');
const LOCAL_ROOT = opt('local-root');   // REMOTE_ROOT 已在上面（可来自 sync.json）
if (FILES) {
  if (!LOCAL_ROOT || !REMOTE_ROOT) { console.error('--files 需要同时给 --local-root 与 --remote-root'); process.exit(2); }
  // 代码**不走文件同步**（2026-10-21 实测事故）：`workstation/` 是 git 仓库，两端必须从同一个 commit
  // 出发；用 `rsync --update` 搬代码只会按文件 mtime 互相覆盖，长出两套不一致的树
  // （当时 Mini 的 HEAD 在笔记本上根本不存在，两边各有一版画布）。代码只走 git。
  const rsyncArgs = ['-a', '--update', '--exclude', '.DS_Store', '--exclude', 'workstation-data', '--exclude', 'workstation', '--exclude', '.git'];
  const runRsync = (from, to) => execFileSync('rsync', [...rsyncArgs, from, to], {encoding: 'utf8', maxBuffer: 1 << 28});
  const remoteSpec = REMOTE + ':' + REMOTE_ROOT.replace(/ /g, '\\ ');
  console.log('\n=== 材料文件 ===');
  runRsync(remoteSpec + '/', LOCAL_ROOT + '/');            // 拉：对端有的
  runRsync(LOCAL_ROOT + '/', remoteSpec + '/');            // 推：本地有的
  // 校验：比对两边的**相对路径 + 大小**。
  // 前一版把前缀剥离交给 sed，而 root 里带引号和斜杠，剥不掉 → 两边全部"对不上"（5190/5190 全假报）。
  // 改成在 Node 里剥：先取 size\t绝对路径，再砍掉根本身。
  const listing = (root, viaSsh) => {
    const cmd = `find ${JSON.stringify(root)} -type f -not -path '*/.git/*' -not -path '*/workstation-data/*' -not -path '*/workstation/*' -not -name 'workstation-data' -not -name '.DS_Store' -not -name '*.syncbak-*' -exec stat -f '%z\t%N' {} + 2>/dev/null`;
    const out = viaSsh
      ? execFileSync('ssh', [...SSH_OPTS, REMOTE, cmd], {encoding: 'utf8', maxBuffer: 1 << 28})
      : execFileSync('bash', ['-c', cmd], {encoding: 'utf8', maxBuffer: 1 << 28});
    const map = new Map();
    for (const line of out.trim().split('\n')) {
      if (!line) continue;
      const tab = line.indexOf('\t');
      if (tab < 0) continue;
      const size = line.slice(0, tab);
      let path = line.slice(tab + 1);
      if (path.startsWith(root + '/')) path = path.slice(root.length + 1);
      map.set(path, size);
    }
    return map;
  };
  const localFiles = listing(LOCAL_ROOT, false);
  const remoteFiles = listing(REMOTE_ROOT, true);
  const missingRemote = [...localFiles].filter(([p, size]) => remoteFiles.get(p) !== size);
  const missingLocal = [...remoteFiles].filter(([p, size]) => localFiles.get(p) !== size);
  console.log(`本地文件 ${localFiles.size} 个 · 对端 ${remoteFiles.size} 个`);
  for (const [p] of missingRemote.slice(0, 5)) console.log('  对端缺/不一致：' + p);
  for (const [p] of missingLocal.slice(0, 5)) console.log('  本地缺/不一致：' + p);
  if (missingRemote.length || missingLocal.length) {
    console.log(`FAIL：文件不一致（对端缺 ${missingRemote.length} · 本地缺 ${missingLocal.length}）`);
    process.exit(1);
  }
  console.log('PASS：两边文件清单与大小一致。');
}

// 校验：同步后两边必须逐条一致
const key = r => r.workspace + '\u0000' + r.id;
const afterLocal = new Map(rows(LOCAL, 'select workspace,id,kind,revision,data from entities;').map(r => [key(r), r]));
const afterRemote = new Map(sshSqlite('select workspace,id,kind,revision,data from entities;').map(r => [key(r), r]));
let diff = 0;
for (const [k, r] of afterLocal) {
  const o = afterRemote.get(k);
  if (!o || o.revision !== r.revision || o.data !== r.data) { diff++; if (diff <= 5) console.log('  仍不一致：' + r.id); }
}
for (const k of afterRemote.keys()) if (!afterLocal.has(k)) { diff++; if (diff <= 5) console.log('  对端多出：' + k.split('\u0000')[1]); }
console.log(`\n校验：两边各 ${afterLocal.size} / ${afterRemote.size} 个对象，不一致 ${diff} 个`);
// **墓碑与决定历史也要逐条比**（2026-10-17 补）：只比 entities 会漏掉
// "对象一致但墓碑/决定记录没同步过去"——那不算真同步。
const fp = (list, cols) => createHash('sha256').update(list.map(row => cols.map(col => String(row[col])).join('\u0000')).sort().join('\n')).digest('hex').slice(0, 16);
for (const [name, cols, where] of [
  ['tombstones', ['workspace', 'id', 'kind', 'revision'], ''],
  ['batches', ['workspace', 'id', 'revision', 'status'], " where status in ('committed','cancelled')"],
]) {
  const localHas = tableExists(LOCAL, name, sql => rows(LOCAL, sql));
  const remoteHas = tableExists(REMOTE_TARGET, name, sql => sshSqlite(sql));
  if (!localHas || !remoteHas) continue;
  const select = 'select ' + cols.join(',') + ' from ' + name + where + ';';
  const localFp = fp(rows(LOCAL, select), cols);
  const remoteFp = fp(sshSqlite(select), cols);
  const same = localFp === remoteFp;
  console.log((same ? 'PASS ' : 'FAIL ') + name + ' 指纹 ' + localFp + (same ? '' : ' vs ' + remoteFp));
  if (!same) diff += 1;
}
if (diff === 0) { try { writeFileSync(stampFile, String(Date.now())); } catch {} }
console.log(diff === 0 ? 'PASS：两边数据一致。' : 'FAIL：仍有差异，见上。');
process.exit(diff === 0 ? 0 : 1);
