import {test} from 'node:test';import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from '../dev-deps.mjs';
import {projectModels,sortByPriority,priorityLabels} from '../prototype/project-data.mjs';
import {validateData} from '../src/validation.mjs';
import {mountKnowledge} from '../prototype/knowledge-view.mjs';

const items=[
 {id:'plain',kind:'project',revision:1,data:{title:'一般项目'}},
 {id:'both',kind:'project',revision:1,data:{title:'重要且紧急',importance:'high',urgency:'high'}},
 {id:'imp',kind:'project',revision:1,data:{title:'重要不紧急',importance:'high',urgency:'low',dueDate:'2026-11-01'}},
 {id:'urg',kind:'project',revision:1,data:{title:'紧急不重要',importance:'low',urgency:'high'}},
];

test('projects can carry importance and urgency, and only the three real levels are accepted',()=>{
 validateData('project',{title:'X',importance:'high',urgency:'medium'});
 assert.throws(()=>validateData('project',{title:'X',importance:'urgent'}),/重要程度/);
 assert.throws(()=>validateData('project',{title:'X',urgency:'高'}),/紧急程度/);
 assert.equal(priorityLabels('high'),'高');
 assert.equal(priorityLabels(''),'未设置','没填就是未设置，不假装有优先级');
});

test('the default order is importance first, then urgency, then the nearest deadline',()=>{
 const models=projectModels(items);
 assert.deepEqual(sortByPriority(models).map(m=>m.id),['both','imp','urg','plain']);
 // 同分时按截止日期近的在前
 const same=[{id:'later',kind:'project',data:{title:'B',importance:'high',urgency:'high',dueDate:'2026-12-01'}},
             {id:'sooner',kind:'project',data:{title:'A',importance:'high',urgency:'high',dueDate:'2026-10-20'}}];
 assert.deepEqual(sortByPriority(projectModels(same)).map(m=>m.id),['sooner','later']);
 // 未设置优先级的排在最后，而不是被默认成"中"
 assert.equal(projectModels(items).find(m=>m.id==='plain').priorityScore,0);
});

test('the project page injects a filter bar and filters by real dimensions',async()=>{
 const dom=new JSDOM(readFileSync(new URL('../prototype/replica/index.html',import.meta.url),'utf8'));
 const document=dom.window.document;
 const view=await import('../prototype/project-view.mjs');
 const all=projectModels(items);
 const filtered=view.applyProjectFilters(all,{importance:'high',urgency:'',stage:'',partnerId:'',ownerId:'',delivery:'',sort:'priority'});
 assert.deepEqual(filtered.map(m=>m.id),['both','imp'],'按重要程度筛选只留 high');
 const late=view.applyProjectFilters(projectModels([
  {id:'late',kind:'project',data:{title:'有逾期',deliverables:[{id:'d',title:'x',done:false,dueDate:'2020-01-01'}]}},
  {id:'ok',kind:'project',data:{title:'正常',deliverables:[{id:'d',title:'x',done:true,dueDate:'2020-01-01'}]}},
 ]),{delivery:'late',importance:'',urgency:'',stage:'',partnerId:'',ownerId:'',sort:'priority'});
 assert.deepEqual(late.map(m=>m.id),['late'],'「有逾期」只留真的有逾期交付项的项目');
 const none=view.applyProjectFilters(all,{importance:'none',urgency:'',stage:'',partnerId:'',ownerId:'',delivery:'',sort:'priority'});
 assert.deepEqual(none.map(m=>m.id),['plain'],'「未设置」只留没填过的');
 assert.deepEqual(view.applyProjectFilters(all,{sort:'name',stage:'',partnerId:'',ownerId:'',importance:'',urgency:'',delivery:''}).map(m=>m.id).sort(),['both','imp','plain','urg']);
 // 负责人分支不能只靠"筛选条存在"覆盖：单独钉住按真实 ownerId 过滤这条路径。
 const byOwner=projectModels([
  {id:'ownedA',kind:'project',data:{title:'甲的',ownerId:'a'}},
  {id:'ownedB',kind:'project',data:{title:'乙的',ownerId:'b'}},
  {id:'unowned',kind:'project',data:{title:'无主'}},
 ]);
 assert.deepEqual(view.applyProjectFilters(byOwner,{sort:'priority',stage:'',partnerId:'',ownerId:'a',importance:'',urgency:'',delivery:''}).map(m=>m.id),['ownedA'],'按负责人筛选只留该负责人的项目');
 assert.deepEqual(view.applyProjectFilters(byOwner,{sort:'priority',stage:'',partnerId:'',ownerId:'b',importance:'',urgency:'',delivery:''}).map(m=>m.id),['ownedB'],'换一个负责人只留另一个');
 dom.window.close();
});

test('the material card shows path, size, disk state, project link and an open entry',async()=>{
 const dom=new JSDOM(readFileSync(new URL('../prototype/replica/index.html',import.meta.url),'utf8'));
 const document=dom.window.document;
 const materials=[
  {id:'m1',kind:'artifact',revision:1,data:{title:'会议纪要',path:'transcripts/纪要.md',fileGrantId:'g1',fileVersion:'v2',projectId:'p1'}},
  {id:'m2',kind:'artifact',revision:1,data:{title:'口头要点',content:'只读镜像先做',projectId:'p1'}},
  {id:'m3',kind:'artifact',revision:1,data:{title:'未归属的素材',content:'待归类'}},
  {id:'p1',kind:'project',revision:1,data:{title:'示例科技'}},
 ];
 const send=async(action,payload)=>action==='artifact_state'?{status:payload.id==='m1'?'current':'unknown',size:payload.id==='m1'?3914:null}:{items:materials};
 const opened=[];
 const view=mountKnowledge(document,materials,'files',{open:id=>opened.push(['detail',id]),send,openFile:id=>opened.push(['file',id])});
 await new Promise(resolve=>setTimeout(resolve,40));
 const cards=[...document.querySelectorAll('#knowbody [data-id]')];
 assert.equal(cards.length,3,'文件与资料页只渲染材料卡片');
 const first=cards.find(card=>card.dataset.id==='m1');
 assert.match(first.textContent,/transcripts\/纪要\.md/,'卡片必须显示文件路径');
 assert.match(first.textContent,/大小：3\.8 KB/,'卡片必须显示文件大小');
 assert.match(first.textContent,/与磁盘一致/,'卡片必须显示文件与记录是否一致');
 assert.match(first.textContent,/归属：示例科技/,'卡片必须显示归属项目');
 assert.match(first.textContent,/打开/);
 const second=cards.find(card=>card.dataset.id==='m2');
 assert.match(second.textContent,/仅正文（没有文件路径）/,'没有路径的材料要如实说明');
 assert.match(second.textContent,/归属：示例科技/,'有归属就显示归属项目');
 const third=cards.find(card=>card.dataset.id==='m3');
 assert.match(third.textContent,/归属：未归属/,'没有归属就如实写未归属');
 // 点「打开」走文件入口
 first.querySelector('[data-fileopen]').click();
 assert.deepEqual(opened,[['file','m1']]);
 view.dispose();dom.window.close();
});
