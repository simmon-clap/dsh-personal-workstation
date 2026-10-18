#!/usr/bin/env node
/** 真实数据上的宪章判据检查（判据 1 / 3 / 5）。
 *
 *  为什么单独一个脚本：夹具门禁只能证明"机制在"，证明不了"真实数据里发生过"。
 *  而"真实数据里发生过"才是宪章的验收口径（判据 1「口头承诺被主动提醒」、
 *  判据 3「判断能追回录音或文件的那一段」、判据 5「采纳/改写/否决比率可查」）。
 *
 *  ⚠ **取副本必须先经过 sqlite3 `.backup`**（2026-10-16 踩过）：
 *  库跑在 WAL 模式，只 `cp` 主文件会拿到**旧快照**（最近的提交还在 `-wal` 里）。
 *  实测后果：副本显示"4 条待决定"，真库其实已是"0 条待决定 / 14 条已撤销"。
 *  所以这个脚本自己用 `.backup` 取副本，**只读副本、绝不碰真库**。
 *
 *  用法：node prototype/real-data-check.mjs [库路径]
 */
import {execFileSync} from 'node:child_process';
import {createServer} from 'node:http';
import {existsSync, mkdtempSync, rmSync, statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {WorkstationStore} from '../src/store.mjs';
import {HeartbeatStore} from '../src/heartbeat-store.mjs';
import {runHeartbeat} from '../src/heartbeat.mjs';
import {httpRoute} from '../src/http-route.mjs';
import {HostFiles} from '../src/host-files.mjs';
import {AUDIO_WINDOW_MAX_BYTES} from '../src/file-preview-route.mjs';
import {createFsPort} from './audit-fs-port.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const source = process.argv[2] ?? join(here, '..', '..', 'workstation-data', 'workstation.sqlite');
if (!existsSync(source)) {
  console.log('FAIL: 找不到真实库：' + source + '（不是通过，是没测到）');
  process.exit(1);
}
const workdir = mkdtempSync(join(tmpdir(), 'real-data-check-'));
const copy = join(workdir, 'copy.sqlite');
const problems = [];
try {
  // **WAL 安全的只读副本**（见文件头）
  execFileSync('/usr/bin/sqlite3', [source, '.backup ' + copy]);
  const store = new WorkstationStore(copy);
  const heartbeat = new HeartbeatStore(store);
  const workspace = store.batchScopes()[0];
  const ctx = {workspace, actor: 'real-data-check', canWrite: false};

  console.log('库：' + source);
  console.log('（副本经 sqlite3 .backup 取得，只读；真库未被改动）\n');

  // ── 判据 5 ────────────────────────────────────────────────────────────────
  const batches = store.inbox(ctx, {limit: 500}).filter(b => b.proposal);
  const decided = batches.filter(b => b.proposal.decision && b.proposal.decision !== 'undecided');
  const by = {};
  for (const b of decided) by[b.proposal.decision] = (by[b.proposal.decision] ?? 0) + 1;
  console.log('【判据 5】建议的采纳／改写／否决比率可查');
  console.log('  带建议的批次 ' + batches.length + ' · 已回应 ' + decided.length + ' · 分布 ' + JSON.stringify(by));
  if (!decided.length) problems.push('判据 5：真实数据里没有任何"已回应"的建议 —— 比率无从计算（不是通过）');

  // ── 判据 1 ────────────────────────────────────────────────────────────────
  const record = runHeartbeat({store, ctx, now: new Date(), since: heartbeat.status(ctx).lastSuccessAt, speak: null});
  const worth = record.worth ?? record.candidates ?? [];
  console.log('\n【判据 1】主动提醒 + 能点回原始出处');
  console.log('  看了：' + (record.looked ?? []).map(x => x.what ?? x.title ?? String(x)).slice(0, 8).join('、'));
  console.log('  值得找你的 ' + worth.length + ' 条');
  for (const item of worth.slice(0, 5)) {
    console.log('    · ' + String(item.title ?? item.what ?? '').slice(0, 44) + '  ← ' + String(item.why ?? item.reason ?? item.since ?? '(没写理由)').slice(0, 40));
  }
  const noReason = worth.filter(item => !(item.why ?? item.reason ?? item.since));
  if (noReason.length) problems.push('判据 1：有 ' + noReason.length + ' 条"值得找你的"没写理由（宪章要求每次出声都能回答"为什么现在告诉你"）');
  const oldest = store.db.prepare('select min(at) m from entities').get()?.m ?? null;
  console.log('  数据里最早的对象：' + (oldest ?? '未知') + ' —— 真实数据不够三个月，所以上面的"原话场景"是在副本上造出来验的');

  // ── 判据 1 的**原话场景**：三个月前的口头承诺 → 被主动提醒 → 能点回原始出处 ──────
  // 真实库里最老的数据是 10 月的，没有"三个月前的承诺"可提醒；所以在**副本**上把它造出来，
  // 走一遍完整链路（这条只读副本，真库一个字不动）。
  console.log('\n【判据 1 · 原话场景】三个月前的口头承诺，交付日临近时会不会被提醒');
  const sourceArtifact = store.list(ctx, {kind: 'artifact', limit: 50}).find(row => /纪要|录音|会议/.test(row.data?.title ?? '')) ?? store.list(ctx, {kind: 'artifact', limit: 1})[0];
  const threeMonthsAgo = new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const dueSoon = new Date(Date.now() + 2 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const scenarioCtx = {...ctx, canWrite: true};
  let scenario = null;
  try {
    const draft = store.draft(scenarioCtx, {title: '判据 1 场景：补记一条口头承诺', changes: [{op: 'create', id: 't-commit-scenario', kind: 'task', data: {
      title: '答应对方：把合作方案写出来', ownerId: '', status: 'in_progress', dueDate: dueSoon, steps: [], projectId: '', sourceRefs: [sourceArtifact?.id ?? ''],
    }}]});
    store.commit(scenarioCtx, {batchId: draft.id, revision: draft.revision, key: 'criterion-1-scenario'});
    store.db.prepare('update entities set at=? where workspace=? and id=?').run(threeMonthsAgo + 'T02:00:00.000Z', ctx.workspace, 't-commit-scenario');
    const scenarioRecord = runHeartbeat({store, ctx, now: new Date(), since: null, speak: null});
    const hit = (scenarioRecord.candidates ?? []).find(item => item.subjectId === 't-commit-scenario');
    const task = store.get(scenarioCtx, 't-commit-scenario');
    const refs = task?.data?.sourceRefs ?? [];
    const resolvable = refs.length > 0 && refs.every(ref => { try { return Boolean(store.get(scenarioCtx, ref)) } catch { return false } });
    scenario = {hit, refs, resolvable};
    console.log('  造出来的承诺：记录于 ' + threeMonthsAgo + ' · 交付日 ' + dueSoon + ' · 来源 ' + (refs[0] ?? '（无）'));
    console.log('  心跳：' + (hit ? '提醒了 —— 「' + hit.why + '」（级别 ' + hit.level + '）' : '**没有提醒**'));
    console.log('  点回原始出处：' + (resolvable ? '能（' + refs.length + ' 条出处全部解析到对象）' : '**不能**'));
    if (!hit) problems.push('判据 1：三个月前的承诺、交付日就在两天后，心跳**没有提醒**');
    if (!hit?.why) problems.push('判据 1：提醒没有写"为什么现在告诉你"');
    if (!resolvable) problems.push('判据 1：提醒点不回原始出处（任务的来源引用解析不到对象）');
  } catch (error) {
    problems.push('判据 1 的场景没跑成：' + (error?.message ?? error));
  }

  // ── 判据 3 ────────────────────────────────────────────────────────────────
  console.log('\n【判据 3】一条判断能追回录音或文件的那一段');
  const judgments = store.db.prepare("select id from entities where kind='judgment' and archived=0").all().map(r => store.get(ctx, r.id));
  let total = 0, resolvable = 0, ranged = 0;
  const broken = [];
  for (const judgment of judgments) {
    for (const evidence of (judgment.data.evidence ?? [])) {
      total += 1;
      if (/@\d+-\d+$/.test(evidence.ref ?? '')) ranged += 1;
      const base = String(evidence.ref ?? '').replace(/@\d+-\d+$/, '');
      let hit = null;
      try { hit = store.get(ctx, base) } catch {}
      if (hit) resolvable += 1;
      else broken.push(base.slice(0, 40) + '（判断 ' + judgment.id.slice(0, 20) + '）');
    }
  }
  console.log('  判断 ' + judgments.length + ' 条 · 依据 ' + total + ' 条 · 能指回已知对象 ' + resolvable + ' 条 · 带段落范围 ' + ranged + ' 条');
  for (const row of broken.slice(0, 5)) console.log('    ⚠ 指不回：' + row);
  if (broken.length) problems.push('判据 3：有 ' + broken.length + ' 条依据指不回库里的对象');
  if (!ranged && total) {
    console.log('  ⚠ 没有一条带段落范围 —— "追回**那一段**"在真实数据上还没被演示过（实现支持，缺的是录入时引导）');
  }
  // ── 判据 3 的最后一环（真实文件）：那份 54MB 的录音能不能**按段**送出去 ──────
  // 前面验的都是数据层（依据指回对象、锚点带范围）。这一环验的是"字节真的流得出来"：
  // 录音有 54MB，一次读进来既超预览上限、也不该那么干 —— 必须能按 Range 只取窗口。
  console.log('\n【判据 3 · 真实录音】那份会议录音能不能按段播放');
  const audioArtifact = store.list(ctx, {kind: 'artifact', limit: 200})
    .find(row => /\.(m4a|mp3|wav|aac|ogg|flac)$/i.test(String(row.data?.path ?? '')));
  if (!audioArtifact) {
    console.log('  真实库里没有音频资料 —— 这一环这次无从验起（不是通过）');
  } else {
    const fileName = String(audioArtifact.data.path).split('/').pop();
    const rootDirectory = join(here, '..', '..');
    // 在真实工作区里找到那个文件（不清扫全盘，只在常见的 inbox/voice 位置找）
    const candidates = [join(rootDirectory, 'voice', 'inbox', fileName), join(rootDirectory, 'inbox', fileName), join(rootDirectory, 'voice', fileName)];
    const realFile = candidates.find(candidate => existsSync(candidate));
    if (!realFile) {
      console.log('  找到了音频资料（' + fileName + '），但文件本身不在预期位置 —— 这一环没法验（不是通过）');
    } else {
      const size = statSync(realFile).size;
      const files = new HostFiles(createFsPort(), [{id: 'real-audio', workspace: ctx.workspace, root: dirname(realFile), read: true, write: false, label: '录音'}]);
      const connection = {admit: () => ({peer: {id: 'real-data-check'}}), requestRejection: () => undefined};
      const route = httpRoute({store, files, connection, workspaceRegistry: {list: () => [{id: ctx.workspace}], get: () => ({id: ctx.workspace})}, allowedWorkspaces: [ctx.workspace]});
      const probe = createServer((request, response) => route.handler(request, response));
      await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
      try {
        const base = 'http://127.0.0.1:' + probe.address().port + '/personal-workstation/file?workspace=' + encodeURIComponent(ctx.workspace) + '&grantId=real-audio&path=' + encodeURIComponent(fileName);
        const ranged = await fetch(base, {headers: {range: 'bytes=1000-1999'}});
        const body = Buffer.from(await ranged.arrayBuffer());
        const total = Number((ranged.headers.get('content-range') ?? '').split('/').pop());
        console.log('  文件 ' + fileName + ' · ' + (size / 1048576).toFixed(1) + 'MB');
        console.log('  Range 请求 → HTTP ' + ranged.status + ' · content-range ' + ranged.headers.get('content-range') + ' · 实收 ' + body.length + ' 字节');
        if (ranged.status !== 206) problems.push('判据 3：真实录音的 Range 请求没有回 206（回了 ' + ranged.status + '）');
        if (body.length !== 1000) problems.push('判据 3：Range 请求应当只回 1000 字节，实得 ' + body.length);
        if (total !== size) problems.push('判据 3：content-range 里的总大小与真实文件不符（' + total + ' vs ' + size + '）');
        if (ranged.headers.get('accept-ranges') !== 'bytes') problems.push('判据 3：没有 accept-ranges，播放器无法拖动进度条');
        // 也确认它**没有**把整个文件吐出来（64KB 窗口之外的部分不该出现在响应里）
        const whole = await fetch(base);
        const wholeBody = Buffer.from(await whole.arrayBuffer());
        console.log('  不带 Range 的请求 → ' + wholeBody.length + ' 字节（窗口上限 ' + AUDIO_WINDOW_MAX_BYTES + '，不是整个 ' + size + '）');
        if (wholeBody.length > AUDIO_WINDOW_MAX_BYTES) problems.push('判据 3：不带 Range 时把超过窗口上限的字节吐了出来');
      } finally {
        await new Promise(resolve => probe.close(resolve));
      }
    }
  }

  store.close();
} finally {
  rmSync(workdir, {recursive: true, force: true});
}

if (problems.length) {
  console.log('\nFAIL：' + problems.length + ' 项 —— ' + problems.join('；'));
  process.exit(1);
}
console.log('\nPASS：真实数据上，判据 5 可算、判据 1 的每一条提醒都有理由、判据 3 的依据都能指回对象。');
console.log('（判据 1 的原话场景是在副本上造出来验的；判据 3 的"段落级"取决于你的依据有没有写范围 —— 脚本都会如实说出来。）');
