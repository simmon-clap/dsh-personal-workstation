import {test} from 'node:test';
import assert from 'node:assert/strict';
import {CARD_DENSITIES, cardDensityAttr, cardOpen, cardClose, cardTitle, cardMetaLine} from '../prototype/card.mjs';
import {projectCard} from '../prototype/project-render.mjs';
import {taskRow} from '../prototype/task-render.mjs';

/** 卡片外壳（spec/54 §4 · spec/56 §1）：一张卡的外壳/密度/标题/元信息行只有一处实现。
 *  这里钉住的是「唯一来源」与「两档密度」，不是视觉细节 —— 视觉由 CSS + 夹具截图负责。 */
test('密度只有登记过的两档；传错当场报错，不悄悄降级',()=>{
 assert.deepEqual([...CARD_DENSITIES],['standard','canvasNode']);
 assert.equal(cardDensityAttr(),' data-density="standard"');
 assert.equal(cardDensityAttr('canvasNode'),' data-density="canvasNode"');
 assert.throws(()=>cardDensityAttr('dense'),/未登记的卡片密度/);
});

test('外壳属性顺序固定：class → 密度 → 角色/序号 → 业务标识 → 额外属性',()=>{
 assert.equal(cardOpen({className:'project surface',project:'p1'}),'<button class="project surface" data-density="standard" data-project="p1">');
 assert.equal(cardOpen({tag:'div',className:'surface resource inboxcard',role:'button',tabindex:0,batch:'b1',extra:' data-advice="1"'}),'<div class="surface resource inboxcard" data-density="standard" role="button" tabindex="0" data-batch="b1" data-advice="1">');
 assert.equal(cardOpen({task:'t1'}),'<button data-density="standard" data-task="t1">');
 assert.equal(cardClose(),'</button>');assert.equal(cardClose('div'),'</div>');
});

test('标题与元信息行：统一转义、空片段不留孤零零的分隔符',()=>{
 assert.equal(cardTitle('<script>x</script>'),'<h3>&lt;script&gt;x&lt;/script&gt;</h3>');
 assert.equal(cardTitle('标题',{tag:'h2'}),'<h2>标题</h2>');
 assert.equal(cardMetaLine(['负责人 张三','','无截止']),'<p>负责人 张三 · 无截止</p>');
 assert.equal(cardMetaLine([],{className:'projectmeta'}),'<p class="projectmeta"></p>');
});

test('项目卡与任务卡的外壳真的来自 card.mjs（输出带登记密度）',()=>{
 const project=projectCard({id:'p',name:'项目',partner:'',done:1,total:2,color:'var(--ws-action)',bg:'var(--ws-action-soft)',docs:0,block:0,tasks:1});
 assert.match(project,/^<button class="project surface" data-density="standard" data-project="p">/);
 assert(project.endsWith('</button>'));
 const task=taskRow({id:'t',name:'任务',projectName:'项目',target:'本机',state:'待办',done:0,total:0,steps:[]});
 assert.match(task,/^<button class="taskrow" data-density="standard" data-task="t">/);
 assert(task.endsWith('</button>'));
 assert(!task.includes('0/0'),'0/0 不画成指标（S4）');
});
