/** 真定时**真的会触发吗**（2026-10-16 补）。
 *
 *  背景：为了落实宪章第六条「主动」，工作台接上了宿主的 `timer` 服务：
 *  配置 `heartbeat.intervalMinutes > 0` 时按间隔自己醒一次。
 *  但**这条路径从来没被验过** —— 只验过"没接定时时不会自己醒"。
 *  "实现了"和"会触发"是两件事：如果 interval 没注册上、或者回调里抛错被吞掉，
 *  用户看到的是"设置页说已接入定时"，而实际上它永远不醒 —— 正是最该避免的那种假承诺。
 *
 *  做法：用最小宿主桩（与 activation-replay 同一套形状）调 `apply()`，
 *  桩里的 `timer.interval` **把回调抓下来**，然后手动触发它，再查库里有没有留下心跳留痕。
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {apply, resolveConfig, Config} from '../src/index.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const unwrap = value => (value && typeof value.get === 'function' ? value.get() : value);

/** 起一次插件：返回被抓到的定时回调与清理函数。 */
const bootPlugin = ({intervalMinutes = 0} = {}) => {
  const safeDirectory = mkdtempSync(join(tmpdir(), 'heartbeat-timer-'));
  const materialised = unwrap(new Config({}));
  // 注意：`apply()` 收的是**原始配置**（它自己会再解析一次）；传"已解析"的对象会因为
  // 派生键（heartbeatMinutes / integrations 等）被判成"未知工作台配置项" —— 我第一次就这么写错了。
  const config = {...materialised, dataDirectory: safeDirectory, allowedWorkspaces: ['w'], heartbeat: {intervalMinutes}};
  resolveConfig(config);   // 先确认这份配置被接受（拒绝的话 apply 会以另一种方式炸，报错不好懂）
  const captured = [];
  const disposers = [];
  const ctx = {
    effect(fn) { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); },
    get(name) {
      if (name === 'timer') return {
        timeout() { return () => {} },
        interval(callback, delay) { captured.push({callback, delay}); return () => {} },
        throttle(fn) { return fn },
        debounce(fn) { return fn },
      };
      return undefined;
    },
    tools: {register() { return () => {} }},
    skills: {register() { return () => {} }},
    sessions: {get: () => ({header: {cwd: safeDirectory}})},
    workspaceRegistry: {list: () => [{id: 'w', title: '测试', path: safeDirectory}], get: () => ({id: 'w'})},
    approval: {request: async () => 'denied'},
  };
  apply(ctx, config);
  return {captured, safeDirectory, cleanup() { for (const dispose of disposers) { try { dispose() } catch {} } rmSync(safeDirectory, {recursive: true, force: true}) }};
};

const runs = directory => {
  const db = new DatabaseSync(join(directory, 'workstation.sqlite'), {readOnly: true});
  try { return db.prepare('select count(*) c from heartbeat_runs').get().c; } finally { db.close(); }
};

test('intervalMinutes > 0 时**真的注册了定时**，且间隔换算正确（分钟 → 毫秒）', () => {
  const booted = bootPlugin({intervalMinutes: 30});
  try {
    assert.equal(booted.captured.length, 1, '应当注册一个定时');
    assert.equal(booted.captured[0].delay, 30 * 60 * 1000, '30 分钟应当换算成 1800000ms');
  } finally { booted.cleanup(); }
});

test('定时到点**真的会跑心跳并留痕**（不是注册了个空壳）', () => {
  const booted = bootPlugin({intervalMinutes: 30});
  try {
    const before = runs(booted.safeDirectory);
    booted.captured[0].callback();
    const after = runs(booted.safeDirectory);
    assert.equal(after, before + 1, '触发一次定时应当多一条心跳留痕（留痕是"它真的醒过"的唯一证据）');
  } finally { booted.cleanup(); }
});

test('intervalMinutes = 0（默认）时**不注册**任何定时', () => {
  const booted = bootPlugin({intervalMinutes: 0});
  try {
    assert.equal(booted.captured.length, 0, '默认必须是"只有你点它才跑"');
  } finally { booted.cleanup(); }
});

test('定时回调里抛错不会把插件带崩（下一次还会醒）', () => {
  const booted = bootPlugin({intervalMinutes: 30});
  try {
    const callback = booted.captured[0].callback;
    // 把库文件删掉制造失败：回调必须自己吞掉异常，不能抛到宿主
    rmSync(join(booted.safeDirectory, 'workstation.sqlite'), {force: true});
    assert.doesNotThrow(() => callback(), '定时这一跑失败不该影响插件本身');
  } finally { booted.cleanup(); }
});
