import {test} from 'node:test';
import assert from 'node:assert/strict';
import {WorkstationStore} from '../src/store.mjs';
import {graph} from '../src/graph.mjs';
import {readLayout,saveLayout} from '../src/layout.mjs';
const ctx={workspace:'test',actor:'test',canWrite:true};
// 每个用例都用独立内存库：互不影响，也不碰真实库。
function apply(store,list){const batch=store.draft(ctx,{title:'测试数据',changes:list.map(item=>({op:'create',...item}))});return store.commit(ctx,{batchId:batch.id,revision:batch.revision,key:'key:'+batch.id});}
function reject(store,list,code='INVALID'){const batch=store.draft(ctx,{title:'应被拒绝',changes:list.map(item=>({op:'create',...item}))});assert.throws(()=>store.commit(ctx,{batchId:batch.id,revision:batch.revision,key:'bad:'+batch.id}),{code});}

test('organization.defaultRole：自由文本 1–40 字，空串与缺省都表示未分类',()=>{
 const store=new WorkstationStore(':memory:');
 try{
  apply(store,[
   {id:'o1',kind:'organization',data:{title:'机构一',defaultRole:'客户'}},
   {id:'o2',kind:'organization',data:{title:'机构二',defaultRole:''}},
   {id:'o3',kind:'organization',data:{title:'机构三'}},
   {id:'o4',kind:'organization',data:{title:'机构四',defaultRole:'角'.repeat(40)}},
  ]);
  assert.equal(store.get(ctx,'o1').data.defaultRole,'客户');
  // 单一语义：空串 = 未分类，与缺省同义，两者都能存进库。
  assert.equal(store.get(ctx,'o2').data.defaultRole,'');
  assert.equal('defaultRole'in store.get(ctx,'o3').data,false);
  assert.equal(store.get(ctx,'o4').data.defaultRole.length,40);
  reject(store,[{id:'bad-long',kind:'organization',data:{title:'机构',defaultRole:'角'.repeat(41)}}]);
  reject(store,[{id:'bad-type',kind:'organization',data:{title:'机构',defaultRole:42}}]);
  reject(store,[{id:'bad-blank',kind:'organization',data:{title:'机构',defaultRole:'   '}}]);
 }finally{store.close()}
});

test('project.roleTemplate：只认 5 个模板键，缺省=不套模板',()=>{
 const store=new WorkstationStore(':memory:');
 try{
  const keys=['delivery','ecosystem','investment','research','custom'];
  apply(store,keys.map(key=>({id:'p-'+key,kind:'project',data:{title:'项目 '+key,roleTemplate:key}})));
  for(const key of keys)assert.equal(store.get(ctx,'p-'+key).data.roleTemplate,key);
  apply(store,[{id:'p-none',kind:'project',data:{title:'未套模板'}}]);
  assert.equal('roleTemplate'in store.get(ctx,'p-none').data,false);
  reject(store,[{id:'p-bad',kind:'project',data:{title:'项目',roleTemplate:'core'}}]);
  reject(store,[{id:'p-bad-empty',kind:'project',data:{title:'项目',roleTemplate:''}}]);
  reject(store,[{id:'p-bad-type',kind:'project',data:{title:'项目',roleTemplate:1}}]);
 }finally{store.close()}
});

test('project.participants：≤200、只允许两个键、必须写明角色、同一机构只一条',()=>{
 const store=new WorkstationStore(':memory:');
 try{
  apply(store,[{id:'org',kind:'organization',data:{title:'机构'}}]);
  apply(store,[{id:'p-ok',kind:'project',data:{title:'项目',participants:[{organizationId:'org',role:'客户'}]}}]);
  assert.deepEqual(store.get(ctx,'p-ok').data.participants,[{organizationId:'org',role:'客户'}]);
  apply(store,[{id:'p-long-role',kind:'project',data:{title:'角色 40 字',participants:[{organizationId:'org',role:'角'.repeat(40)}]}}]);
  assert.equal(store.get(ctx,'p-long-role').data.participants[0].role.length,40);
  apply(store,[{id:'p-empty',kind:'project',data:{title:'空参与者',participants:[]}}]);
  reject(store,[{id:'p-dup',kind:'project',data:{title:'重复',participants:[{organizationId:'org',role:'客户'},{organizationId:'org',role:'伙伴'}]}}]);
  reject(store,[{id:'p-wordless',kind:'project',data:{title:'缺角色',participants:[{organizationId:'org',role:'   '}]}}]);
  reject(store,[{id:'p-long',kind:'project',data:{title:'角色过长',participants:[{organizationId:'org',role:'角'.repeat(41)}]}}]);
  reject(store,[{id:'p-extra',kind:'project',data:{title:'多键',participants:[{organizationId:'org',role:'客户',note:'x'}]}}]);
  reject(store,[{id:'p-no-org',kind:'project',data:{title:'缺机构',participants:[{organizationId:'',role:'客户'}]}}]);
  reject(store,[{id:'p-many',kind:'project',data:{title:'过多',participants:Array.from({length:201},(_,i)=>({organizationId:'org-'+i,role:'客户'}))}}]);
  reject(store,[{id:'p-not-array',kind:'project',data:{title:'不是数组',participants:{}}}]);
 }finally{store.close()}
});

test('participants 与 project.organizationId 的引用校验（REFERENCE）',()=>{
 const store=new WorkstationStore(':memory:');
 try{
  apply(store,[{id:'live',kind:'organization',data:{title:'在用机构'}},{id:'gone',kind:'organization',data:{title:'将被归档'}}]);
  apply(store,[{id:'p-ref',kind:'project',data:{title:'引用正确的项目',organizationId:'live',participants:[{organizationId:'live',role:'客户'}]}}]);
  reject(store,[{id:'p-missing',kind:'project',data:{title:'坏参与',participants:[{organizationId:'nope',role:'客户'}]}}],'REFERENCE');
  reject(store,[{id:'p-missing-org',kind:'project',data:{title:'坏主责',organizationId:'nope'}}],'REFERENCE');
  // 归档后引用失效：参与机构与主责机构都必须 resolve 到未归档组织
  const archive=store.draft(ctx,{title:'归档机构',changes:[{op:'archive',id:'gone',expectedRevision:1}]});
  store.commit(ctx,{batchId:archive.id,revision:archive.revision,key:'archive:gone'});
  reject(store,[{id:'p-archived',kind:'project',data:{title:'归档参与',participants:[{organizationId:'gone',role:'客户'}]}}],'REFERENCE');
  reject(store,[{id:'p-archived-org',kind:'project',data:{title:'归档主责',organizationId:'gone'}}],'REFERENCE');
  // 未归属：organizationId 可空，'' 表示不指定主责机构
  apply(store,[{id:'p-null',kind:'project',data:{title:'未归属',organizationId:''}}]);
  assert.equal(store.get(ctx,'p-null').data.organizationId,'');
 }finally{store.close()}
});

test('同一机构在两个项目可以扮演不同角色（数据层不冲突）',()=>{
 const store=new WorkstationStore(':memory:');
 try{
  apply(store,[{id:'org',kind:'organization',data:{title:'机构',defaultRole:'客户'}}]);
  apply(store,[
   {id:'p1',kind:'project',data:{title:'项目一',participants:[{organizationId:'org',role:'客户'}]}},
   {id:'p2',kind:'project',data:{title:'项目二',participants:[{organizationId:'org',role:'伙伴'}]}},
  ]);
  assert.equal(store.get(ctx,'p1').data.participants[0].role,'客户');
  assert.equal(store.get(ctx,'p2').data.participants[0].role,'伙伴');
  assert.equal(store.get(ctx,'org').data.defaultRole,'客户');
 }finally{store.close()}
});

test('layout 角色映射：调色板颜色/5 种形状/去重顺序，layout_save 可保存读回',()=>{
 const store=new WorkstationStore(':memory:');
 try{
  apply(store,[{id:'p',kind:'project',data:{title:'项目'}}]);
  const args={view:'ecosystem',revision:0,positions:{p:{x:10,y:20}},viewport:{x:0,y:0,zoom:1},key:'layout:role-1'};
  const roleColors={'客户':'--pal-indigo','伙伴':'--pal-teal-soft'};
  const roleShapes={'客户':'hexagon','伙伴':'circle'};
  const order=['客户','伙伴'];
  const receipt=saveLayout(store,ctx,{...args,roleColors,roleShapes,order});
  assert.equal(saveLayout(store,ctx,{...args,roleColors,roleShapes,order}).id,receipt.id,'同一保存键重复保存要幂等');
  const saved=readLayout(store,ctx,'ecosystem').data;
  assert.deepEqual(saved.roleColors,roleColors);
  assert.deepEqual(saved.roleShapes,roleShapes);
  assert.deepEqual(saved.order,order);
  // 颜色只认调色板变量：hex 与任意颜色名一律拒绝
  assert.throws(()=>saveLayout(store,ctx,{...args,key:'layout:bad-hex',roleColors:{客户:'#ff0000'}}),{code:'INVALID'});
  assert.throws(()=>saveLayout(store,ctx,{...args,key:'layout:bad-name',roleColors:{客户:'red'}}),{code:'INVALID'});
  assert.throws(()=>saveLayout(store,ctx,{...args,key:'layout:bad-shape',roleShapes:{客户:'star'}}),{code:'INVALID'});
  // 每类最多 10 条；顺序要去重、每项 1–40 字
  const eleven=Object.fromEntries(Array.from({length:11},(_,i)=>['角色'+i,'--pal-indigo']));
  assert.throws(()=>saveLayout(store,ctx,{...args,key:'layout:many-colors',roleColors:eleven}),{code:'INVALID'});
  assert.throws(()=>saveLayout(store,ctx,{...args,key:'layout:many-shapes',roleShapes:Object.fromEntries(Object.keys(eleven).map(name=>[name,'square']))}),{code:'INVALID'});
  assert.throws(()=>saveLayout(store,ctx,{...args,key:'layout:many-order',order:Array.from({length:11},(_,i)=>'角色'+i)}),{code:'INVALID'});
  assert.throws(()=>saveLayout(store,ctx,{...args,key:'layout:dup-order',order:['客户','客户']}),{code:'INVALID'});
  assert.throws(()=>saveLayout(store,ctx,{...args,key:'layout:long-order',order:['角'.repeat(41)]}),{code:'INVALID'});
  // 旧布局（不带角色映射）照旧能保存：没传就不写这几个键
  saveLayout(store,ctx,{view:'space',revision:0,positions:{},viewport:{x:0,y:0,zoom:1},key:'layout:plain'});
  const plain=readLayout(store,ctx,'space').data;
  assert.equal('roleColors'in plain,false);
  assert.equal('roleShapes'in plain,false);
  assert.equal('order'in plain,false);
 }finally{store.close()}
});

test('graph 节点返回 defaultRole / roleTemplate / participants / organizationId，主责机构边标题正确',()=>{
 const store=new WorkstationStore(':memory:');
 try{
  apply(store,[
   {id:'org',kind:'organization',data:{title:'机构',defaultRole:'客户'}},
   {id:'person',kind:'person',data:{title:'联系人',organizationId:'org'}},
   {id:'p',kind:'project',data:{title:'项目',roleTemplate:'delivery',participants:[{organizationId:'org',role:'客户'}],organizationId:'org'}},
  ]);
  const g=graph(store,ctx,{});
  const orgNode=g.nodes.find(node=>node.id==='org'),personNode=g.nodes.find(node=>node.id==='person'),projectNode=g.nodes.find(node=>node.id==='p');
  assert.equal(orgNode.defaultRole,'客户');
  assert.equal('defaultRole'in personNode,false);
  assert.equal(projectNode.roleTemplate,'delivery');
  assert.deepEqual(projectNode.participants,[{organizationId:'org',role:'客户'}]);
  assert.equal(projectNode.organizationId,'org');
  // participants 是数组拷贝：改返回值不能改到库里的数据
  projectNode.participants[0].role='被改掉';
  assert.equal(store.get(ctx,'p').data.participants[0].role,'客户');
  // 派生边：项目 organizationId 叫「主责机构」，其它 kind（person.organizationId）仍是「所属组织」
  assert.equal(g.edges.find(edge=>edge.id==='organizationId:p').title,'主责机构');
  assert.equal(g.edges.find(edge=>edge.id==='organizationId:person').title,'所属组织');
 }finally{store.close()}
});

test('旧数据兼容：没有新字段的组织/项目仍能 draft+commit+graph',()=>{
 const store=new WorkstationStore(':memory:');
 try{
  apply(store,[{id:'old-org',kind:'organization',data:{title:'旧机构'}},{id:'old-p',kind:'project',data:{title:'旧项目',partnerId:'old-org'}}]);
  // 再走一轮 update：老数据不带新字段也能保存
  const batch=store.draft(ctx,{title:'改老项目',changes:[{op:'update',id:'old-p',expectedRevision:1,data:{title:'旧项目改名',partnerId:'old-org'}}]});
  store.commit(ctx,{batchId:batch.id,revision:batch.revision,key:'legacy-update'});
  const g=graph(store,ctx,{});
  const orgNode=g.nodes.find(node=>node.id==='old-org'),projectNode=g.nodes.find(node=>node.id==='old-p');
  assert.equal('defaultRole'in orgNode,false);
  assert.equal(projectNode.roleTemplate,null);
  assert.deepEqual(projectNode.participants,[]);
  assert.equal('organizationId'in projectNode,false);
  assert.equal(g.edges.find(edge=>edge.id==='partnerId:old-p').title,'合作方');
 }finally{store.close()}
});

test('参与机构进 references()：机构被项目参与引用时归档/删除会被拦下',()=>{
 const store=new WorkstationStore(':memory:');
 try{
  apply(store,[{id:'org-a',kind:'organization',data:{title:'机构甲'}},{id:'p-join',kind:'project',data:{title:'参与项目',participants:[{organizationId:'org-a',role:'客户'}]}}]);
  const refs=store.references(ctx,'org-a');
  assert.equal(refs.length,1,'组织被参与项目引用时必须出现在 references 里');
  assert.equal(refs[0].id,'p-join');assert.equal(refs[0].field,'participants');
  // 引用存在的机构不能直接归档（与 partnerId 同口径：提交时 resolve 到待归档对象即 REFERENCE）
  const batch=store.draft(ctx,{title:'归档机构',changes:[{op:'archive',id:'org-a',expectedRevision:1}]});
  assert.throws(()=>store.commit(ctx,{batchId:batch.id,revision:batch.revision,key:'archive-org-a'}),{code:'REFERENCE'});
  assert.equal(store.get(ctx,'org-a').archived,false,'被拦下后机构仍是未归档');
 }finally{store.close()}
});

test('Agent 工具 schema 登记 layout 角色映射参数（否则工具通道传不进来）',async()=>{
 const {toolDefinition}=await import('../src/dsh-adapter.mjs');
 const props=toolDefinition({}).parameters.properties;
 for(const key of ['roleColors','roleShapes','order'])assert(props[key],'工具 schema 缺少 '+key);
 const store=new WorkstationStore(':memory:');
 try{
  const registry={get:id=>({id}),resolveByPath:async()=>({id:'w'})};
  const {DshAdapter}=await import('../src/dsh-adapter.mjs');
  const adapter=new DshAdapter({store,sessions:{get:()=>({header:{cwd:'/w'}})},workspaceRegistry:registry,allowedWorkspaces:['w'],approval:{request:async()=>'allowed-once'}});
  const result=await adapter.run({action:'layout_save',view:'ecosystem',revision:0,positions:{},viewport:{x:0,y:0,zoom:1},roleColors:{客户:'--pal-gold'},roleShapes:{客户:'diamond'},order:['客户'],key:'layout-role-1'},{agent:{id:'t'}});
  assert.equal(result.status,'committed');
  const read=await adapter.run({action:'layout_get',view:'ecosystem'},{agent:{id:'t'}});
  assert.equal(read.item.data.roleColors['客户'],'--pal-gold');
 }finally{store.close()}
});
