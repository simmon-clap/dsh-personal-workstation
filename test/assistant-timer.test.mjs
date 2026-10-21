/** 开口点**真的会触发吗**（2026-10-22 补，spec/55 P3）。
 *
 *  「注册了一个 5 分钟定时」不等于「到点真会开口」：如果回调没接上、或者判断层永远返回空，
 *  用户看到的是设置页写着"到了 09:30 会开口"，实际一句话没有 —— 又是一种假承诺。
 *
 *  做法与 heartbeat-timer-fires 同一套宿主桩：把 `timer.interval` 的回调抓下来手动触发，
 *  再把全局时钟钉到 09:35，看库里有没有多一条开口记录。
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

const bootPlugin = ({assistant = {residentNode: true, anchors: true}} = {}) => {
 const safeDirectory = mkdtempSync(join(tmpdir(), 'assistant-timer-'));
 const materialised = unwrap(new Config({}));
 const config = {...materialised, dataDirectory: safeDirectory, allowedWorkspaces: ['w'], heartbeat: {intervalMinutes: 0}, assistant};
 resolveConfig(config);
 const captured = [];
 const disposers = [];
 const ctx = {
  effect(fn) { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); },
  get(name) {
   if (name === 'timer') return {
    timeout() { return () => {} },
    interval(callback, delay) { captured.push({callback, delay}); return () => {} },
    throttle(fn) { return fn }, debounce(fn) { return fn },
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

const openCount = directory => {
 const db = new DatabaseSync(join(directory, 'workstation.sqlite'), {readOnly: true});
 try {
  const row = db.prepare("SELECT count(*) c FROM sqlite_master WHERE name='opening'").get();
  if (!row.c) return 0;
  return db.prepare('SELECT count(*) c FROM opening').get().c;
 } finally { db.close(); }
};

/** 把全局时钟钉在某一刻（回调里用的是 `new Date()`，不改它就没法稳定测"到点"）。 */
const withFrozenClock = (moment, fn) => {
 const RealDate = Date;
 class Frozen extends RealDate {
  constructor(...args) { super(...(args.length ? args : [moment])); }
  static now() { return moment.getTime(); }
 }
 globalThis.Date = Frozen;
 try { return fn(); } finally { globalThis.Date = RealDate; }
};

test('常驻节点 + 开口开启：注册了一个 5 分钟的开口检查', () => {
 const booted = bootPlugin();
 try {
  const fiveMinute = booted.captured.filter(item => item.delay === 5 * 60 * 1000);
  assert.equal(fiveMinute.length, 1, '应当有且只有一个 5 分钟的开口检查');
 } finally { booted.cleanup(); }
});

test('到 09:35 触发一次：真的会落一条开口记录', () => {
 const booted = bootPlugin();
 try {
  const timer = booted.captured.find(item => item.delay === 5 * 60 * 1000);
  const before = openCount(booted.safeDirectory);
  withFrozenClock(new Date('2026-10-22T09:35:00+08:00'), () => timer.callback());
  const after = openCount(booted.safeDirectory);
  assert.equal(after, before + 1, '到点触发应当落一条开口记录（这是"它真的开过口"的唯一证据）');
 } finally { booted.cleanup(); }
});

test('不是开口点触发：什么都不写（不许为了"有动作"而开口）', () => {
 const booted = bootPlugin();
 try {
  const timer = booted.captured.find(item => item.delay === 5 * 60 * 1000);
  const before = openCount(booted.safeDirectory);
  withFrozenClock(new Date('2026-10-22T13:00:00+08:00'), () => timer.callback());
  assert.equal(openCount(booted.safeDirectory), before);
 } finally { booted.cleanup(); }
});

test('不是常驻节点：不注册开口检查（承诺不对称：笔记本不说，只同步）', () => {
 const booted = bootPlugin({assistant: {residentNode: false, anchors: true}});
 try {
  assert.equal(booted.captured.filter(item => item.delay === 5 * 60 * 1000).length, 0);
 } finally { booted.cleanup(); }
});

test('关掉开口：仍然不注册（关掉就是关掉，不许偷偷开）', () => {
 const booted = bootPlugin({assistant: {residentNode: true, anchors: false}});
 try {
  assert.equal(booted.captured.filter(item => item.delay === 5 * 60 * 1000).length, 0);
 } finally { booted.cleanup(); }
});

/** 审计与心跳本的行数（"定时真的跑通了"必须能从这里读出来）。 */
const countOf = (directory, sql) => {
 const db = new DatabaseSync(join(directory, 'workstation.sqlite'), {readOnly: true});
 try {
  const exists = db.prepare("SELECT count(*) c FROM sqlite_master WHERE name=?").get(sql.table).c;
  if (!exists) return 0;
  return db.prepare(sql.query).get().c;
 } finally { db.close(); }
};

test('定时跑一次必须留下审计（这正是"传函数当工作区"那个 bug 的回归守卫）', () => {
 const safeDirectory = mkdtempSync(join(tmpdir(), 'assistant-timer-'));
 const materialised = unwrap(new Config({}));
 const config = {...materialised, dataDirectory: safeDirectory, allowedWorkspaces: ['w'], heartbeat: {intervalMinutes: 30}, assistant: {residentNode: false, anchors: false}};
 resolveConfig(config);
 const captured = [], disposers = [];
 const ctx = {
  effect(fn) { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); },
  get(name) {
   if (name === 'timer') return {timeout(){return()=>{}},interval(cb,delay){captured.push({callback:cb,delay});return()=>{}},throttle(fn){return fn},debounce(fn){return fn}};
   return undefined;
  },
  tools: {register() { return () => {} }}, skills: {register() { return () => {} }},
  sessions: {get: () => ({header: {cwd: safeDirectory}})},
  workspaceRegistry: {list: () => [{id: 'w', title: '测试', path: safeDirectory}], get: () => ({id: 'w'})},
  approval: {request: async () => 'denied'},
 };
 apply(ctx, config);
 try {
  const timer = captured.find(item => item.delay === 30 * 60 * 1000);
  assert(timer, '应当注册 30 分钟的心跳定时');
  const before = countOf(safeDirectory, {table: 'audit', query: "SELECT count(*) c FROM audit WHERE event='heartbeat_recorded'"});
  timer.callback();
  const after = countOf(safeDirectory, {table: 'audit', query: "SELECT count(*) c FROM audit WHERE event='heartbeat_recorded'"});
  assert.equal(after, before + 1,
   '定时跑完必须有一条审计；没有审计就说明 ctx.workspace 又传错了（2026-10-22 实测 158 次定时零审计）');
 } finally {
  for (const dispose of disposers) { try { dispose() } catch {} }
  rmSync(safeDirectory, {recursive: true, force: true});
 }
});

test('常驻节点：心跳本按 15 分钟记一笔，且真的写进库', () => {
 const booted = bootPlugin({assistant: {residentNode: true, anchors: false}});
 try {
  const beatTimer = booted.captured.find(item => item.delay === 15 * 60 * 1000);
  assert(beatTimer, '常驻节点应当注册 15 分钟的心跳本');
  // 插件加载时先记一笔（'load'），所以这里只看"触发一次有没有多一笔"。
  const before = countOf(booted.safeDirectory, {table: 'beat', query: 'SELECT count(*) c FROM beat'});
  assert.equal(before, 1, '加载时应当先记一笔，证明心跳本真的接上了');
  beatTimer.callback();
  const after = countOf(booted.safeDirectory, {table: 'beat', query: 'SELECT count(*) c FROM beat'});
  assert.equal(after, before + 1, '触发一次应当多一条心跳本记录');
 } finally { booted.cleanup(); }
});
