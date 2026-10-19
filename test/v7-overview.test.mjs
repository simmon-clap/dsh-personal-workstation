import {test} from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {JSDOM} from '../dev-deps.mjs';import {buildShell} from '../prototype/build-shell.mjs';import {mountOverview} from '../prototype/overview-view.mjs';import {mountProjectViews} from '../prototype/project-view.mjs';import {mountTaskViews} from '../prototype/task-view.mjs';import {mountKnowledge,mountPersonal} from '../prototype/knowledge-view-v2.mjs';
test('V7 overview derives metrics, today events and topics from persisted records',()=>{const dom=new JSDOM(buildShell(readFileSync(new URL('../prototype/frozen/workbench-v7.html',import.meta.url),'utf8'))),doc=dom.window.document;const items=[{id:'p',kind:'project',data:{title:'项目',deliverables:[{done:true},{done:false}]}},{id:'t',kind:'task',data:{title:'等待',status:'waiting'}},{id:'e',kind:'event',data:{title:'会议',startDate:'2026-01-02T09:30:00',location:'线上'}},{id:'allday',kind:'event',data:{title:'全天事务',startDate:'2026-01-02'}},{id:'old',kind:'event',data:{title:'旧会',startDate:'2026-01-01T09:30:00'}},{id:'k',kind:'topic',data:{title:'议题',summary:'摘要'}}];const view=mountOverview(doc,items,{now:new Date('2026-01-02T01:00:00')});try{assert.match(doc.querySelector('#metrics').textContent,/1\/2/);assert.match(doc.querySelector('#metrics').textContent,/需要解锁\s*1/);assert.match(doc.querySelector('#home .lower').textContent,/会议/);assert.doesNotMatch(doc.querySelector('#home .lower').textContent,/旧会/);assert.match(doc.querySelector('#home .lower').textContent,/议题/);assert.match(doc.querySelector('#home .lower').textContent,/全天事务/);}finally{view.dispose();dom.window.close()}});
test('empty workspaces explain the state and offer a next step instead of a blank card',async()=>{
 const dom=new JSDOM(buildShell(readFileSync(new URL('../prototype/frozen/workbench-v7.html',import.meta.url),'utf8'))),doc=dom.window.document;
 let created=0;
 const views=await mountProjectViews(doc,async()=>({items:[]}),()=>{},{onCreate:()=>{created++}});
 try{
  const strip=doc.querySelector('#projectstrip .v7-empty');
  assert(strip,'空项目应显示空态');
  assert.equal(strip.querySelector('h3').textContent,'还没有项目');
  assert.match(strip.querySelector('img').getAttribute('src'),/assets\/illustrations\/projects\.svg/);
  strip.querySelector('.btn').click();assert.equal(created,1,'空态必须给出可执行的下一步');
  assert(doc.querySelector('#projectsbody .v7-empty'),'交付分布不应留只有脚注的空卡');
  assert(doc.querySelector('#roadmap .v7-empty'),'路线图空态应说明计划区间');
  const tasks=mountTaskViews(doc,[],()=>{});
  try{const state=doc.querySelector('#tasksbody .v7-empty');assert(state,'任务空态缺失');assert.match(state.textContent,/还没有任务/);assert.match(state.querySelector('img').getAttribute('src'),/waiting\.svg/)}finally{tasks.dispose()}
  const memory=mountKnowledge(doc,[],'memory',{});
  try{assert.equal(doc.querySelector('#knowbody .v7-empty h3').textContent,'还没有记忆引用')}finally{memory.dispose()}
  const brief=mountKnowledge(doc,[],'brief',{});
  try{assert.match(doc.querySelector('#knowbody .v7-empty').textContent,/还没有登记简报/,'空态要说明当前状态');assert.match(doc.querySelector('#knowbody .v7-empty').textContent,/自动抓取与摘要还没接通/,'未接入的能力要在空态里如实说明')}finally{brief.dispose()}
  const personal=mountPersonal(doc,[],'calendar',{});
  try{assert.equal(doc.querySelector('#personalbody .v7-empty h3').textContent,'今天没有安排');// 苹果日历同步已经接入（1.6.x），空态不能再写"尚未接入"，而要指出去哪新建/导入
  assert.match(doc.querySelector('#personalbody').textContent,/苹果日历同步已经接入/)}finally{personal.dispose()}
 }finally{views.dispose();dom.window.close()}
});

test('the overview keeps exactly four metric cards and shows the counts on one line',()=>{
 const dom=new JSDOM(buildShell(readFileSync(new URL('../prototype/frozen/workbench-v7.html',import.meta.url),'utf8'))),doc=dom.window.document;
 const items=[
  {id:'a1',kind:'artifact',data:{title:'未归属资料'}},
  {id:'a2',kind:'artifact',data:{title:'已归属资料',projectId:'p1'}},
  {id:'t1',kind:'topic',data:{title:'未归属议题'}},
  {id:'t2',kind:'topic',data:{title:'已归属议题',projectId:'p1'}},
  {id:'a3',kind:'artifact',archived:true,data:{title:'已归档'}},
 ];
 const view=mountOverview(doc,items,{pending:2});
 try{
  // 指标卡数量必须与原 V7 原型和设计方 VI 应用页一致：恰好 4 张。
  assert.equal(doc.querySelectorAll('#metrics .metric').length,4,'首页只能有 4 张指标卡');
  const cardText=[...doc.querySelectorAll('#metrics .metric')].map(node=>node.textContent).join(' ');
  assert.doesNotMatch(cardText,/待确认批次/,'待确认计数不得再占用指标卡');
  const counts=doc.querySelector('#metrics [data-counts]');
  assert(counts&&!counts.classList.contains('metric'),'计数行必须是独立小字，不能是指标卡');
  assert(counts,'待确认/待整理计数必须仍然可见（PRD v1.1 §3）');
  assert.match(counts.textContent,/待你决定的改动 2/);
  assert.match(counts.textContent,/待整理 2（未归属项目的资料与议题）/,'待整理必须写明定义');
  const all=mountOverview(doc,items,{pending:0});
  try{
   assert.equal(doc.querySelectorAll('#metrics .metric').length,4);
   assert.match(doc.querySelector('#home [data-counts]').textContent,/待你决定的改动 0/,'计数与待确认的改动数量无关');
  }finally{all.dispose()}
  assert.equal(doc.querySelectorAll('#home [data-counts]').length,1,'重复渲染不得叠加多行');
  const none=mountOverview(doc,items,{pending:null});
  try{assert(!doc.querySelector('#home [data-counts]'),'读不到待确认的改动时不得显示数字')}finally{none.dispose()}
 }finally{view.dispose();dom.window.close()}
});
