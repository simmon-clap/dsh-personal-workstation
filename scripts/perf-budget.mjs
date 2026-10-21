#!/usr/bin/env node
/** 画布性能预算（A4/A5，synthetic 数据；不碰真实库、不写业务数据）。
 *
 *  为什么要它：CV-10 要求「渐进加载/聚合/性能预算，不无限全量」。真实库现在只有 60 个机构，
 *  但用户迟早会到几百个对象；这里用**合成数据**量 100 / 500 节点下的读取与结构排版耗时，
 *  给出可复现的预算证据与天花板（超过就停手查回归，而不是等用户觉得卡）。
 *
 *  诚实边界：数字是**本机实测**，不是性能承诺；数据是合成的（不来自真实工作台）。
 *  用法：node scripts/perf-budget.mjs   → 打印表格 + 写 ../../spec/perf-budget-20261021.json
 */
import {writeFileSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {WorkstationStore} from '../src/store.mjs';
import {graph, searchNodes} from '../src/graph.mjs';
import {classify, expandLayout, fitRect} from '../prototype/ecosystem-layout.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, '..', '..', 'spec', 'perf-budget-20261021.json');
const ctx = {workspace: 'w', actor: 'perf', canWrite: true};
const CEILING_MS = 2000; // 超过就说明有量级回归（不是精确阈值，是"明显不正常"的天花板）

function seed(store, total) {
  const organizations = Math.round(total * 0.3), projects = Math.round(total * 0.2);
  const tasks = total - organizations - projects;
  const roles = ['客户', '伙伴', '供应', '研究政策', '标准行业', '资本渠道', '竞争替代', ''];
  const changes = [];
  for (let i = 0; i < organizations; i += 1) changes.push({op: 'create', id: 'org-' + i, kind: 'organization', data: {title: '机构 ' + i, ...(roles[i % roles.length] ? {defaultRole: roles[i % roles.length]} : {})}});
  for (let i = 0; i < projects; i += 1) changes.push({op: 'create', id: 'proj-' + i, kind: 'project', data: {title: '项目 ' + i, stage: ['接触', '需求', '方案', '验证', '复盘'][i % 5], ...(i % 3 ? {organizationId: 'org-' + (i % organizations)} : {}), roleTemplate: i % 2 ? 'delivery' : 'ecosystem', participants: [{organizationId: 'org-' + (i % organizations), role: roles[i % (roles.length - 1)]}]}});
  for (let i = 0; i < tasks; i += 1) changes.push({op: 'create', id: 'task-' + i, kind: 'task', data: {title: '任务 ' + i, status: ['todo', 'waiting', 'in_progress', 'done'][i % 4], projectId: 'proj-' + (i % projects), steps: [{id: 's1', title: '步骤', done: i % 2 === 0}]}});
  for (let i = 0; i < 100; i += 1) changes.push({op: 'create', id: 'rel-' + i, kind: 'relation', data: {title: '关联 ' + i, from: 'proj-' + (i % projects), to: 'org-' + ((i * 7) % organizations), status: i % 3 ? 'confirmed' : 'suggested', evidence: '合成证据'}});
  for (let offset = 0; offset < changes.length; offset += 100) {
    const slice = changes.slice(offset, offset + 100);
    const batch = store.draft(ctx, {title: 'perf seed ' + offset, changes: slice});
    store.commit(ctx, {batchId: batch.id, revision: batch.revision, key: 'perf-' + offset});
  }
}

const time = (run) => {
  const started = process.hrtime.bigint();
  const value = run();
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  return {ms: Math.round(ms * 100) / 100, value};
};

const report = {capturedAt: new Date().toISOString(), kind: 'synthetic', machine: process.arch + '/' + process.platform, node: process.version, ceilingMs: CEILING_MS, runs: []};
for (const total of [100, 500]) {
  const store = new WorkstationStore(':memory:');
  try {
    seed(store, total);
    const graphRun = time(() => graph(store, ctx, {limit: 250, offset: 0}));
    const listRun = time(() => store.list(ctx, {limit: 1000}));
    const nodes = listRun.value.filter(item => !['relation', 'layout', 'view'].includes(item.kind)).map(item => ({id: item.id, kind: item.kind, title: item.data.title, defaultRole: item.data.defaultRole, roleTemplate: item.data.roleTemplate, participants: item.data.participants, organizationId: item.data.organizationId, projectId: item.data.projectId}));
    const edges = graphRun.value.relations.map(relation => ({id: relation.id, from: relation.from, to: relation.to, status: relation.status}));
    const classifyRun = time(() => classify({nodes, scope: 'all'}));
    const layoutRun = time(() => {
      const buckets = classifyRun.value.buckets;
      let x = 0;
      const positions = {};
      for (const bucket of buckets) { let y = 64; for (const id of bucket.roleIds) { positions[id] = {x, y}; y += 100; } x += 320; }
      return positions;
    });
    const fitRun = time(() => fitRect({rects: [{x: 0, y: 0, w: 320 * 10, h: 100 * 20}], viewport: {w: 1440, h: 900}}));
    const bodySize = Buffer.byteLength(JSON.stringify(graphRun.value.nodes), 'utf8');
    report.runs.push({nodes: total, entities: listRun.value.length, graph: {ms: graphRun.ms, pageNodes: graphRun.value.nodes.length, total: graphRun.value.total, edges: graphRun.value.edges.length, payloadBytes: bodySize}, classifyMs: classifyRun.ms, layoutMs: layoutRun.ms, fitMs: fitRun.ms, buckets: classifyRun.value.buckets.length, overCeiling: graphRun.ms > CEILING_MS || classifyRun.ms > CEILING_MS});
    const searchRun = time(() => searchNodes(store, ctx, {query: '机构 1', limit: 30}));
    report.runs.at(-1).searchMs = searchRun.ms;
  } finally { store.close(); }
}
writeFileSync(OUT, JSON.stringify(report, null, 1));
for (const run of report.runs) {
  console.log('节点 ' + run.nodes + ' · 实体 ' + run.entities + ' · graph ' + run.graph.ms + 'ms（首屏 ' + run.graph.pageNodes + '/' + run.graph.total + '，' + Math.round(run.graph.payloadBytes / 1024) + 'KB）· classify ' + run.classifyMs + 'ms · 排版 ' + run.layoutMs + 'ms · fit ' + run.fitMs + 'ms · 搜索 ' + run.searchMs + 'ms · ' + run.buckets + ' 类');
}
const over = report.runs.filter(run => run.overCeiling);
console.log(over.length ? 'FAIL: 有量级回归（超过 ' + CEILING_MS + 'ms 天花板）' : 'PASS: 100/500 节点都在预算天花板内（' + CEILING_MS + 'ms），明细写入 ' + OUT);
process.exit(over.length ? 1 : 0);
