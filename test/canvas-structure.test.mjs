import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from '../dev-deps.mjs';
import {WorkstationStore} from '../src/store.mjs';
import {browserRoute} from '../src/browser-api.mjs';
import {mountSpace} from '../prototype/space-view-v5.mjs';

/** 结构态（A2 / spec/54 §1·§2）：按关系角色分组 + 原地展开 + 镜头。
 *  这些测试用 jsdom 量**真实的 DOM 与真实数据**，不是截图；量的是用户看到的行为：
 *  单击原地长出子卡、不换页没有路由、其它节点仍在、一次只展开一个分支、Esc 收起、双击看详情。 */
const shell=()=>new JSDOM(readFileSync(new URL('../prototype/replica/index.html',import.meta.url),'utf8'),{url:'http://127.0.0.1:5599/personal-workstation'});
function bridge(store){
 const route=browserRoute({store,connection:{admit:()=>({peer:{id:'operator'}})},workspaceRegistry:{get:id=>id==='w'?{id}:null,list:()=>[{id:'w',title:'W'}]},allowedWorkspaces:['w']});
 return async(action,data={})=>{const response=await route.fetch(new Request('http://localhost/personal-workstation/api',{method:'POST',headers:{'content-type':'application/json','x-workstation-client':'1'},body:JSON.stringify({...data,action,workspace:'w'})}));const value=await response.json();if(!response.ok)throw Error(value.message||value.error);return value};
}
/** 真实数据形状：4 个机构（3 个分类、1 个未分类）、4 个项目（主责/参与/未归属/只有旧 partnerId）、2 个任务。 */
const seed=store=>{const ctx={workspace:'w',actor:'t',canWrite:true};const commit=(changes,key)=>{const b=store.draft(ctx,{title:key,changes});return store.commit(ctx,{batchId:b.id,revision:1,key})};
 commit([
  {op:'create',id:'o1',kind:'organization',data:{title:'甲方机构',defaultRole:'客户'}},
  {op:'create',id:'o2',kind:'organization',data:{title:'伙伴机构',defaultRole:'伙伴'}},
  {op:'create',id:'o3',kind:'organization',data:{title:'未分类机构'}},
  {op:'create',id:'o4',kind:'organization',data:{title:'旧合作方机构'}},
  {op:'create',id:'p1',kind:'project',data:{title:'主责项目',organizationId:'o1'}},
  {op:'create',id:'p2',kind:'project',data:{title:'参与项目',participants:[{organizationId:'o2',role:'伙伴'}]}},
  {op:'create',id:'p3',kind:'project',data:{title:'未归属项目'}},
  {op:'create',id:'p4',kind:'project',data:{title:'旧合作方项目',partnerId:'o4'}},
  {op:'create',id:'t1',kind:'task',data:{title:'任务一',projectId:'p1'}},
  {op:'create',id:'t2',kind:'task',data:{title:'任务二',projectId:'p2'}},
 ],'seed')};
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
const pointer=(dom,document,target,type)=>{const event=new dom.window.MouseEvent(type,{bubbles:true,button:0,clientX:0,clientY:0});Object.defineProperty(event,'pointerId',{value:1});target.dispatchEvent(event)};
function click(dom,document,node){pointer(dom,document,node,'pointerdown');pointer(dom,document,node,'pointerup')}
function doubleClick(dom,document,node){node.dispatchEvent(new dom.window.MouseEvent('dblclick',{bubbles:true,cancelable:true}))}
const nodeEl=document=>id=>document.querySelector('#spaceSvg [data-node="'+id+'"]');

test('结构态是画布默认范围：按关系角色分组，未分类/未归属如实分列',async()=>{
 const store=new WorkstationStore(':memory:'),dom=shell(),document=dom.window.document,ns=nodeEl(document),send=bridge(store);seed(store);
 const view=mountSpace(document,{send,batch:{draft:async()=>{}},open:()=>{},notify:()=>{},projects:[],key:()=>'layout:test'});
 try{
  await view.load();
  const svg=document.querySelector('#spaceSvg');
  assert.equal(svg.dataset.canvasMode,'structure','默认范围必须是结构态（D8）');
  // 角色列：真实角色名成为列头；未分类与未归属各有一列
  const buckets=[...svg.querySelectorAll('[data-bucket]')].map(node=>node.dataset.bucket);
  assert.deepEqual(buckets,['客户','伙伴','unassigned','unclassified'],'桶顺序：角色（模板顺序）→ 未归属 → 未分类永远最后');
  const text=svg.textContent;
  assert.match(text,/客户 · 1 个机构/);assert.match(text,/未分类 · 2 个机构/);
  assert.match(text,/未归属 · 2 个项目/,'旧数据里只有 partnerId 的项目也必须如实出现在「未归属」，不能消失');
  // 结构层只画机构 + 未归属项目；项目/任务要展开后才出现
  assert.equal(svg.querySelectorAll('[data-node]').length,6);
  assert.equal(ns('o1').dataset.density,'canvasNode','画布卡用紧凑变体');
  assert(ns('o1').querySelector('.roleshape'),'角色必须有形状徽标（颜色不单独承担区分）');
  assert.equal(ns('p1'),null,'被主责的项目不先画出来，等单击机构后原地展开');
  assert.equal(store.list({workspace:'w',actor:'t'},{kind:'layout'}).length,0,'只看不写布局');
  assert.equal(dom.window.location.href,'http://127.0.0.1:5599/personal-workstation','画布不许改地址');
 }finally{view.dispose();store.close();dom.window.close()}
});

test('单击机构在原地展开项目；不换页、不改路由、不移动父卡、其它节点仍在',async()=>{
 const store=new WorkstationStore(':memory:'),dom=shell(),document=dom.window.document,ns=nodeEl(document),send=bridge(store);seed(store);
 const view=mountSpace(document,{send,batch:{draft:async()=>{}},open:()=>{},notify:()=>{},projects:[],key:()=>'layout:test'});
 try{
  await view.load();
  const svg=document.querySelector('#spaceSvg'),urlBefore=dom.window.location.href;
  const parentBefore=ns('o1').getAttribute('transform');
  const topLevel=svg.querySelectorAll('[data-node]').length;
  click(dom,document,ns('o1'));
  assert.equal(svg.querySelectorAll('[data-node]').length,topLevel+1,'展开后子卡出现在同一张画布上');
  assert.equal(svg.querySelectorAll('[data-branch-child]').length,1);
  assert.match(svg.querySelector('[data-branch-child]').textContent,/主责项目/);
  assert.equal(ns('o1').dataset.expanded,'1');
  assert.equal(ns('o1').getAttribute('transform'),parentBefore,'不移动用户原有节点位置');
  assert(svg.querySelectorAll('[data-dim="1"]').length>=3,'其它节点保留但变淡');
  assert.equal(dom.window.location.href,urlBefore,'不换页、不改路由');
  assert.match(document.querySelector('#graphstatus').textContent,/已展开/);
  assert.equal(store.list({workspace:'w',actor:'t'},{kind:'layout'}).length,0,'展开状态不写业务数据');
 }finally{view.dispose();store.close();dom.window.close()}
});

test('再次单击/Esc 收起；点另一机构替换分支（一次只展开一个）',async()=>{
 const store=new WorkstationStore(':memory:'),dom=shell(),document=dom.window.document,ns=nodeEl(document),send=bridge(store);seed(store);
 const view=mountSpace(document,{send,batch:{draft:async()=>{}},open:()=>{},notify:()=>{},projects:[],key:()=>'layout:test'});
 try{
  await view.load();
  const svg=document.querySelector('#spaceSvg');
  click(dom,document,ns('o1'));
  assert.equal(svg.querySelectorAll('[data-branch-child]').length,1);
  click(dom,document,ns('o1'));
  assert.equal(svg.querySelectorAll('[data-branch-child]').length,0,'再点同一机构必须收起');
  assert.equal(svg.querySelectorAll('[data-dim="1"]').length,0);
  click(dom,document,ns('o1'));click(dom,document,ns('o2'));
  assert.equal(svg.querySelectorAll('[data-expanded]').length,1,'一次只展开一个分支');
  assert.match(svg.querySelector('[data-branch-child]').textContent,/参与项目/);
  assert.equal(svg.querySelectorAll('[data-branch-child]').length,1);
  document.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
  assert.equal(svg.querySelectorAll('[data-branch-child]').length,0,'Esc 必须收起');
 }finally{view.dispose();store.close();dom.window.close()}
});

test('单击项目在它旁边展开任务；双击机构/项目打开居中详情',async()=>{
 const store=new WorkstationStore(':memory:'),dom=shell(),document=dom.window.document,ns=nodeEl(document),send=bridge(store);seed(store);
 const opened=[];
 const view=mountSpace(document,{send,batch:{draft:async()=>{}},open:id=>opened.push(id),notify:()=>{},projects:[],key:()=>'layout:test'});
 try{
  await view.load();
  const svg=document.querySelector('#spaceSvg');
  click(dom,document,ns('o1'));
  // 展开后画布重绘，必须重新取元素（旧引用已从 DOM 上摘掉）
  click(dom,document,svg.querySelector('[data-branch-child]'));
  assert.match(svg.textContent,/任务一/,'单击项目应在它旁边展开任务');
  assert.equal(svg.querySelectorAll('[data-branch-child]').length,2);
  assert.deepEqual(opened,[],'单击只展开，不打开详情');
  doubleClick(dom,document,ns('o1'));
  assert.deepEqual(opened,['o1'],'双击机构才打开详情');
  doubleClick(dom,document,svg.querySelector('[data-node="p1"]')??projectCard);
  assert(opened.length>=2,'双击项目也打开详情');
 }finally{view.dispose();store.close();dom.window.close()}
});

test('低缩放子节点折叠为计数；项目视图按参与者角色分组',async()=>{
 const store=new WorkstationStore(':memory:'),dom=shell(),document=dom.window.document,ns=nodeEl(document),send=bridge(store);seed(store);
 const view=mountSpace(document,{send,batch:{draft:async()=>{}},open:()=>{},notify:()=>{},projects:[{id:'p2',title:'参与项目'}],key:()=>'layout:test'});
 try{
  await view.load();
  const svg=document.querySelector('#spaceSvg');
  click(dom,document,ns('o2'));
  assert.equal(svg.querySelectorAll('[data-branch-child]').length,1);
  for(let i=0;i<9;i+=1){document.querySelector('#less').click();await tick()}
  await tick();
  assert(Number(document.querySelector('#zoomlabel').textContent.replace('%',''))<60,'已验证缩放到 60% 以下');
  assert(svg.querySelector('[data-branch-count]'),'低缩放时子节点折叠成计数');
  assert.equal(svg.querySelectorAll('[data-branch-child]').length,0,'低缩放不画子卡，避免文字互相压叠');
  // 项目视图：scope=project:<id>，按 participants.role 分组
  const focus=document.querySelector('#projectfocus');focus.value='p2';focus.onchange();
  assert.equal(svg.querySelectorAll('[data-node]').length,1,'项目视图只显示该项目的参与机构');
  assert.deepEqual([...svg.querySelectorAll('[data-bucket]')].map(node=>node.dataset.bucket),['伙伴']);
  assert.match(svg.textContent,/伙伴 · 1 个机构/);
 }finally{view.dispose();store.close();dom.window.close()}
});

test('手机宽度下分类列竖排成一组分组列表（不把多列挤进 390）',async()=>{
 const store=new WorkstationStore(':memory:'),dom=shell(),document=dom.window.document,ns=nodeEl(document),send=bridge(store);seed(store);
 const view=mountSpace(document,{send,batch:{draft:async()=>{}},open:()=>{},notify:()=>{},projects:[],key:()=>'layout:test'});
 try{
  await view.load();
  const svg=document.querySelector('#spaceSvg');
  // jsdom 没有布局：这里显式给一个 390×600 的可见区，再触发一次结构态重排。
  svg.getBoundingClientRect=()=>({width:390,height:600,left:0,top:0,right:390,bottom:600});
  const scope=document.querySelector('#scopefilter');scope.value='structure';scope.onchange();
  const positions=[...svg.querySelectorAll('[data-node]')].map(node=>{
   const match=/translate\(([-\d.]+) ([-\d.]+)\)/.exec(node.getAttribute('transform'));
   return {id:node.dataset.node,x:Number(match[1]),y:Number(match[2])};
  });
  const byId=new Map(positions.map(item=>[item.id,item]));
  // 不同分类的机构被排成同一列：x 相同、y 依次增大（分组列表），而不是横向并排的多列。
  const orgs=['o1','o2','o3'].map(id=>byId.get(id));
  assert.equal(new Set(orgs.map(item=>item.x)).size,1,'窄屏下分类列必须竖排成一列');
  assert(orgs[1].y>orgs[0].y&&orgs[2].y>orgs[1].y,'窄屏下分组从上到下排列');
  assert.equal(svg.querySelectorAll('[data-bucket]').length,4,'分类分组头都还在（未分类/未归属不丢）');
 }finally{view.dispose();store.close();dom.window.close()}
});
