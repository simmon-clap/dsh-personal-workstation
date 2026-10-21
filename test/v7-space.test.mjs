import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from '../dev-deps.mjs';
import {WorkstationStore} from '../src/store.mjs';
import {browserRoute} from '../src/browser-api.mjs';
import {mountSpace,spaceLayout,scopeNodes,relationData,nodeSubtitle,kindLabels,statusLabels} from '../prototype/space-view-v5.mjs';

const shell=()=>new JSDOM(readFileSync(new URL('../prototype/replica/index.html',import.meta.url),'utf8'));
function bridge(store){
 const route=browserRoute({store,connection:{admit:()=>({peer:{id:'operator'}})},workspaceRegistry:{get:id=>id==='w'?{id}:null,list:()=>[{id:'w',title:'W'}]},allowedWorkspaces:['w']});
 return async(action,data={})=>{const response=await route.fetch(new Request('http://localhost/personal-workstation/api',{method:'POST',headers:{'content-type':'application/json','x-workstation-client':'1'},body:JSON.stringify({...data,action,workspace:'w'})}));const value=await response.json();if(!response.ok)throw Error(value.message||value.error);return value};
}
/** 画布默认范围是结构态（D8）；要测关系态行为就把范围选择器切到「全部关系」。 */
function useRelationScope(document){const input=document.querySelector('#scopefilter');input.value='all';input.onchange()}

const seed=store=>{const ctx={workspace:'w',actor:'t',canWrite:true};const commit=(changes,key)=>{const b=store.draft(ctx,{title:key,changes});return store.commit(ctx,{batchId:b.id,revision:1,key})};
 commit([{op:'create',id:'p1',kind:'project',data:{title:'项目一',deliverables:[{id:'d1',title:'交付',done:true}]}},{op:'create',id:'p2',kind:'project',data:{title:'项目二'}},{op:'create',id:'a1',kind:'artifact',data:{title:'共享资料',projectId:'p1'}},{op:'create',id:'r1',kind:'relation',data:{title:'可能复用',from:'a1',to:'p2',status:'suggested',evidence:'两处引用同一份资料'}}],'seed')};
test('canvas captions never leak internal enums to the user',()=>{
 assert.equal(nodeSubtitle({kind:'task',progress:{done:3,total:5},businessStatus:'in_progress'}),'任务 · 3/5 项 · 进行中');
 assert.equal(nodeSubtitle({kind:'task',progress:{done:1,total:4},businessStatus:'waiting'}),'任务 · 1/4 项 · 等待中');
 assert.equal(nodeSubtitle({kind:'project',progress:{done:6,total:8},businessStatus:'验证'}),'项目 · 6/8 项 · 验证');
 assert.equal(nodeSubtitle({kind:'artifact'}),'资料');assert.equal(nodeSubtitle({kind:'topic'}),'研究议题');
 assert.equal(nodeSubtitle({kind:'memoryRef'}),'记忆引用');assert.equal(nodeSubtitle({kind:'event'}),'事务');
 for(const label of Object.values(kindLabels))assert.doesNotMatch(label,/[a-z_]+/,label+' 不应是内部枚举');
 for(const label of Object.values(statusLabels))assert.doesNotMatch(label,/[a-z_]+/,label+' 不应是内部枚举');
 assert.equal(nodeSubtitle({kind:'task',progress:{done:0,total:0}}),'任务 · 尚无步骤','0/0 不画成指标（S4）：只说尚无步骤');
});
test('space layout is deterministic and scope filters follow the prototype semantics',()=>{
 const nodes=[{id:'b',kind:'task'},{id:'a',kind:'task'},{id:'p',kind:'project'}];assert.deepEqual(spaceLayout(nodes),spaceLayout([...nodes].reverse()));
 assert.deepEqual(spaceLayout(nodes),{p:{x:0,y:0},a:{x:300,y:0},b:{x:300,y:160}});
 const edges=[{id:'e1',from:'p',to:'x1',title:'项目归属',derived:true},{id:'e2',from:'p2',to:'x1',title:'项目归属',derived:true},{id:'e3',from:'x1',to:'p',title:'可能相关',status:'suggested'}];
 const all=[{id:'p',kind:'project'},{id:'p2',kind:'project'},{id:'x1',kind:'artifact'}];
 assert.deepEqual(scopeNodes(all,edges,'all').map(n=>n.id),['p','p2','x1']);
 assert.deepEqual(scopeNodes(all,edges,'shared').map(n=>n.id),['p','p2','x1'],'跨项目共享对象应连同两个项目一起显示');
 assert.deepEqual(scopeNodes(all,edges,'suggestions').map(n=>n.id),['p','x1']);
 assert.deepEqual(relationData({from:'a',to:'b',title:'t',evidence:'e',status:'suggested',derived:false},'rejected'),{title:'t',from:'a',to:'b',status:'rejected',evidence:'e'});
});
test('showing the canvas page re-fits a layout measured while the page was hidden',async()=>{
 const store=new WorkstationStore(':memory:'),dom=shell(),document=dom.window.document,send=bridge(store);seed(store);
 const view=mountSpace(document,{send,batch:{draft:async()=>{}},open:()=>{},notify:()=>{},projects:[],key:()=>'layout:test'});
 try{
  await view.load();useRelationScope(document);
  const svg=document.querySelector('#spaceSvg'),world=()=>svg.querySelector('#spaceworld').getAttribute('transform');
  assert.match(world(),/scale\(1\)/,'页面隐藏时按 0 尺寸回退为 1:1');
  svg.getBoundingClientRect=()=>({width:390,height:600,left:0,top:0,right:390,bottom:600});
  view.refit();
  assert.doesNotMatch(world(),/scale\(1\)\)$/,'可见后重新适配必须改变缩放或位移');
  const scale=Number(/scale\(([\d.]+)\)/.exec(world())[1]);
  assert(scale<1,'窄屏必须缩小才能容纳全部节点');
  const [gx,gy]=/translate\(([-\d.]+) ([-\d.]+)\)/.exec(world()).slice(1).map(Number);
  const positions=[...document.querySelectorAll('#spaceworld [data-node]')].map(node=>/translate\(([-\d.]+) ([-\d.]+)\)/.exec(node.getAttribute('transform')).slice(1).map(Number));
  const right=Math.max(...positions.map(([x])=>x))+200, bottom=Math.max(...positions.map(([,y])=>y))+86;
  assert(gx>=0&&gy>=0,'适配后世界原点不得移出画面');
  assert(gx+right*scale<=391&&gy+bottom*scale<=601,'全部节点必须落在可见区域内');
 }finally{view.dispose();store.close();dom.window.close()}
});
test('V7 canvas renders real graph nodes, edges and persists layout',async()=>{
 const store=new WorkstationStore(':memory:'),dom=shell(),document=dom.window.document,send=bridge(store);seed(store);
 const outlines=[];const notes=[];const view=mountSpace(document,{send,batch:{draft:async()=>{}},open:id=>outlines.push(id),notify:(text,error)=>notes.push([text,error]),projects:[{id:'p1',title:'项目一'},{id:'p2',title:'项目二'}],key:(()=>{let n=0;return()=>'layout:'+(++n)})()});
 try{
  await view.load();useRelationScope(document);
  const svg=document.querySelector('#spaceSvg');
  assert.equal(svg.querySelectorAll('[data-node]').length,3,'应渲染全部真实对象，关系记录不作为节点');
  assert.equal(svg.querySelectorAll('[data-edge]').length,2);
  assert.equal(svg.querySelector('#spaceworld').getAttribute('transform').startsWith('translate('),true);
  assert.match(document.querySelector('#graphstatus').textContent,/共 3 个对象 · 2 条关联/);
  assert.match(svg.querySelector('[data-edge="r1"] path[stroke-dasharray]').getAttribute('stroke-dasharray'),/6 6/,'待确认关联应为虚线');
  assert.equal(svg.querySelector('[data-edge="project:a1"] path[stroke-dasharray]').getAttribute('stroke-dasharray'),'none','由字段推导的归属关系应为实线');
  // 2026-10-14：聚焦项目下拉改成 VI 选择控件（VI §6 同一控件唯一实现），候选看 data-viselect-option。
 assert.equal(document.querySelectorAll('[data-canvas-select="projectfocus"] [data-viselect-option]').length,3,'聚焦项目应来自真实项目');
 assert.equal(document.querySelectorAll('.spacebar select').length,0,'关联空间不许再有原生 <select>（与 .viselect 并存算第二套实现）');
  document.querySelector('#scopefilter').value='suggestions';document.querySelector('#scopefilter').onchange();
  assert.equal(svg.querySelectorAll('[data-node]').length,2,'AI 建议范围只显示被建议触及的对象');
  // A4（17 C9）：缩放/平移**不写库**；只有点「保存布局」才落一次。
  document.querySelector('#fitspace').click();for(let i=0;i<6;i++)await new Promise(r=>setImmediate(r));
  assert.equal(store.list({workspace:'w',actor:'t'},{kind:'layout'}).length,0,'缩放/全图不得偷偷写布局');
  assert.equal(document.querySelector('#savelayout').dataset.dirty,'1','改过视图后保存按钮应标出未保存');
  document.querySelector('#savelayout').click();for(let i=0;i<8;i++)await new Promise(r=>setImmediate(r));
  const layout=store.list({workspace:'w',actor:'t'},{kind:'layout'});
  assert.equal(layout.length,1,'点「保存布局」才落库');
  assert.equal(Object.keys(layout[0].data.positions).length,3);
  assert.equal(document.querySelector('#savelayout').dataset.dirty,'0','保存后脏标记清掉');
  document.querySelector('#more').click();for(let i=0;i<6;i++)await new Promise(r=>setImmediate(r));
  assert.equal(store.list({workspace:'w',actor:'t'},{kind:'layout'}).length,1,'再缩放仍不写库');
  document.querySelector('#savelayout').click();for(let i=0;i<8;i++)await new Promise(r=>setImmediate(r));
  const again=store.list({workspace:'w',actor:'t'},{kind:'layout'});
  assert.equal(again.length,1,'连续保存应更新同一布局对象');
  assert.equal(again[0].revision,2,'连续保存不得因修订冲突而失败');
  assert.ok(notes.every(([text])=>text==='已保存画布布局'),'保存布局要给一次如实反馈，且不得出现别的提示：'+JSON.stringify(notes));
  assert.equal(document.querySelector('#zoomlabel').textContent.endsWith('%'),true);
 }finally{view.dispose();store.close();dom.window.close()}
});
test('V7 canvas opens details and turns a pending suggestion into a reviewable draft',async()=>{
 const store=new WorkstationStore(':memory:'),dom=shell(),document=dom.window.document,send=bridge(store),drafts=[],opened=[];seed(store);
 const view=mountSpace(document,{send,batch:{draft:async(title,changes)=>{drafts.push({title,changes})}},open:id=>opened.push(id),notify:()=>{},projects:[{id:'p1',title:'项目一'},{id:'p2',title:'项目二'}],key:()=>'layout:test'});
 const pointer=(target,type)=>{const event=new dom.window.MouseEvent(type,{bubbles:true,button:0,clientX:0,clientY:0});Object.defineProperty(event,'pointerId',{value:1});target.dispatchEvent(event)};
 try{
  await view.load();useRelationScope(document);
  // CV-02 键盘访问：聚焦的连线用 Enter 激活，与点击同一条路径。
  const edge=document.querySelector('#spaceSvg [data-edge="r1"]');
  edge.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
  // 键盘激活连线与点击同一条通路：先出画布内操作条（CV-08），「看依据」再开证据弹窗。
  assert(document.querySelector('#canvasactionbar'),'键盘激活连线应出现画布内操作条');
  document.querySelector('#canvasactionbar [data-edge-action="basis"]').click();
  for(let i=0;i<3;i++)await new Promise(r=>setImmediate(r));
  assert.equal(document.querySelector('#detailtitle').textContent,'可能复用','键盘激活连线应能打开关联证据');
  document.querySelector('.close').click();
  // 单击节点 = 打开详情（用户 2026-10-12：原来单击只"展开关联"，看起来像点了没反应）
  pointer(document.querySelector('#spaceSvg [data-node="p1"]'),'pointerdown');
  pointer(document.querySelector('#spaceSvg [data-node="p1"]'),'pointerup');
  assert.deepEqual(opened,['p1'],'单击节点必须打开详情');
  document.querySelector('.close')?.click();
  // 双击 = 聚焦展开邻接（原来的单击行为），聚焦下拉要跟随
  pointer(document.querySelector('#spaceSvg [data-node="p1"]'),'pointerdown');
  pointer(document.querySelector('#spaceSvg [data-node="p1"]'),'pointerup');
  document.querySelector('#spaceSvg [data-node="p1"]').dispatchEvent(new dom.window.MouseEvent('dblclick',{bubbles:true,cancelable:true}));
  assert.equal(document.querySelector('#projectfocus').value,'p1','聚焦项目下拉应跟随聚焦的节点');
  assert.equal(store.list({workspace:'w',actor:'t'},{kind:'layout'}).length,0,'仅聚焦不应写布局');
  assert.match(document.querySelector('#graphstatus').textContent,/当前显示/);
  document.querySelector('#globalCanvas').click();
  assert.equal(document.querySelector('#projectfocus').value,'','回到全局应清除聚焦');
  // 点虚线先出**画布内操作条**（CV-08），「看依据」才打开弹窗。
  pointer(document.querySelector('#spaceSvg [data-edge="r1"]'),'pointerdown');
  pointer(document.querySelector('#spaceSvg [data-edge="r1"]'),'pointerup');
  assert(document.querySelector('#canvasactionbar'),'点虚线应先出现画布内操作条');
  document.querySelector('#canvasactionbar [data-edge-action="basis"]').click();
  for(let i=0;i<3;i++)await new Promise(r=>setImmediate(r));
  assert.equal(document.querySelector('#detailtitle').textContent,'可能复用');
  assert.match(document.querySelector('#detailbody').textContent,/两处引用同一份资料/);
  assert.match(document.querySelector('#detailbody').textContent,/待确认建议/);
  document.querySelector('#edgeConfirm').click();for(let i=0;i<4;i++)await new Promise(r=>setImmediate(r));
  assert.equal(drafts.length,1);
  assert.deepEqual(drafts[0].changes,[{op:'update',id:'r1',expectedRevision:1,data:{title:'可能复用',from:'a1',to:'p2',status:'confirmed',evidence:'两处引用同一份资料',basis:['a1@1','p2@1']}}],'确认时必须记录两端当前版本作为依据');
  assert.equal(store.get({workspace:'w',actor:'t'},'r1').data.status,'suggested','确认前不得直接改写关系');
  const derived=document.querySelector('#spaceSvg [data-edge="project:a1"]');
  pointer(derived,'pointerdown');pointer(derived,'pointerup');
  assert.match(document.querySelector('#detailbody').textContent,/由对象字段推导，不可在此修改/);
  assert.equal(document.querySelector('#edgeConfirm'),null,'推导出来的归属关系不能当作可确认建议');
 }finally{view.dispose();store.close();dom.window.close()}
});

test('canvas detail follows the zoom tiers instead of always drawing everything',async()=>{
 const {nodeDetailAt,showsEdgeLabels,nodeSubtitle}=await import('../prototype/space-view-v5.mjs');
 const task={kind:'task',progress:{done:3,total:5},businessStatus:'in_progress'};
 // 低于 60%：只看得到对象名 + 类型
 assert.equal(nodeDetailAt(task,0.45),'任务');
 // 60–110%：补充状态与计数
 assert.match(nodeDetailAt(task,0.8),/3\/5 项 · 进行中/);
 assert.match(nodeDetailAt(task,1.1),/3\/5 项 · 进行中/);
 // 高于 110%：才显示关系文字
 assert.equal(showsEdgeLabels(0.6),false,'60% 时不应出现关系文字');
 assert.equal(showsEdgeLabels(1.1),false,'110% 时仍不显示关系文字');
 assert.equal(showsEdgeLabels(1.2),true);
 // 非项目/任务对象在低缩放下显示类型，放大后仍是类型（没有计数可补充）
 const topic={kind:'topic'};
 assert.equal(nodeDetailAt(topic,0.3),'研究议题');
 assert.equal(nodeDetailAt(topic,1.0),nodeSubtitle(topic));
});

test('long node titles wrap to at most two lines inside the card instead of spilling over',async()=>{ const {wrapNodeTitle,textWidth,NODE_TEXT_WIDTH}=await import('../prototype/space-view-v5.mjs');
 // 实测过：19 个节点里有 2 个标题画到卡片外（最严重超出 41px）。
 for(const title of ['联合验证','推理框架：需要验证哪些收益？','异构算力适配的合作切入点','这是一个非常非常长的项目名称用来测试两行截断与溢出行为'.repeat(3)]){
  const lines=wrapNodeTitle(title);
  assert(lines.length>=1&&lines.length<=2,'最多两行：'+title.slice(0,12));
  for(const line of lines)assert(textWidth(line)<=NODE_TEXT_WIDTH,'每一行都必须放得下：'+line);
 }
 // 超长必须给出省略号，且不是简单地把整串塞进一行
 const long=wrapNodeTitle('这是一个非常非常长的项目名称用来测试两行截断与溢出行为'.repeat(3));
 assert.match(long[long.length-1],/…$/,'放不下时用省略号');
 assert(long.join('').length<'这是一个非常非常长的项目名称用来测试两行截断与溢出行为'.repeat(3).length,'不能假装放得下');
 // 短标题保持一行，不改变原有观感
 assert.deepEqual(wrapNodeTitle('联合验证'),['联合验证']);
});
