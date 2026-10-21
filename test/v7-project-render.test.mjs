import {test} from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {runInNewContext} from 'node:vm';import {projectCard,ring} from '../prototype/project-render.mjs';
// 卡片结构与原型逐字一致；颜色改为自定义属性（外观不变），以便深色层按 VI token 压暗对象编码色。
// 结构骨架：忽略承载主题变量与轨道色的属性值，其余逐字比较。
// 结构骨架：忽略内联样式与 SVG 上色属性（颜色写法在批次 5 收敛后会变，值不变），其余逐字比较。
//
// 字阶（2026-10-14）：冻结原型把环内数字写成 font-size="16"，而 VI §3 的字阶是**唯一一套**
// （11/12/13/14/15/18/22/32），没有 16px。用户 2026-10-13 已拍板「VI 优先，允许按规范改结构」，
// 所以实现侧把它落到最近档 15px。比较时对**两侧**用同一个"入字阶"函数归一化：
// 结构差异照旧逐字暴露，而"原型 ↔ 字阶"这一处已登记且唯一的偏差不会被误报成结构改动。
const TYPE_SCALE=[11,12,13,14,15,18,22,32];
const snapType=value=>{const n=Number(value);if(TYPE_SCALE.includes(n))return n;if(n<TYPE_SCALE[0])return TYPE_SCALE[0];return TYPE_SCALE.reduce((best,candidate)=>Math.abs(candidate-n)<Math.abs(best-n)?candidate:best,TYPE_SCALE[0])};
const skeleton=html=>html.replace(/ style="[^"]*"/g,'').replace(/ (?:fill|stroke)="[^"]*"/g,'').replace(/ font-size="(\d+(?:\.\d+)?)"/g,(whole,size)=>' font-size="'+snapType(size)+'"');
test('project card keeps the V7 four-row skeleton (partner, priority, stage, stats)',()=>{
 const p={id:'p',name:'项目',partner:'合作方',done:2,total:4,color:'#6488d6',bg:'#edf2ff',icon:'chip',stage:2,docs:3,block:1};
 const html=projectCard(p);
 assert.match(html,/^<button class="project surface"/);
 for(const cls of ['projecttop','symbol','mini-ring','projectpartner','projectmeta','projecttagline','projectnumbers'])assert.match(html,new RegExp('class="'+cls+'"'),'卡片必须有 '+cls);
 // 一张卡一次（PJ-01）：阶段不再另画五格步骤条，交付进度只在环 + 数字里表达一次。
 assert.doesNotMatch(html,/class="steps"/,'不再画与阶段标签重复的步骤条');
 assert.match(html,/class="projectmeta">负责人/,'卡片要写负责人（没有就如实写未设置）');
 assert.match(html,/截止 /,'卡片要写截止日期（没有就如实写无截止）');
 assert.match(html,/class="chip">阶段未设置</,'阶段是卡片第一行信息');
 assert.match(html,/尚未设置|2\/4/,'交付项必须如实显示');
 assert.match(ring(2,4),/font-size="15"/,'环内数字必须落在 VI 字阶内');

 assert.match(projectCard(p),/style="--pc:[^;"]+;--pb:[^;"]+;color:var\(--pc\);background:var\(--pb\)"/,'色值必须走自定义属性');
});
test('real project text is escaped and missing progress is not a fabricated percentage',()=>{const html=projectCard({id:'" onclick="bad',name:'<script>bad</script>',partner:'A & B',done:0,total:0,color:'#6488d6',bg:'#edf2ff',icon:'chip',stage:null,docs:0,block:0});assert(!html.includes('<script>'));assert(html.includes('&lt;script&gt;'));assert(html.includes('A &amp; B'));assert(html.includes('尚无交付项'));assert(!html.includes('mini-ring'),'0/0 不画环');assert(!html.includes('0%'));});
