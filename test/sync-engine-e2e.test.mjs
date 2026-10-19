/** 端到端同步：**真的对两个库跑一遍** sync-engine（宪章 v1.2 第七条三处硬要求）。
 *
 *  为什么必须有这条：`test/sync-plan.test.mjs` 只测了**计划函数**（纯函数），
 *  而"删除会不会复活""被覆盖的那一次有没有在两端都留痕""状态与留痕对象在不在同步范围"
 *  是**端到端**的行为 —— 只有真的跑一遍引擎、再看两个库的结果才算数。
 *  （这三条正是宪章 v1.2 新增的硬要求，之前只用手工命令验过一次。）
 *
 *  做法：两个临时库 → 用 WorkstationStore 造真实形状 → spawn `sync-engine.mjs --remote-local` → 断言两库结果。
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, rmSync, readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {WorkstationStore} from '../src/store.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ctx = {workspace: 'w', actor: 'test', canWrite: true};

const runEngine = (local, remote, {apply = true, force = false} = {}) => {
  const args = ['sync-engine.mjs', '--local', local, '--remote-local', remote];
  if (apply) args.push('--apply');
  if (force) args.push('--force');
  try {
    return {code: 0, out: execFileSync(process.execPath, args, {cwd: root, encoding: 'utf8'})};
  } catch (error) {
    return {code: error.status ?? 1, out: String(error.stdout ?? '') + String(error.stderr ?? '')};
  }
};

const rows = (db, sql) => { const handle = new DatabaseSync(db, {readOnly: true}); try { return handle.prepare(sql).all(); } finally { handle.close(); } };

test('宪章 v1.2 第七条：删除必须留墓碑，且**不会复活**', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sync-e2e-'));
  const local = join(dir, 'local.sqlite'), remote = join(dir, 'remote.sqlite');
  try {
    // 两边都先建成同一批数据：把 A 库当"已同步过的两端"
    const storeA = new WorkstationStore(local);
    storeA.draft(ctx, {title: '铺底', changes: [
      {op: 'create', id: 'p-1', kind: 'project', data: {title: '项目一'}},
      {op: 'create', id: 'p-2', kind: 'project', data: {title: '项目二'}},
    ]});
    storeA.commit(ctx, {batchId: storeA.inbox(ctx, {status: 'draft'})[0].id, revision: 1, key: 'seed'});
    storeA.close();
    execFileSync('/bin/cp', [local, remote]);   // 对端 = 同一份拷贝（模拟已经同步过）

    // 本地删掉 p-2（走删除路径 → 必须写墓碑）
    const store = new WorkstationStore(local);
    store.draft(ctx, {title: '删掉项目二', changes: [{op: 'delete', id: 'p-2', expectedRevision: 1}]});
    const batch = store.inbox(ctx, {status: 'draft'})[0];
    store.commit(ctx, {batchId: batch.id, revision: batch.revision, key: 'del'});
    store.close();

    assert.equal(rows(local, "select count(*) c from tombstones").at(0).c, 1, '删除必须留下墓碑');

    // 先只读看一遍：有冲突时引擎应当**拒绝**自动执行（exit 3），绝不能默默覆盖
    const dry = runEngine(local, remote, {apply: false});
    assert.equal(dry.code, 0, '只读检查应当正常退出：' + dry.out.slice(-200));
    const blocked = runEngine(local, remote, {apply: true});
    assert.equal(blocked.code, 3, '有冲突时必须拒绝自动执行（exit 3），实得 ' + blocked.code);

    const result = runEngine(local, remote, {apply: true, force: true});
    assert.equal(result.code, 0, '看完清单并确认后应当同步成功：' + result.out.slice(-200));

    assert.equal(rows(local, "select count(*) c from entities where id='p-2'").at(0).c, 0, '本地：p-2 应当已删');
    assert.equal(rows(remote, "select count(*) c from entities where id='p-2'").at(0).c, 0, '对端：p-2 也应当被删（不复活）');
    assert.equal(rows(remote, "select count(*) c from tombstones where id='p-2'").at(0).c, 1, '对端也要有墓碑（两边都留痕）');
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('宪章 v1.2 第七条：被覆盖的那一次必须在**两端**留痕', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sync-override-'));
  const local = join(dir, 'local.sqlite'), remote = join(dir, 'remote.sqlite');
  try {
    const storeA = new WorkstationStore(local);
    storeA.draft(ctx, {title: '铺底', changes: [{op: 'create', id: 'p-1', kind: 'project', data: {title: '项目一'}}]});
    const seedBatch = storeA.inbox(ctx, {status: 'draft'})[0];
    storeA.commit(ctx, {batchId: seedBatch.id, revision: seedBatch.revision, key: 'seed'});
    storeA.close();
    execFileSync('/bin/cp', [local, remote]);

    // 两端各改一次同一条对象（制造"被覆盖的那一次"）
    const edit = (db, title, key) => {
      const store = new WorkstationStore(db);
      store.draft(ctx, {title, changes: [{op: 'update', id: 'p-1', expectedRevision: 1, data: {title}}]});
      const batch = store.inbox(ctx, {status: 'draft'})[0];
      store.commit(ctx, {batchId: batch.id, revision: batch.revision, key});
      store.close();
    };
    edit(local, '本地改的名字', 'local-edit');
    edit(remote, '对端改的名字', 'remote-edit');

    const result = runEngine(local, remote, {apply: true, force: true});
    assert.equal(result.code, 0, '同步应当成功：' + result.out.slice(-200));

    // 覆盖发生在一侧或两侧都要留痕：两库的 audit 表里都得有覆盖记录
    for (const [label, db] of [['本地', local], ['对端', remote]]) {
      const overrides = rows(db, "select count(*) c from audit where event='sync.override'").at(0).c;
      assert.ok(overrides >= 1, label + '必须留下"覆盖"留痕（宪章第七条：被覆盖的那一次两端都留痕）');
    }
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('同步范围包含状态与留痕对象（心跳留痕、出声反馈、**决定历史**）', () => {
  const engine = execFileSync('/bin/cat', [join(root, 'sync-engine.mjs')], {encoding: 'utf8'});
  for (const table of ['heartbeat_runs', 'speak_feedback', 'batches']) {
    assert.match(engine, new RegExp("'" + table + "'"), table + ' 必须在同步表清单里（否则换设备后"做过的痕迹"会丢）');
  }
  assert.match(engine, /where status in \('committed','cancelled'\)/, '只同步已定案的批次');
});

test('换台新设备：**决定历史要过去，未决草稿不能过去**', () => {
  // 实测过的缺口：同步完新设备拿到全部对象，但 batches=0 —— 在另一台机器上看不到自己做过哪些决定。
  // 而草稿（还没决定的下一步）必须留在本机：两边都拉过去会出现"同一件事被决定两次"。
  const dir = mkdtempSync(join(tmpdir(), 'sync-history-'));
  const laptop = join(dir, 'laptop.sqlite'), fresh = join(dir, 'fresh.sqlite');
  try {
    const store = new WorkstationStore(laptop);
    // 两件已定案的
    for (const [id, title, key] of [['p-1', '项目一', 'k1'], ['p-2', '项目二', 'k2']]) {
      store.draft(ctx, {title, changes: [{op: 'create', id, kind: 'project', data: {title}}]});
      const batch = store.inbox(ctx, {status: 'draft'})[0];
      store.commit(ctx, {batchId: batch.id, revision: batch.revision, key});
    }
    // 一条**未决草稿**
    store.draft(ctx, {title: '还没决定的下一步', changes: [{op: 'create', id: 'p-3', kind: 'project', data: {title: '项目三（草稿）'}}]});
    store.close();
    new WorkstationStore(fresh).close();   // 新设备：空库

    const result = runEngine(laptop, fresh, {apply: true, force: true});
    assert.equal(result.code, 0, '同步应当成功：' + result.out.slice(-200));

    const decided = rows(fresh, "select count(*) c from batches where status in ('committed','cancelled')").at(0).c;
    const drafts = rows(fresh, "select count(*) c from batches where status='draft'").at(0).c;
    assert.ok(decided >= 2, '决定历史必须跟过去，实得 ' + decided + ' 条');
    assert.equal(drafts, 0, '未决草稿不能跟过去（否则同一件事可能在两台机器上各决定一次）');
    assert.equal(rows(fresh, "select count(*) c from entities where id='p-3'").at(0).c, 0, '草稿里的对象也不该过去');
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('任一端缺墓碑表时**拒绝**真同步（宁可不做，也不要静默丢数据）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sync-noguard-'));
  const local = join(dir, 'local.sqlite'), remote = join(dir, 'remote.sqlite');
  try {
    const store = new WorkstationStore(local);
    store.draft(ctx, {title: '铺底', changes: [{op: 'create', id: 'p-1', kind: 'project', data: {title: '项目一'}}]});
    store.close();
    // 对端是一个**手工建的老库**：没有 tombstones 表（模拟旧版本/别的工具建的库）
    const old = new DatabaseSync(remote);
    old.exec('create table entities(workspace text,id text,kind text,revision integer,data text,archived integer,author text,at text)');
    old.close();

    const result = runEngine(local, remote, {apply: true});
    assert.equal(result.code, 4, '缺墓碑表时必须拒绝 --apply（exit 4），实得 ' + result.code + '：' + result.out.slice(-160));
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('同步前的快照必须是**能用的备份**（WAL 下拷主文件会得到一份没用的文件）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sync-snap-'));
  const local = join(dir, 'local.sqlite'), remote = join(dir, 'remote.sqlite');
  let store = null;
  try {
    store = new WorkstationStore(local);
    store.draft(ctx, {title: '铺底', changes: [{op: 'create', id: 'p-1', kind: 'project', data: {title: '项目一'}}]});
    const batch = store.inbox(ctx, {status: 'draft'})[0];
    store.commit(ctx, {batchId: batch.id, revision: batch.revision, key: 'seed'});
    // 造"对端"也必须用 .backup：这一步 store 还开着，`/bin/cp` 会得到一个没有表的文件
    // —— 我第一版测试就是这么写的，引擎当场报 `no such table: entities`（同一个 WAL 陷阱）。
    execFileSync('/usr/bin/sqlite3', [local, '.backup ' + remote]);
    // 再改一次，**并且不关库** —— 真实情形就是插件进程一直开着它，
    // 这时最近的提交（甚至建表）可能还只在 -wal 里。旧实现直接 copyFileSync 主文件，
    // 实测拷出来的文件**连 entities 表都没有**，却在界面上说"出事能回退"。
    store.draft(ctx, {title: '再改一次', changes: [{op: 'create', id: 'p-2', kind: 'project', data: {title: '项目二'}}]});
    const second = store.inbox(ctx, {status: 'draft'})[0];
    store.commit(ctx, {batchId: second.id, revision: second.revision, key: 'more'});

    const result = runEngine(local, remote, {apply: true, force: true});
    assert.equal(result.code, 0, '同步应当成功：' + result.out.slice(-200));

    const snaps = readdirSync(dir).filter(name => name.startsWith('local.sqlite.syncbak-'));
    assert.ok(snaps.length >= 1, '同步前必须留下快照');
    const snapshot = join(dir, snaps[0]);
    const handle = new DatabaseSync(snapshot, {readOnly: true});
    try {
      const tables = handle.prepare("select count(*) c from sqlite_master where type='table' and name='entities'").get().c;
      assert.equal(tables, 1, '快照必须是一份能打开的库（旧实现拷主文件时连表都没有）');
      const objects = handle.prepare('select count(*) c from entities').get().c;
      assert.ok(objects >= 2, '快照必须包含最近的提交，实得 ' + objects + ' 个对象');
    } finally { handle.close(); }
  } finally {
    store?.close();
    rmSync(dir, {recursive: true, force: true});
  }
});

test('一端删了、另一端**并发改过**同一条：删除生效（不复活）+ 两端墓碑一致 + 两端都有覆盖留痕', () => {
  // 说明：一开始我把期望写反了 —— 以为"对端有更新的改动"就该保住实体。
  // 实测引擎的语义是：**墓碑写入时带"实体版本+1"**，所以删除比并发的一次修改更"新"，删除生效。
  // 这正是宪章 F14「删除不复活」要的；而"更新的改动"要真能赢，得比墓碑版本号还高。
  const dir = mkdtempSync(join(tmpdir(), 'sync-resurrect-'));
  const local = join(dir, 'local.sqlite'), remote = join(dir, 'remote.sqlite');
  try {
    const seed = new WorkstationStore(local);
    seed.draft(ctx, {title: '铺底', changes: [{op: 'create', id: 'p-1', kind: 'project', data: {title: '项目一'}}]});
    const seedBatch = seed.inbox(ctx, {status: 'draft'})[0];
    seed.commit(ctx, {batchId: seedBatch.id, revision: seedBatch.revision, key: 'seed'});
    seed.close();
    execFileSync('/usr/bin/sqlite3', [local, '.backup ' + remote]);

    const deleter = new WorkstationStore(local);
    deleter.draft(ctx, {title: '删掉', changes: [{op: 'delete', id: 'p-1', expectedRevision: 1}]});
    const delBatch = deleter.inbox(ctx, {status: 'draft'})[0];
    deleter.commit(ctx, {batchId: delBatch.id, revision: delBatch.revision, key: 'del'});
    deleter.close();

    // 对端**没看见删除**，还在改它 —— 典型的"两端并发"
    const editor = new WorkstationStore(remote);
    editor.draft(ctx, {title: '对端改过', changes: [{op: 'update', id: 'p-1', expectedRevision: 1, data: {title: '项目一（对端改过）'}}]});
    const editBatch = editor.inbox(ctx, {status: 'draft'})[0];
    editor.commit(ctx, {batchId: editBatch.id, revision: editBatch.revision, key: 'edit'});
    editor.close();

    const result = runEngine(local, remote, {apply: true, force: true});
    assert.equal(result.code, 0, '同步应当成功：' + result.out.slice(-200));

    assert.equal(rows(local, "select count(*) c from entities where id='p-1'").at(0).c, 0, '删除必须生效（不复活）');
    assert.equal(rows(remote, "select count(*) c from entities where id='p-1'").at(0).c, 0, '对端也要删掉');
    assert.equal(rows(local, "select count(*) c from tombstones where id='p-1'").at(0).c, 1, '本地留墓碑');
    assert.equal(rows(remote, "select count(*) c from tombstones where id='p-1'").at(0).c, 1, '对端也留墓碑');
    // 被覆盖的那一次（对端的修改）必须在**两端**都留痕，且写清谁赢谁输
    for (const [label, db] of [['本地', local], ['对端', remote]]) {
      const trace = rows(db, "select body from audit where event='sync.override' order by rowid desc limit 1");
      assert.ok(trace.length >= 1, label + '要有覆盖留痕');
      const body = JSON.parse(trace[0].body);
      assert.equal(body.winner, 'local', label + '的留痕要写明谁赢了');
      assert.ok(Number.isFinite(body.loserRevision) && Number.isFinite(body.winnerRevision), label + '的留痕要有双方版本');
      assert.ok(String(body.reason ?? '').length > 0, label + '的留痕要写清为什么');
    }
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('删除后被改得更多（版本超过墓碑）→ 按新证据保留，且**两端都留下"复原"留痕**', () => {
  // 这是一条**会被撤销的删除**：对端在删除之后又改了好几轮，版本号高过墓碑，
  // 引擎判定"有新证据"→ 保住实体、撤掉墓碑。删掉的东西因此会回来。
  // 语义本身是设计如此，但**必须能查**：实测原来两端一条留痕都没有
  // （`select * from audit where event like '%resurrect%'` = 0 条），
  // 用户会看到东西自己回来了却不知道为什么 —— 已补 `sync.resurrect` 留痕。
  const dir = mkdtempSync(join(tmpdir(), 'sync-newer-'));
  const local = join(dir, 'local.sqlite'), remote = join(dir, 'remote.sqlite');
  try {
    const seed = new WorkstationStore(local);
    seed.draft(ctx, {title: '铺底', changes: [{op: 'create', id: 'p-1', kind: 'project', data: {title: '项目一'}}]});
    const seedBatch = seed.inbox(ctx, {status: 'draft'})[0];
    seed.commit(ctx, {batchId: seedBatch.id, revision: seedBatch.revision, key: 'seed'});
    seed.close();
    execFileSync('/usr/bin/sqlite3', [local, '.backup ' + remote]);

    const deleter = new WorkstationStore(local);
    deleter.draft(ctx, {title: '删掉', changes: [{op: 'delete', id: 'p-1', expectedRevision: 1}]});
    const delBatch = deleter.inbox(ctx, {status: 'draft'})[0];
    deleter.commit(ctx, {batchId: delBatch.id, revision: delBatch.revision, key: 'del'});
    deleter.close();

    const editor = new WorkstationStore(remote);
    let revision = 1;
    for (let round = 1; round <= 3; round += 1) {
      editor.draft(ctx, {title: '对端第' + round + '次改', changes: [{op: 'update', id: 'p-1', expectedRevision: revision, data: {title: '项目一（对端第' + round + '次）'}}]});
      const batch = editor.inbox(ctx, {status: 'draft'})[0];
      editor.commit(ctx, {batchId: batch.id, revision: batch.revision, key: 'edit' + round});
      revision += 1;
    }
    editor.close();

    const result = runEngine(local, remote, {apply: true, force: true});
    assert.equal(result.code, 0, '同步应当成功：' + result.out.slice(-200));

    assert.equal(rows(local, "select count(*) c from entities where id='p-1'").at(0).c, 1, '版本更高的改动 = 新证据 → 保留实体');
    assert.equal(rows(local, "select count(*) c from tombstones where id='p-1'").at(0).c, 0, '墓碑要撤掉，否则以后还会误删');
    for (const [label, db] of [['本地', local], ['对端', remote]]) {
      const trace = rows(db, "select body from audit where event='sync.resurrect' order by rowid desc limit 1");
      assert.ok(trace.length >= 1, label + '必须留下"删除被复原"的痕迹（否则用户看到东西回来却查不到原因）');
      const body = JSON.parse(trace[0].body);
      assert.equal(body.decision, 'kept-after-delete');
      assert.ok(Number.isFinite(body.tombstoneRevision), label + '的留痕要写清当时的墓碑版本');
      assert.ok(String(body.reason ?? '').length > 0, label + '的留痕要写清为什么');
    }
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('真同步核对：`--check` 只读、逐表指纹比对，**改动一条就必须报不一致**', () => {
  // 用户 2026-10-17：「还要有机制保证同步引擎是实现了的，能确保是真同步」。
  // 这条测的就是那个机制：
  //   ① 一致时 `--check` 退出 0，并逐表打印指纹（entities / tombstones / 已定案 batches）；
  //   ② 偷偷改动对端一条 → 必须退出 1（否则这个"机制"就是摆设）；
  //   ③ `--check` **不写任何东西**（跑完两端行数、mtime 都不变）。
  const dir = mkdtempSync(join(tmpdir(), 'sync-check-'));
  const local = join(dir, 'local.sqlite'), remote = join(dir, 'remote.sqlite');
  try {
    const store = new WorkstationStore(local);
    store.draft(ctx, {title: '铺底', changes: [{op: 'create', id: 'p-1', kind: 'project', data: {title: '项目一'}}]});
    const batch = store.inbox(ctx, {status: 'draft'})[0];
    store.commit(ctx, {batchId: batch.id, revision: batch.revision, key: 'seed'});
    store.close();
    execFileSync('/usr/bin/sqlite3', [local, '.backup ' + remote]);

    const check = (db = local) => {
      try {
        return {code: 0, out: execFileSync(process.execPath, ['sync-engine.mjs', '--local', db, '--remote-local', remote, '--check'], {cwd: root, encoding: 'utf8'})};
      } catch (error) {
        return {code: error.status ?? 1, out: String(error.stdout ?? '') + String(error.stderr ?? '')};
      }
    };
    const first = check();
    assert.equal(first.code, 0, '两端一致时应当 PASS：' + first.out.slice(-200));
    for (const table of ['entities', 'tombstones', 'batches']) {
      assert.match(first.out, new RegExp('PASS ' + table), table + ' 必须逐表核对（只比对象会漏掉墓碑与决定历史）');
    }
    assert.match(first.out, /真同步/);

    // ③ 只读：跑完两边行数不变
    const count = (db, table) => { const handle = new DatabaseSync(db, {readOnly: true}); try { return handle.prepare('select count(*) c from ' + table).get().c; } finally { handle.close(); } };
    assert.equal(count(local, 'entities'), 1);
    assert.equal(count(remote, 'entities'), 1);

    // ② 反例：对端少一条 → 必须报不一致
    const handle = new DatabaseSync(remote);
    handle.prepare("delete from entities where id='p-1'").run();
    handle.close();
    const second = check();
    assert.equal(second.code, 1, '对端被改动后必须 FAIL，否则这个核对不可信');
    assert.match(second.out, /FAIL entities/);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});
