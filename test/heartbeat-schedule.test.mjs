/** 真定时（2026-10-16）：默认必须是**关**的，打开后事实要如实。
 *
 *  背景：宿主里没有 `@deepseek-ai/dsh-experimental-schedule-bundle`（`ctx.get('schedule')` 取不到），
 *  但有 Cordis 混入的 `timer` 服务（`timeout/interval/throttle/debounce`）——
 *  所以"自己醒"这件事**做得到**（DSH 在跑的时候）。真正的 24 小时常驻仍然要靠常驻节点。
 *
 *  为什么默认关：它决定"什么时候会出声打扰你"。这属于用户拍板的事，不该由实现替他决定。
 *  这条测试守住两件事：
 *   ① 缺省（没配 intervalMinutes）= 不自动醒；
 *   ② 文案与事实一致 —— 没接定时就不许说"已在定时运行"。
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join, dirname} from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const schema = readFileSync(join(root, 'src', 'config-schema.mjs'), 'utf8');
const index = readFileSync(join(root, 'src', 'index.mjs'), 'utf8');
const store = readFileSync(join(root, 'src', 'heartbeat-store.mjs'), 'utf8');

test('配置项存在且默认是 0（不自动醒）', () => {
  assert.match(schema, /intervalMinutes:schema\.number\(\)\.default\(0\)/, '定时间隔必须存在且默认 0');
  assert.match(schema, /heartbeat:schema\.object\(/, 'heartbeat 配置块必须存在');
});

test('配置键白名单同步（否则整插件启用失败 —— 这个错踩过两次）', () => {
  assert.match(index, /'appleCalendar','heartbeat','assistant'\]/, 'resolveConfig 的白名单必须包含 heartbeat 与 assistant');
  // 这条断言故意钉住字面量：白名单漏一个键，整插件启用失败（1.1.0 / 1.6.1 两次都是这个错）。
  assert.match(schema, /assistant:schema\.object\(/, 'config-schema 里必须有 assistant 配置块');
});

test('间隔为 0 时不会装定时器；装的时候用的是宿主 timer 且只跑心跳', () => {
  assert.match(index, /const autoHeartbeat=Boolean\(timer\)&&heartbeatMinutes>0/, '必须用"有 timer 且间隔 > 0"作为开关');
  const at = index.indexOf('if(autoHeartbeat){');
  assert.ok(at > 0, '找不到安装定时的分支');
  const block = index.slice(at, index.indexOf('},heartbeatMinutes*60*1000));', at));
  assert.match(block, /timer\.interval\(/, '要用宿主的 timer.interval');
  assert.match(block, /runHeartbeat\(/, '定时到点要跑心跳');
  assert.match(block, /speak:null/, '定时唤醒**不直接出声** —— 先留痕，要不要找你要另行判断（避免"自己醒了就打扰你"）');
});

test('定时状态只有一套话术（W1 P0-1：有定时 / 没定时，不再三种口径并存）', () => {
  assert.match(store, /scheduledNote: scheduled\s*\n?\s*\?\s*'已开启定时：每 /, '有定时时用唯一说法');
  assert.match(store, /'没有开启定时：要你点一下它才会看一眼。'/, '没定时时说实话，且不出现"未接入/手动触发"第二套说法');
  assert.doesNotMatch(store, /还没有接入定时/, '旧口径必须删干净');
});

test('激活重放的宿主桩必须提供 timer（否则"只在有 timer 时才走到"的代码会被整段跳过 → 假通过）', () => {
  const replay = readFileSync(join(root, 'prototype', 'activation-replay.mjs'), 'utf8');
  assert.match(replay, /if\(name==='timer'\)return \{/, '重放桩必须提供 timer —— 宿主要真有这个服务');
  assert.match(replay, /interval\(\)\{return\(\)=>\{\}\}/, 'timer 桩要提供 interval（否则自动醒那条分支根本不求值）');
});

test('定时相关的变量必须在同一作用域取值（跨作用域写会 ReferenceError，且只在真实宿主上才炸）', () => {
  // resolveConfig 与 apply 是两个函数：一个里声明的变量，另一个里直接用会炸。
  const resolvedAt = index.indexOf('export function resolveConfig');
  const applyAt = index.indexOf('export function apply');
  const between = index.slice(resolvedAt, applyAt);
  const inApply = index.slice(applyAt);
  assert.match(between, /const heartbeatMinutes=/, '间隔应在 resolveConfig 里解析');
  assert.match(between, /return \{[^}]*heartbeatMinutes/, '解析结果要随返回值带出去');
  const declareAt = inApply.indexOf('const heartbeatMinutes=resolved.heartbeatMinutes');
  assert.ok(declareAt > 0, 'apply 里应从 resolved 取一份到本作用域');
  // 真正要守的是**先声明后使用**：跨作用域引用（或先用后声明）都只在特定条件下才炸，
  // 静态检查就用"第一次使用必须在声明之后"来守。
  const firstUse = inApply.search(/heartbeatMinutes\s*[>*) ]/);
  assert.ok(firstUse > declareAt, 'heartbeatMinutes 在 apply 里必须先声明后使用（实测跨作用域引用会让插件整个启用失败）');
});

test('定时接上之后，一次手动触发的记录里**不许再说"还没有接入定时"**', async () => {
  // 2026-10-17 实测：定时真的接上（scheduled:true）之后，手动跑一次留下的记录里仍写着
  // 「手动触发；还没有接入定时，不会自己醒。」—— 用户看到会以为定时没生效。
  const {WorkstationStore} = await import('../src/store.mjs');
  const {runHeartbeat} = await import('../src/heartbeat.mjs');
  const store = new WorkstationStore(':memory:');
  try {
    const ctx = {workspace: 'w', actor: 't', canWrite: false};
    const manual = runHeartbeat({store, ctx, now: new Date(), scheduled: false, intervalMinutes: 60, speak: null});
    assert.equal(manual.scheduled, false, '这次是手动触发');
    assert.match(manual.scheduledNote, /定时开着/, '定时确实开着，就必须这么说');
    assert.doesNotMatch(manual.scheduledNote, /还没有接入定时/, '不许再说"还没接入"');
    const byTimer = runHeartbeat({store, ctx, now: new Date(), scheduled: true, intervalMinutes: 60, speak: null});
    assert.equal(byTimer.trigger, 'timer');
    assert.match(byTimer.scheduledNote, /每 60 分钟/);
    const off = runHeartbeat({store, ctx, now: new Date(), scheduled: false, intervalMinutes: 0, speak: null});
    assert.match(off.scheduledNote, /没有开启定时/, '真没开定时时才这么说');
  } finally { store.close(); }
});
