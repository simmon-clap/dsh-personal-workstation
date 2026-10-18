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
test('project card keeps the original V7 structure while colours move to custom properties',()=>{
 const source=readFileSync(new URL('../prototype/replica/core.js',import.meta.url),'utf8');
 const start=source.indexOf('const pct='),end=source.indexOf('\nfunction gantt(');
 const original=runInNewContext(source.slice(start,end)+';({card,ring})');
 const p={id:'p',name:'项目',partner:'合作方',done:2,total:4,color:'#6488d6',bg:'#edf2ff',icon:'chip',stage:2,docs:3,block:1};
 assert.equal(skeleton(projectCard(p)),skeleton(original.card(p)),'除内联样式外必须与原型标记完全一致');
 assert.match(ring(2,4),/font-size="15"/,'环内数字必须落在 VI 字阶内（原型 16px 不在字阶，落到 15px）；改回字阶外字号这里会红');
 const C='(?:#6488d6|var\\(--ws-data-partner-1\\))',B='(?:#edf2ff|var\\(--ws-data-partner-1-soft\\))';
 assert.match(projectCard(p),new RegExp('style="--pc:'+C+';--pb:'+B+';color:var\\(--pc\\);background:var\\(--pb\\)"'),'色值必须走自定义属性（VI token 或登记的数据色），深色层才能压暗而不自造颜色');
 assert.match(projectCard(p),new RegExp('<i style="--pc:'+C+';background:var\\(--pc\\)"><\\/i><i style="--pc:'+C+';"><\\/i>'),'已完成步骤填充、未完成步骤留空的结构必须保留');
 // 环：结构与几何必须一致，上色写法允许不同（VI 变量 / 数据变量 / 原字面量，值等价）。
 assert.equal(skeleton(ring(2,4)),skeleton(original.ring(2,4).replace('stroke="#edf0f5"','stroke="var(--ring-track,#edf0f5)"')));
});
test('real project text is escaped and missing progress is not a fabricated percentage',()=>{const html=projectCard({id:'" onclick="bad',name:'<script>bad</script>',partner:'A & B',done:0,total:0,color:'#6488d6',bg:'#edf2ff',icon:'chip',stage:null,docs:0,block:0});assert(!html.includes('<script>'));assert(html.includes('&lt;script&gt;'));assert(html.includes('A &amp; B'));assert(html.includes('尚无交付项'));assert(!html.includes('0%'));});
