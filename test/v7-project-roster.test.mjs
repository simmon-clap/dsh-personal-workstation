import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from '../dev-deps.mjs';
import {WorkstationStore} from '../src/store.mjs';
import {browserRoute} from '../src/browser-api.mjs';
import {mountProjectViews,rosterGroups,rosterEmpty,filterRosterGroups,projectListInfo,organizationListInfo,personListInfo} from '../prototype/project-view.mjs';

/**
 * 项目页第三段「名册」（2026-10-15）。
 *
 * 这份"分组 + 行"的看法原来长在**关联空间**，用户否掉了那个位置：
 * 「不对，不是在关联空间做列表，是在项目模块做，不然关联空间太乱了」。
 * 所以它搬到项目页当一个页签，另外加了一个**只做前端过滤**的搜索框。
 *
 * 口径（一条都不许放宽）：
 *  ① 关联空间回原样：工具栏只剩 范围 / 聚焦 / 查找 / 更多，没有分段控件、没有列表；
 *  ② 按需读：不切到名册就不发 list 请求；
 *  ③ 读不到不冒充：某一类读失败 → 该组写「读不到X：原因」且不给行，绝不拿空数组冒充"一个都没有"；
 *  ④ 关键信息用已有口径（项目＝projectModels 的同一套；组织＝关联项目数；负责人＝项目/任务数）；
 *  ⑤ 搜索是纯前端的：每敲一个字不再发请求；
 *  ⑥ 某组被筛空 → 整组不显示；三组都空 → 空态且**说清是搜索造成的**（用户 2026-10-12 的教训）；
 *  ⑦ 行是 <button>、行高 48、可点开详情；⑧ 名字只有一个来源：registry.json 的 uiVocabulary.nouns。
 */
const shell=()=>new JSDOM(readFileSync(new URL('../prototype/replica/index.html',import.meta.url),'utf8'));
function bridge(store){
 const route=browserRoute({store,connection:{admit:()=>({peer:{id:'operator'}})},workspaceRegistry:{get:id=>id==='w'?{id}:null,list:()=>[{id:'w',title:'W'}]},allowedWorkspaces:['w']});
 return async(action,data={})=>{const response=await route.fetch(new Request('http://localhost/personal-workstation/api',{method:'POST',headers:{'content-type':'application/json','x-workstation-client':'1'},body:JSON.stringify({...data,action,workspace:'w'})}));const value=await response.json();if(!response.ok)throw Error(value.message||value.error);return value};
}
/** 名册夹具：两个项目 + 一个组织 + 一个联系人 + 一个任务，够覆盖三条关键信息。 */
const rosterSeed=store=>{const ctx={workspace:'w',actor:'t',canWrite:true};
 const batch=store.draft(ctx,{title:'名册夹具',changes:[
  {op:'create',id:'p1',kind:'project',data:{title:'联合验证',stage:'方案',deliverables:[{id:'d1',title:'交付一',done:true},{id:'d2',title:'交付二',done:false}],partnerId:'o1',ownerId:'u1'}},
  {op:'create',id:'p2',kind:'project',data:{title:'云服务合作'}},
  {op:'create',id:'o1',kind:'organization',data:{title:'伙伴 A'}},
  {op:'create',id:'u1',kind:'person',data:{title:'张工'}},
  {op:'create',id:'t1',kind:'task',data:{title:'任务一',projectId:'p1',ownerId:'u1'}},
 ]});
 store.commit(ctx,{batchId:batch.id,revision:1,key:'roster-seed'});
};
/** 每次搜索/切页签都数一次请求：这条口径（纯前端过滤 + 按需读）只能靠数数来证。 */
function countingSend(store){
 const send=bridge(store),calls=[];
 // 名册的读法＝带 kind 且 includeArchived:false；项目页自己的读（无 kind）与筛选栏的读（无 includeArchived）不算。
 // **故意把 kind 吃掉**（像宿主那样只按偏移切片）：名册必须自己按 kind 分，不许指望读取实现照办。
 return {calls,send:async(action,data={})=>{calls.push(action+(data.kind?':'+data.kind:'')+(data.kind&&data.includeArchived===false?'#roster':''));const result=await send(action,data);return action==='list'&&Array.isArray(result?.items)?{...result,items:result.items.slice(data.offset??0,(data.offset??0)+(data.limit??result.items.length))}:result}};
}
const paint=async(rounds=12)=>{for(let index=0;index<rounds;index+=1)await new Promise(resolve=>setImmediate(resolve))};
const headings=panel=>[...panel.querySelectorAll('.rostergroup>h3')].map(node=>node.textContent);
const rowIds=panel=>[...panel.querySelectorAll('.rosterrow')].map(node=>node.dataset.id);

// ── ① 关联空间回到原样（搬家不许在两处各留一份）──────────────────────────────
test('关联空间回到原样：工具栏只剩 范围 / 聚焦 / 查找 / 更多，没有分段控件也没有列表',async()=>{
 const store=new WorkstationStore(':memory:'),dom=shell(),document=dom.window.document,send=bridge(store);rosterSeed(store);
 const {mountSpace}=await import('../prototype/space-view.mjs');
 const view=mountSpace(document,{send,batch:{draft:async()=>{}},open:()=>{},notify:()=>{},projects:[],key:()=>'layout:test'});
 try{
  await view.load();
  const toolbar=document.querySelector('#space .spacebar');
  assert.equal(toolbar.querySelectorAll('.seg').length,0,'关联空间不许再有分段控件');
  assert.equal(toolbar.querySelector('#spaceviewswitch'),null,'画布 ｜ 列表 的切换器必须删干净');
  assert.equal(document.querySelector('#spacelist'),null,'列表面板必须删干净');
  assert.equal(document.querySelector('#space[data-spaceview]'),null,'不许再留 data-spaceview 状态位');
  // 画布自己的控件一个都没少（缩放 / 全图 / 重置布局 / 新建）。
  assert.ok(toolbar.querySelector('#scopefilter'),'范围还在');
  assert.ok(toolbar.querySelector('#projectfocus'),'聚焦项目还在');
  assert.ok(toolbar.querySelector('#graphsearch'),'查找节点还在');
  assert.equal(document.querySelectorAll('#spaceSvg [data-node]').length,5,'画布照常渲染真实对象');
  for(const id of ['less','more','fitspace','resetlayout'])assert.ok(document.querySelector('#'+id),'画布缩放/适配控件还在：'+id);
 }finally{view.dispose();store.close();dom.window.close()}
});
test('反回归：列表相关的那一套东西不许再从任何地方长回来',async()=>{
 const sources=['space-view.mjs','project-view.mjs','v7-workbench.css'];
 const text=Object.fromEntries(sources.map(name=>[name,readFileSync(new URL('../prototype/'+name,import.meta.url),'utf8')]));
 for(const name of ['space-view.mjs','v7-workbench.css']){
  assert.equal(/spacelist|spaceviewswitch|spaceview/i.test(text[name]),false,name+' 里不许再有列表那一套的选择器/id');
  assert.equal(/listGroupTitles|spaceListGroups|spaceListEmpty|projectListInfo|organizationListInfo|personListInfo/.test(text[name]),false,name+' 里不许再留列表的读数实现（搬走就是搬走）');
 }
 // 名册只住一个地方：项目页。
 assert.match(text['project-view.mjs'],/rosterGroupTitles/,'名册的实现在项目页');
});

// ── ② 名册：分组 + 行，关键信息用已有口径 ────────────────────────────────────
test('名册：三组按 项目 / 组织 / 负责人 罗列，行给的是项目页同一套口径',async()=>{
 const store=new WorkstationStore(':memory:'),dom=shell(),document=dom.window.document,{send,calls}=countingSend(store);rosterSeed(store);
 const opened=[];
 const view=await mountProjectViews(document,send,id=>opened.push(id),{onCreate:()=>{}});
 try{
  const tabs=[...document.querySelectorAll('#projecttabs [data-pmode]')];
  assert.deepEqual(tabs.map(node=>node.textContent),['项目组合','时间路线图','名册'],'项目页要有三个分段，且顺序固定');
  assert.deepEqual(tabs.map(node=>node.dataset.pmode),['portfolio','plan','roster']);
  const panel=document.querySelector('.projectroster');
  assert.ok(panel,'名册挂在项目页上');
  assert.equal(panel.hidden,true,'默认仍停在项目组合');
  // 名册自己的读法是带 includeArchived 的 list；项目页的筛选栏也会读 list（读下拉选项），
  // 所以这里数的必须是**名册的**那一种，否则会把筛选栏的两次读算到名册头上。
  const rosterReads=()=>calls.filter(call=>call.endsWith('#roster')).length;
  assert.equal(rosterReads(),0,'没切到名册就不发 list 请求（不为可能要看而提前读数据）');
  tabs[2].click();
  await paint();
  assert.equal(panel.hidden,false,'切到名册要看得见');
  assert.equal(tabs[2].getAttribute('aria-pressed'),'true');
  assert.match(document.querySelector('#projectsbody').innerHTML,/projectstrip/,'切到名册不动项目组合那一份内容');
  assert.deepEqual(headings(panel),['项目 · 2 个','组织 · 1 个','负责人 · 1 个']);
  const rows=[...panel.querySelectorAll('.rosterrow')];
  assert.equal(rows.length,4,'三类对象都要列出来');
  // 名册只列这三类：资料 / 任务 / 事务混进来时，点它们只会弹「项目已归档或不可用」（实测）。
  assert.deepEqual([...new Set(rows.map(row=>row.dataset.kind))].sort(),['organization','person','project'],'名册里不许出现这三类以外的对象');
  const rowOf=id=>rows.find(row=>row.dataset.id===id);
  assert.equal(rowOf('p1').querySelector('strong').textContent,'联合验证');
  assert.equal(rowOf('p1').querySelector('small').textContent,'阶段：方案 · 交付 1/2 项','项目行用 projectModels 的同一套口径');
  assert.equal(rowOf('p2').querySelector('small').textContent,'阶段未记录 · 交付项未记录');
  assert.equal(rowOf('o1').querySelector('small').textContent,'关联 1 个项目');
  assert.equal(rowOf('u1').querySelector('small').textContent,'负责 1 个项目 · 1 个任务');
  for(const row of rows){
   assert.equal(row.tagName,'BUTTON','行必须可点、可 Tab（不是 div）');
   // 每一行都要挂上"打开详情"那条通路（onOpen 由页面传进来）——漏接一行就是一个假按钮。
   assert.equal(typeof row.onclick,'function','行没有绑上打开详情的通路：'+row.dataset.id);
   assert.ok(row.querySelector('use').getAttribute('href').startsWith('#i-'),'行的图标来自 VI 图标集');
   assert.match(row.getAttribute('aria-label'),/打开详情$/,'行要能读出来是干什么的');
  }
  rowOf('p1').click();
  assert.deepEqual(opened,['p1'],'点一行＝打开这条记录的详情');
  // 切回另外两段都要正常（搬家不许弄坏原来那两段）。
  tabs[1].click();
  await paint();
  assert.equal(panel.hidden,true,'切到时间路线图，名册收起');
  assert.ok(document.querySelector('#projectsbody .gantt')||document.querySelector('#projectsbody .v7-empty'),'时间路线图照常渲染');
  tabs[0].click();
  await paint();
  assert.ok(document.querySelector('#projectsbody .projectstrip [data-project]'),'切回项目组合照常渲染');
  assert.deepEqual(opened,['p1'],'切页签不许顺手打开详情');
 }finally{view.dispose();store.close();dom.window.close()}
});
test('名册的关键信息：读不到的那一半如实写"未记录"，不拿 0 冒充',()=>{
 const project={id:'p1',data:{title:'联合验证',stage:'方案',deliverables:[{id:'d1',done:true},{id:'d2',done:false}]}};
 const bare={id:'p2',data:{title:'云服务合作'}};
 const models=[{id:'p1',stageLabel:'方案',progressLabel:'1/2',total:2,partnerId:'o1',ownerId:'u1'},{id:'p2',stageLabel:'阶段未设置',progressLabel:'尚未设置',total:0,partnerId:'',ownerId:''}];
 assert.equal(projectListInfo(models[0]),'阶段：方案 · 交付 1/2 项');
 assert.equal(projectListInfo(models[1]),'阶段未记录 · 交付项未记录');
 assert.equal(projectListInfo(undefined),'阶段未记录 · 交付项未记录');
 const organization={id:'o1',data:{title:'伙伴 A'}};
 assert.equal(organizationListInfo(organization,[{id:'p1',data:{partnerId:'o1'}},bare]),'关联 1 个项目');
 assert.equal(organizationListInfo(organization,[bare]),'还没有关联项目');
 assert.equal(organizationListInfo(organization,[],{projectsRead:false}),'关联项目数未记录','项目清单没读到就不拿 0 冒充"没有关联项目"');
 const person={id:'u1',data:{title:'张工'}};
 const projects=[{id:'p1',data:{ownerId:'u1'}},bare];
 const tasks=[{id:'t1',data:{ownerId:'u1'}},{id:'t2',data:{}}];
 assert.equal(personListInfo(person,projects,tasks),'负责 1 个项目 · 1 个任务');
 assert.equal(personListInfo(person,projects,[],{tasksRead:false}),'负责 1 个项目 · 任务数未记录','一半读不到就标一半');
 assert.equal(personListInfo(person,[],[],{projectsRead:false,tasksRead:false}),'负责的项目数未记录 · 任务数未记录');
 assert.equal(personListInfo(person,[],[],{}),'还没有负责的项目或任务');
});

// ── ③ 读不到不冒充 + 名字只有一个来源 ───────────────────────────────────────
test('名册分组：读不到的类不给行、不冒充"这一类一个都没有"',()=>{
 const groups=rosterGroups({
  projects:[{id:'p1',stageLabel:'方案',progressLabel:'1/2',total:2}],organizations:[],persons:[{id:'u1',data:{title:'张工'}}],tasks:[],
  reads:{project:{ok:true},organization:{ok:false,reason:'服务暂时不可用'},person:{ok:true},task:{ok:true}},
 });
 assert.deepEqual(groups.map(group=>group.title),['项目','组织','负责人']);
 // 名字只有**一个来源**：spec/registry.json 的 uiVocabulary.nouns。
 // 加这条是因为 2026-10-15 发现同一个对象有三个名字（注册表"机构"、界面"组织"、列表"企业"），
 // 违反 03 §7 禁造词与 VI V9「唯一来源」。以后改名字必须改注册表，改一处就够。
 {const registry=JSON.parse(readFileSync(new URL('../../spec/registry.json',import.meta.url),'utf8'));
  const nouns=registry.uiVocabulary.nouns;
  // 注册表登记的是**对象名**；名册标题里混了**角色名**，两者不是一回事：
  //   · 项目 / 组织 —— 对象名，必须在注册表里
  //   · 负责人 —— **角色**（这个人对这个项目/任务负责），对象本身叫「联系人」。
  //     一个人可以是联系人但不是任何事的负责人，所以这里用角色词是准确的，不改成「联系人」。
  const ROLE_LABELS=new Set(['负责人']);
  for(const title of groups.map(group=>group.title)){
   if(ROLE_LABELS.has(title))continue;
   assert.ok(nouns.includes(title),'分组标题「'+title+'」要么是注册表登记的对象名，要么在 ROLE_LABELS 里写明理由（登记的是：'+nouns.join('、')+'）');
  }}
 assert.equal(groups[0].read,true);
 assert.equal(groups[1].read,false);
 assert.equal(groups[1].rows.length,0,'读不到就不给行');
 assert.equal(groups[1].reason,'服务暂时不可用');
 assert.equal(groups[2].rows[0].info,'还没有负责的项目或任务');
 // 三类都读到、且都没有对象时才是"真的空"；有读失败时不许给空态。
 assert.equal(rosterEmpty(rosterGroups({})),true);
 assert.equal(rosterEmpty(groups),false);
 assert.equal(rosterEmpty(rosterGroups({reads:{person:{ok:false,reason:'读不到'}}})),false);
});
test('名册：组织那一类读失败时如实写「读不到组织：原因」，另外两类照常列',async()=>{
 const store=new WorkstationStore(':memory:'),dom=shell(),document=dom.window.document,send=bridge(store);
 rosterSeed(store);
 const failing=async(action,data={})=>{if(action==='list'&&data.kind==='organization')throw Error('服务暂时不可用');return send(action,data)};
 const view=await mountProjectViews(document,failing,()=>{});
 try{
  document.querySelector('#projecttabs [data-pmode="roster"]').click();
  await paint();
  const panel=document.querySelector('.projectroster');
  assert.equal(panel.querySelector('.v7-empty'),null,'读失败不是"没有对象"，不许给空态');
  assert.deepEqual(headings(panel),['项目 · 2 个','组织 · 没读到','负责人 · 1 个']);
  assert.match(panel.textContent,/读不到组织：服务暂时不可用/);
  assert.deepEqual(rowIds(panel).includes('o1'),false,'读不到就别编行');
 }finally{view.dispose();store.close();dom.window.close()}
});
test('名册：任务读失败时负责人写「任务数未记录」，不拿 0 冒充',async()=>{
 const store=new WorkstationStore(':memory:'),dom=shell(),document=dom.window.document,send=bridge(store);
 rosterSeed(store);
 const failing=async(action,data={})=>{if(action==='list'&&data.kind==='task')throw Error('任务清单读不到');return send(action,data)};
 const view=await mountProjectViews(document,failing,()=>{});
 try{
  document.querySelector('#projecttabs [data-pmode="roster"]').click();
  await paint();
  const panel=document.querySelector('.projectroster');
  const person=[...panel.querySelectorAll('.rosterrow')].find(row=>row.dataset.id==='u1');
  assert.equal(person.querySelector('small').textContent,'负责 1 个项目 · 任务数未记录');
 }finally{view.dispose();store.close();dom.window.close()}
});

// ── ④ 搜索：纯前端、空组消失、三组都空说清是搜索造成的、清空恢复 ─────────────
test('搜索是纯前端的：输入不发请求，某组被筛空就整组不显示',async()=>{
 const store=new WorkstationStore(':memory:'),dom=shell(),document=dom.window.document,{send,calls}=countingSend(store);
 rosterSeed(store);
 const view=await mountProjectViews(document,send,()=>{});
 try{
  document.querySelector('#projecttabs [data-pmode="roster"]').click();
  await paint();
  const panel=document.querySelector('.projectroster');
  const input=panel.querySelector('input[type="search"]');
  assert.ok(input,'名册顶部要有一个搜索框');
  assert.equal(input.getAttribute('aria-label'),'按名称搜索项目、组织与负责人');
  assert.ok(input.getAttribute('aria-label'),'搜索框必须有无障碍名字');
  assert.match(input.getAttribute('placeholder'),/搜索/);
  const rosterReads=()=>calls.filter(call=>call.endsWith('#roster')).length;
  const before=rosterReads();
  assert(before>0,'切到名册才读数据');
  const type=async value=>{input.value=value;input.dispatchEvent(new dom.window.Event('input',{bubbles:true}));await paint(2)};
  await type('联合');
  assert.deepEqual(rowIds(panel),['p1'],'只剩匹配的那一行');
  assert.deepEqual(headings(panel),['项目 · 1 个'],'被筛空的组整组不显示（不留空组）');
  assert.equal(rosterReads(),before,'每敲一个字都不许再发请求（纯前端过滤）');
  await type('张');
  assert.deepEqual(rowIds(panel),['u1'],'按负责人名称也能搜到');
  assert.deepEqual(headings(panel),['负责人 · 1 个']);
  // 一个不存在的词 → 三组都空 → 空态，且必须说清是搜索造成的
  await type('不存在的对象名');
  assert.equal(rowIds(panel).length,0);
  const empty=panel.querySelector('.v7-empty');
  assert.ok(empty,'三组都被筛空要给空态（简笔画 + 一句状态 + 一个下一步）');
  assert.match(empty.querySelector('img').getAttribute('src'),/illustrations\/connections\.svg$/);
  assert.match(empty.querySelector('h3').textContent,/不存在的对象名/,'状态里要说清是哪个词把它筛空的');
  assert.match(empty.querySelector('p').textContent,/搜索只按名称匹配|清空搜索/,'要说明是搜索造成的');
  assert.equal(rosterReads(),before,'筛空了也不许重新发请求');
  // 搜索框按回车：不许把第一行当成"隐式提交"点开（搜索没有要提交的东西）。
  input.value='联合';input.dispatchEvent(new dom.window.Event('input',{bubbles:true}));
  input.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
  await paint(2);
  assert.equal(input.value,'联合','回车不改变搜索词');
  // 清空 → 全部回来
  await type('');
  assert.deepEqual(rowIds(panel),['p1','p2','o1','u1'],'清空搜索恢复全部');
  assert.deepEqual(headings(panel),['项目 · 2 个','组织 · 1 个','负责人 · 1 个']);
  assert.equal(panel.querySelector('.v7-empty'),null);
  // 大小写与前后空格不算差异；匹配的是名称，不是那句说明
  await type('  联合  ');
  assert.deepEqual(rowIds(panel),['p1'],'前后空格要被忽略');
  await type('方案');
  assert.equal(panel.querySelector('.v7-empty')!==null,true,'搜的是名称不是说明行（"阶段：方案"不该被命中）');
 }finally{view.dispose();store.close();dom.window.close()}
});
test('过滤函数：空组消失、读失败的组留着（它还要说"读不到"）、名称匹配不分大小写',()=>{
 const groups=rosterGroups({
  projects:[{id:'p1',name:'联合验证',stageLabel:'方案',progressLabel:'1/2',total:2},{id:'p2',name:'云服务合作',stageLabel:'阶段未设置',progressLabel:'尚未设置',total:0}],
  organizations:[{id:'o1',data:{title:'伙伴 A'}}],persons:[],tasks:[],
  reads:{organization:{ok:false,reason:'服务暂时不可用'}},
 });
 const filtered=filterRosterGroups(groups,'云服务');
 // 被筛空、且**读到了**的组整组消失；组织那一组是读失败（没有行，但必须留着说"读不到"）。
 assert.deepEqual(filtered.map(group=>group.kind),['project','organization']);
 assert.deepEqual(filtered[0].rows.map(row=>row.id),['p2']);
 // 读失败的那一组没有行，但必须留着 —— 否则界面会从"读不到组织"变成"没有组织"，那是撒谎。
 const kept=filterRosterGroups(groups,'不存在的名字');
 assert.deepEqual(kept.map(group=>group.kind),['organization'],'读失败的组即使没有行也要留着，读到的空组要消失');
 assert.equal(kept[0].read,false);
 assert.deepEqual(filterRosterGroups(groups,'').map(group=>group.kind),['project','organization','person'],'空搜索＝不过滤');
 assert.deepEqual(filterRosterGroups(groups,'伙伴 A').map(group=>group.kind),['organization']);
});
test('名册为空（三类都读到、一个对象都没有）时给空态；没有新建通路就不给假按钮',async()=>{
 const store=new WorkstationStore(':memory:'),dom=shell(),document=dom.window.document,send=bridge(store);
 let created=0;
 const view=await mountProjectViews(document,send,()=>{},{onCreate:()=>{created+=1}});
 try{
  document.querySelector('#projecttabs [data-pmode="roster"]').click();
  await paint();
  const panel=document.querySelector('.projectroster');
  const empty=panel.querySelector('.v7-empty');
  assert.ok(empty,'没有对象时必须给空态，不许只放一句"暂无"');
  assert.match(empty.querySelector('h3').textContent,/还没有/);
  assert.ok(empty.querySelector('p').textContent.length>8,'空态要有一句状态说明');
  empty.querySelector('.btn').click();
  assert.equal(created,1,'空态的下一步必须真的能点');
 }finally{view.dispose();store.close();dom.window.close()}
 const bare=new WorkstationStore(':memory:'),bareDom=shell(),bareDocument=bareDom.window.document;
 const noCreate=await mountProjectViews(bareDocument,bridge(bare),()=>{});
 try{
  bareDocument.querySelector('#projecttabs [data-pmode="roster"]').click();
  await paint();
  const empty=bareDocument.querySelector('.projectroster .v7-empty');
  assert.ok(empty,'没有对象时同样要给空态');
  assert.equal(empty.querySelector('.btn'),null,'没有新建通路就不给按钮（做不到的按钮比没有按钮更坏）');
 }finally{noCreate.dispose();bare.close();bareDom.window.close()}
});

// ── ⑤ 离开项目页时名册要收起来（它挂在文档上，不跟着 .view 一起隐藏）────────
test('切到别的页面时名册收起来；回到项目页还停在离开前那一段',async()=>{
 const store=new WorkstationStore(':memory:'),dom=shell(),document=dom.window.document,send=bridge(store);
 rosterSeed(store);
 const view=await mountProjectViews(document,send,()=>{});
 try{
  document.querySelector('#projecttabs [data-pmode="roster"]').click();
  await paint();
  const panel=document.querySelector('.projectroster');
  assert.equal(panel.hidden,false);
  document.querySelector('#projects').classList.remove('active');
  document.querySelector('#space').classList.add('active');
  await paint(2);
  assert.equal(panel.hidden,true,'离开项目页时名册不许留在别人的页面上');
  document.querySelector('#space').classList.remove('active');
  document.querySelector('#projects').classList.add('active');
  await paint(2);
  assert.equal(panel.hidden,false,'回到项目页还停在名册那一段');
  assert.equal(document.querySelector('#projecttabs [data-pmode="roster"]').getAttribute('aria-pressed'),'true');
 }finally{view.dispose();store.close();dom.window.close()}
});
