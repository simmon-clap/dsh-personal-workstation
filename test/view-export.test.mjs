import test from 'node:test';
import assert from 'node:assert/strict';
import {exportViewMarkdown, validateViewDefinition} from '../src/view-spec.mjs';

const base = {
  kind:'view',
  title:'测试项目 · 风险与证据',
  template:'risk-matrix',
  subject:{id:'proj-1',kind:'project',revision:3},
  params:{horizonDays:90},
  dataRefs:['proj-1@3','j-1@2'],
  basis:[{kind:'file',ref:'会议纪要.md@3',quote:'交付风险主要来自接口不稳定'}],
  generatedAt:'2026-10-18T13:40:00+08:00',
  origin:'ai',state:'fresh',actions:['open-subject','save-as-judgment'],
  content:{template:'risk-matrix',dataAt:'2026-10-18T13:39:00+08:00',rows:[
    {id:'j-1',kind:'judgment',title:'接口不稳定',risk:'high',riskLabel:'高',evidenceStrength:'weak',evidenceCount:1,verifiedCount:0,reason:'只有会议口头依据'}
  ]}
};

test('导出 Markdown：标题/出处/数据截至/表格都在，且不改动 view', () => {
  const before = JSON.stringify(base);
  const out = exportViewMarkdown(base);
  assert.match(out.filename, /\.md$/);
  assert.match(out.markdown, /^# 测试项目/m);
  assert.match(out.markdown, /依据 1 条/);
  assert.match(out.markdown, /数据截至：2026-10-18/);
  assert.match(out.markdown, /\| 接口不稳定 \| 高 \|/);
  assert.match(out.markdown, /会议纪要\.md@3/);
  assert.match(out.markdown, /视图不是证据/);
  assert.equal(JSON.stringify(base), before);
});

test('导出前仍按 view v1 校验：无依据的视图拒绝导出', () => {
  const bad = {...base, basis:[]};
  assert.throws(() => exportViewMarkdown(bad), /依据|basis/);
});

test('validateViewDefinition 不接受 content（保存只存定义）', () => {
  assert.throws(() => validateViewDefinition({...base}), /未知或受保护字段/);
});

import {WorkstationStore} from '../src/store.mjs';
import {DshAdapter} from '../src/dsh-adapter.mjs';

test('Agent 链路：adapter 的 view_preview 只读、view_save 只落 draft、view_export 出 Markdown', async () => {
  const store = new WorkstationStore(':memory:');
  const ctx = {workspace:'w', actor:'test', canWrite:true};
  try {
    const setup = store.draft(ctx, {title:'seed', changes:[
      {op:'create', id:'p', kind:'project', data:{title:'项目P', goal:'目标'}},
      {op:'create', id:'j', kind:'judgment', data:{title:'判断J', projectId:'p', evidence:[{kind:'note',ref:'手记@1',quote:'一句话依据'}], validFrom:'2026-10-18', uncertainty:'未核对', status:'current', origin:'user'}}
    ]});
    store.commit(ctx,{batchId:setup.id,revision:1,key:'seed'});
    const adapter = new DshAdapter({
      store,
      sessions:{get:()=>({header:{cwd:'/w'}})},
      workspaceRegistry:{resolveByPath:async()=>({id:'w'})},
      approval:{request:async()=>{throw new Error('read path must not ask approval')}},
      allowedWorkspaces:['w']
    });
    const exec = {agent:{id:'s'},callId:'c'};
    const preview = await adapter.run({action:'view_preview',template:'risk-matrix',subjectId:'p'},exec);
    assert.equal(preview.view.template,'risk-matrix');
    assert.ok(preview.view.basis.length>=1);
    assert.equal(store.inbox(ctx,{status:'draft'}).length,0,'预览不落库');
    const saved = await adapter.run({action:'view_save',template:'risk-matrix',subjectId:'p'},exec);
    assert.ok(saved.batch?.id,'保存返回 draft');
    assert.equal(store.list(ctx,{kind:'view'}).length,0,'保存不直接落库');
    assert.equal(store.inbox(ctx,{status:'draft'}).length,1,'保存进入收件箱待确认');
    const exported = await adapter.run({action:'view_export',viewData:preview.view},exec);
    assert.match(exported.markdown,/^# /m);
    assert.match(exported.markdown,/视图不是证据/);
  } finally { store.close(); }
});
