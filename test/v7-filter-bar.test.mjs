import {test} from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {JSDOM} from '../dev-deps.mjs';
import {filterBarHtml,wireFilterBar,mountProjectViews} from '../prototype/project-view.mjs';
import {mountTaskViews} from '../prototype/task-view.mjs';
import {createInbox} from '../prototype/inbox.mjs';

/**
 * 三处筛选收成一套（审计 P2 #19 / VI §6「同一控件全站唯一实现」）。
 *
 * 口径（用户 2026-10-15 定）：
 *  ① 三处都是同一个「筛选」按钮 + 展开面板；
 *  ② **有筛选生效，按钮上就必须写出条数**（「筛选 · 2」）——不能让人看着一份被过滤过的列表却不知道；
 *  ③ 状态片保留"色点 + 文字"（颜色不单独承担判断），色点用状态点那一套词、同一组变量；
 *  ④ 筛选能力一个都不许删（收件箱 5 片 + 3 下拉、项目 7 个下拉 + 排序、任务执行位置 + 负责人）。
 */
const replica=()=>new JSDOM(readFileSync(new URL('../prototype/replica/index.html',import.meta.url),'utf8'));
const source=name=>readFileSync(new URL('../prototype/'+name,import.meta.url),'utf8');

test('三处用的是同一个控件：按钮 + 面板的标记只差 id',()=>{
 const inbox=filterBarHtml({id:'inboxfilters',toggleId:'inboxfiltertoggle',chips:[{value:'pending',label:'待确认',state:'draft'}],chipValue:'pending',fields:['<span class="viselect-label">项目</span>']});
 const project=filterBarHtml({id:'projectfilters',toggleId:'projectfiltertoggle',fields:['<span class="viselect-label">阶段</span>']});
 const task=filterBarHtml({id:'taskfilters',toggleId:'taskfiltertoggle',chips:[{value:'all',label:'全部'}],chipValue:'all',fields:['<span class="viselect-label">负责人</span>']});
 for(const markup of [inbox,project,task]){
  assert.match(markup,/class="btn filtertoggle"/,'按钮必须是同一个类，不许各写一套');
  assert.match(markup,/class="btn filtertoggle" id="[a-z]+" aria-expanded="false" aria-controls="[a-z]+">筛选<\/button>/,'未展开时按钮就写「筛选」');
  assert.match(markup,/class="filterpanel" id="[a-z]+" hidden>/,'面板默认收起，且用同一个类');
  assert.equal(markup.includes(' primary'),false,'筛选是开关，不许借主色');
 }
 // 面板里两个插槽是同一套：状态片行 + 字段行
 assert.match(inbox,/<div class="seg filterstatus" role="group" aria-label="按状态筛选">/);
 assert.match(inbox,/<div class="filterfields"><div class="filterfield">/);
 // 色点用状态点那一套词，且「全部」不是状态、不给色点
 assert.match(inbox,/<i class="fdot" data-state="draft" aria-hidden="true"><\/i>待确认/);
 assert.match(task,/<button type="button" class="filterchip active"[^>]*>全部<\/button>/,'「全部」没有色点');
});

test('按钮上的条数：只数真的生效的筛选，排序不算、默认值不算',()=>{
 const dom=replica(),doc=dom.window.document;
 const host=doc.createElement('div');
 host.innerHTML=filterBarHtml({id:'x',fields:[]});
 doc.body.append(host);
 try{
  const state={stage:'',importance:'high',sort:'due'};
  const bar=wireFilterBar(host,{id:'x',state,counted:['stage','importance'],defaults:{stage:'',importance:''}});
  assert.equal(bar.count(),1,'只有 importance 生效');
  assert.equal(bar.toggle.textContent,'筛选 · 1');
  state.stage='验证';bar.sync();
  assert.equal(bar.toggle.textContent,'筛选 · 2');
  assert.equal(bar.toggle.dataset.active,'1');
  state.stage='';state.importance='';bar.sync();
  assert.equal(bar.toggle.textContent,'筛选','没有筛选生效时不许留着条数');
  assert.equal(bar.toggle.dataset.active,'0');
  bar.toggle.click();
  assert.equal(bar.panel.hidden,false,'点按钮展开');
  assert.equal(bar.toggle.getAttribute('aria-expanded'),'true');
  bar.toggle.click();
  assert.equal(bar.panel.hidden,true,'再点收起');
 }finally{dom.window.close()}
});

test('收件箱：5 个状态片 + 3 个下拉都还在，只是收进面板；按钮写出条数',async()=>{
 const dom=replica(),doc=dom.window.document;
 // 复刻页里没有收件箱容器（它是构建期注入的），这里给它一个：render 本来就接受任意容器。
 const host=doc.createElement('section');host.id='inboxbody';doc.body.append(host);
 const inbox=createInbox(doc,async action=>action==='inbox'?{items:[]}:{}, {}, {notify:()=>{}});
 try{
  inbox.setProjects([{id:'p-a',title:'联合验证'}]);
  await inbox.render(host);
  // 常驻的只有一个按钮：状态片与下拉都不再铺在页面上（手机上正是它们把页面撑出视口）
  assert.equal(doc.querySelectorAll('#inboxbody > .filtertoggle').length,1);
  assert.equal(doc.querySelectorAll('#inboxbody > .seg[data-inbox]').length,0,'状态片不许再常驻在页面流里');
  const panel=doc.querySelector('#inboxfilters');
  assert.ok(panel.classList.contains('filterpanel'),'#inboxfilters 就是那个面板');
  assert.equal(panel.hidden,true,'默认收起');
  assert.equal(panel.querySelectorAll('[data-inbox]').length,5,'5 个状态片一个都不少');
  assert.deepEqual([...panel.querySelectorAll('[data-inbox]')].map(node=>node.dataset.inbox),['pending','blocked','done','cancelled',''],'顺序与取值口径不变');
  // 逐字段相关性门禁按"文字恰好是全部"找这个片，标签里不许塞计数
  const all=[...panel.querySelectorAll('[data-inbox]')].find(node=>node.textContent.trim()==='全部');
  assert.ok(all,'「全部」片的文字必须正好是「全部」');
  assert.equal(all.querySelector('.fdot'),null,'「全部」不是一个状态，不给色点');
  assert.equal(panel.querySelectorAll('.filterfield [data-viselect]').length,3,'项目 / 变更类型 / 来源三个下拉都在');
  assert.equal(panel.querySelectorAll('.fdot[data-state]').length,4,'四个状态片各有一个色点，且用状态点的词');
  // 默认视图就是「待确认」：它是这份列表本身的定义，不是你刚施加的筛选 ——
  // 默认态不写「筛选 · 1」（spec/54 §3.4 / 48 M3「筛选默认值不装成用户筛选」）。
  assert.equal(doc.querySelector('#inboxfiltertoggle').textContent,'筛选');
  doc.querySelector('#inboxfiltertoggle').click();
  assert.equal(doc.querySelector('#inboxfilters').hidden,false);
  doc.querySelector('#inboxfilters [data-inbox="cancelled"]').click();
  await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(doc.querySelector('#inboxfiltertoggle').textContent,'筛选 · 1','主动换了状态才是一条筛选');
  assert.equal(doc.querySelector('#inboxfilters').hidden,false,'重绘后面板不自己收起来');
  assert.equal(doc.querySelector('#inboxfilters .filterchip.active').textContent.trim(),'已取消');
  doc.querySelector('#inboxfilters [data-inbox=""]').click();
  await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(doc.querySelector('#inboxfiltertoggle').textContent,'筛选','切回「全部」条数归零');
  const option=[...doc.querySelectorAll('#inboxfilters [data-viselect-option]')].find(node=>node.dataset.viselectOption==='p-a');
  option.click();
  await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(doc.querySelector('#inboxfiltertoggle').textContent,'筛选 · 1','只剩项目这一条');
  assert.equal(doc.querySelector('#inboxproject [data-viselect-text]').textContent,'联合验证','下拉里显示当前选中的项目，不装作没筛');
 }finally{dom.window.close()}
});

test('项目页：7 个下拉 + 排序一个不少，收进同一个面板，条数写在按钮上',async()=>{
 const dom=replica(),doc=dom.window.document;
 const items=[
  {id:'p1',kind:'project',data:{title:'联合验证',stage:'验证',importance:'high',urgency:'high',deliverables:[{done:true}]}},
  {id:'p2',kind:'project',data:{title:'云服务合作',stage:'方案',deliverables:[{done:false}]}},
 ];
 const view=await mountProjectViews(doc,async()=>({items}),()=>{});
 try{
  const toggle=doc.querySelector('#projectfiltertoggle');
  const panel=doc.querySelector('#projectfilters');
  assert.ok(toggle&&panel,'项目页的按钮与面板都在（id 沿用原值）');
  assert.equal(toggle.textContent,'筛选');
  assert.equal(panel.hidden,true);
  assert.equal(panel.querySelectorAll('.filterfield').length,7,'7 个下拉 + 排序都要在');
  toggle.click();
  assert.deepEqual([...panel.querySelectorAll('[data-pfilter]')].map(node=>node.dataset.pfilter),['stage','partnerId','ownerId','importance','urgency','delivery','sort']);
  const stage=[...panel.querySelectorAll('[data-pfilter="stage"]')].length&&[...panel.querySelectorAll('[data-viselect]')].find(node=>node.querySelector('input')?.dataset.pfilter==='stage');
  [...stage.querySelectorAll('[data-viselect-option]')].find(node=>node.dataset.viselectOption==='验证').click();
  assert.equal(toggle.textContent,'筛选 · 1','筛了阶段要写出来');
  assert.equal(panel.hidden,false,'筛完面板还开着，看得见自己筛了什么');
  const shown=[...new Set([...doc.querySelectorAll('#projectsbody [data-project]')].map(node=>node.dataset.project))];
  assert.deepEqual(shown,['p1'],'条数不是装饰：列表真的被筛过');
 }finally{view.dispose();dom.window.close()}
});

test('任务页：执行位置片收进面板，与负责人一起按同一条口径写条数',()=>{
 const dom=replica(),doc=dom.window.document;
 const items=[{id:'p1',kind:'project',data:{title:'P1'}},{id:'alice',kind:'person',data:{title:'爱丽丝'}},{id:'t1',kind:'task',data:{title:'A',projectId:'p1',ownerId:'alice',executionTarget:'mini',status:'todo'}},{id:'t2',kind:'task',data:{title:'B',projectId:'p1',status:'todo'}}];
 const view=mountTaskViews(doc,items,()=>{});
 try{
  const toggle=doc.querySelector('#taskfiltertoggle'),panel=doc.querySelector('#taskfilters');
  assert.ok(toggle&&panel,'任务页终于也有了「筛选」按钮');
  assert.equal(toggle.textContent,'筛选','没有筛选生效时不虚报');
  assert.equal(panel.hidden,true);
  assert.equal(panel.querySelectorAll('.filterstatus [data-target]').length,3,'全部 / Mini / 本机都还在');
  assert.equal(doc.querySelectorAll('.toolbar > .seg [data-target]').length,0,'执行位置片不再常驻一排');
  assert.equal(panel.querySelectorAll('.filterfield [data-viselect]').length,1,'负责人下拉在面板里');
  panel.querySelector('[data-target="Mini"]').click();
  assert.equal(toggle.textContent,'筛选 · 1');
  assert.equal(panel.querySelector('.filterchip.active').textContent.trim(),'Mini','选中态由共用控件维护');
  const owner=panel.querySelector('[data-taskowner]');
  owner.value='alice';owner.dispatchEvent(new dom.window.Event('change'));
  assert.equal(toggle.textContent,'筛选 · 2','两条生效就写两条');
  assert.deepEqual([...doc.querySelectorAll('#tasksbody [data-task]')].map(node=>node.dataset.task),['t1'],'两个条件都作用到列表上');
 }finally{view.dispose();dom.window.close()}
});

test('反回归：三处 import 同一份实现，不许再各自手搓按钮',()=>{
 for(const name of ['inbox.mjs','task-view.mjs'])assert.match(source(name),/import \{filterBarHtml,wireFilterBar\} from '\.\/project-view\.mjs'/,'%s 必须用共用实现'.replace('%s',name));
 for(const name of ['inbox.mjs','task-view.mjs','project-view.mjs'])assert.equal(/id="[a-z]*filtertoggle"/.test(source(name)),false,'按钮的标记只许由 filterBarHtml 生成');
 // 色点颜色只许有一张表：卡片点与筛选片点写同一条规则
 const css=source('v7-workbench.css');
 for(const state of ['draft','conflict','committed','cancelled'])assert.ok(css.includes(`.statusdot[data-state="${state}"],.fdot[data-state="${state}"]`),'状态 '+state+' 的两处色点必须共用同一组变量');
 assert.equal(css.includes('data-fdot'),false,'旧的 data-fdot 写法必须清掉，不许两套词');
});
