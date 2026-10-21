import {test} from 'node:test';
import assert from 'node:assert/strict';
import {WorkstationStore} from '../src/store.mjs';
import {DshAdapter, toolDefinition} from '../src/dsh-adapter.mjs';

/** 「只提交改动字段」（spec/54 D6 / 宪章五）：update 可以带 fields，只把列出的字段合并进旧数据。
 *  这条是「改 2/6 只提交 2」的底层保证：批次里只出现改动字段、回执里只体现改动字段、
 *  其余字段（包括别的窗口刚改过的）不被一起写回去。 */
const ctx={workspace:'w',actor:'test',canWrite:true};
const apply=(store,id,kind,data)=>{const b=store.draft(ctx,{title:'seed',changes:[{op:'create',id,kind,data}]});return store.commit(ctx,{batchId:b.id,revision:1,key:'seed-'+id})};
const seedProject=store=>apply(store,'p1','project',{title:'项目原名',goal:'原目标',description:'原说明',stage:'方案',importance:'high',urgency:'medium'});

test('只提交改动字段：列出的字段合并，其余字段原样保留（数据里带了别的值也不写）',()=>{
 const store=new WorkstationStore(':memory:');
 try{
  seedProject(store);
  // data 里故意带一个"没列进 fields"的 goal：它必须保持不变（模拟并发窗口里别人改过的字段）。
  const b=store.draft(ctx,{title:'改两处',changes:[{op:'update',id:'p1',expectedRevision:1,fields:['title','stage'],data:{title:'项目改名',stage:'验证',goal:'不该被写进去'}}]});
  const receipt=store.commit(ctx,{batchId:b.id,revision:b.revision,key:'patch-1'});
  const after=store.get(ctx,'p1').data;
  assert.equal(after.title,'项目改名');
  assert.equal(after.stage,'验证');
  assert.equal(after.goal,'原目标','没列进 fields 的字段不得被覆盖');
  assert.equal(after.description,'原说明');
  assert.equal(after.importance,'high');
  assert.equal(receipt.after[0].data.goal,'原目标');
 }finally{store.close()}
});

test('回执里的差异只有改动字段（2/6 只体现 2）',()=>{
 const store=new WorkstationStore(':memory:');
 try{
  seedProject(store);
  const b=store.draft(ctx,{title:'改两处',changes:[{op:'update',id:'p1',expectedRevision:1,fields:['title','stage'],data:{title:'项目改名',stage:'验证'}}]});
  store.commit(ctx,{batchId:b.id,revision:b.revision,key:'patch-2'});
  const preview=store.preview(ctx,b.id);
  const diff=preview.diff[0];
  const changed=Object.keys(diff.after).filter(key=>JSON.stringify(diff.after[key])!==JSON.stringify(diff.before.data[key]));
  assert.deepEqual(changed.sort(),['stage','title'],'差异必须只有真正改动的两处');
 }finally{store.close()}
});

test('不带 fields 的老调用仍是整条替换（向后兼容）',()=>{
 const store=new WorkstationStore(':memory:');
 try{
  seedProject(store);
  const b=store.draft(ctx,{title:'整条替换',changes:[{op:'update',id:'p1',expectedRevision:1,data:{title:'只剩标题'}}]});
  store.commit(ctx,{batchId:b.id,revision:b.revision,key:'replace-1'});
  const after=store.get(ctx,'p1').data;
  assert.deepEqual(after,{title:'只剩标题'},'没有 fields 时行为与旧版一致：整条替换');
 }finally{store.close()}
});

test('fields 的非法用法被拦下：空列表/重复/未提供该字段/用在非 update 上',()=>{
 const store=new WorkstationStore(':memory:');
 try{
  seedProject(store);
  for(const bad of [
   {fields:[],data:{title:'x'}},
   {fields:['title','title'],data:{title:'x'}},
   {fields:['goal'],data:{title:'x'}},
  ]){
   assert.throws(()=>store.draft(ctx,{title:'bad',changes:[{op:'update',id:'p1',expectedRevision:1,...bad}]}),{code:'INVALID'});
  }
  assert.throws(()=>store.draft(ctx,{title:'bad',changes:[{op:'create',id:'p2',kind:'project',fields:['title'],data:{title:'x'}}]}),{code:'INVALID'});
 }finally{store.close()}
});

test('撤销一次只改两处的改动：回到改动前的完整数据',()=>{
 const store=new WorkstationStore(':memory:');
 try{
  seedProject(store);
  const b=store.draft(ctx,{title:'改两处',changes:[{op:'update',id:'p1',expectedRevision:1,fields:['title','stage'],data:{title:'项目改名',stage:'验证'}}]});
  const receipt=store.commit(ctx,{batchId:b.id,revision:b.revision,key:'patch-3'});
  const undo=store.undoDraft(ctx,receipt.key);
  store.commit(ctx,{batchId:undo.id,revision:undo.revision,key:'undo-1'});
  const after=store.get(ctx,'p1').data;
  assert.equal(after.title,'项目原名');
  assert.equal(after.stage,'方案');
  assert.equal(after.goal,'原目标');
 }finally{store.close()}
});

test('Agent 工具 schema 登记 fields（否则工具通道传不进「只改这几个字段」）',()=>{
 const props=toolDefinition({}).parameters.properties.changes.items.properties;
 assert.equal(props.fields.type,'array');
 assert.equal(props.fields.items.type,'string');
});

test('真实写入通道：就地改一个字段只提交那一个字段',async()=>{
 const store=new WorkstationStore(':memory:');
 try{
  seedProject(store);
  const adapter=new DshAdapter({store,sessions:{get:()=>({header:{cwd:'/w'}})},workspaceRegistry:{resolveByPath:async()=>({id:'w'}),get:()=>({id:'w'})},allowedWorkspaces:['w'],approval:{request:async()=>'allowed-once'}});
  const exec={agent:{id:'t'}};
  const draft=await adapter.run({action:'draft',title:'改截止',changes:[{op:'update',id:'p1',expectedRevision:1,fields:['stage'],data:{stage:'复盘'}}]},exec);
  await adapter.run({action:'commit',id:draft.id,revision:draft.revision,key:'agent-patch'},exec);
  const after=store.get(ctx,'p1').data;
  assert.equal(after.stage,'复盘');
  assert.equal(after.goal,'原目标');
 }finally{store.close()}
});
