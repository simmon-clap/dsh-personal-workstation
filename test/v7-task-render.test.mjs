import {test} from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {runInNewContext} from 'node:vm';import {taskModel,taskRow} from '../prototype/task-render.mjs';
test('task rows preserve exact V7 structure with real step flags',()=>{const source=readFileSync(new URL('../prototype/replica/core.js',import.meta.url),'utf8');const start=source.indexOf('function taskrow('),end=source.indexOf('\nconst total=',start);const original=runInNewContext(source.slice(start,end)+';taskrow',{projects:[{id:'p',name:'项目'}],icon:n=>`<svg class="icon" aria-hidden="true"><use href="#i-${n}"/></svg>`,pct:(a,b)=>Math.round(a/b*100)});const t={id:'t',name:'任务',project:'p',target:'本机',state:'等待中',done:1,total:2,steps:['a','b']};const real=taskModel({id:'t',data:{title:'任务',projectId:'p',status:'waiting',executionTarget:'local',steps:[{title:'a',done:true},{title:'b',done:false}]}},[{id:'p',name:'项目'}]);// V7 结构必须保持：把文本抹掉后逐字符比对（符号/strong/small/taskrail/右侧计数）。
 // 文案可以按需求增补（本次加了"等待原因"与"支撑交付项"），结构不许变。
 // 结构比对：把**颜色值**归一化。批次 5 收敛后，同一处颜色可能是原字面量、VI 变量或登记的数据色，
 // 三者值等价、只是写法不同；结构（标签、层级、类名、步骤旗标、右侧计数）仍逐字符比。
 const shape=html=>String(html).replace(/ data-density="standard"/g,'').replace(/>[^<>]+</g,'><')
  .replace(/style="[^"]*"/g,attr=>attr.includes(':')?'style="{value}"':'style=""')
  .replace(/ (?:fill|stroke)="[^"]*"/g,' data-paint="{value}"');
 assert.equal(shape(taskRow(real)),shape(original(t)),'任务行结构必须与 V7 原型一致（只多了登记过的密度标记）');
 assert.match(taskRow(real),/data-density="standard"/,'任务行必须带登记过的卡片密度标记（spec/56 §1）');
 // 等待中的任务必须说清原因；没有原因就如实写"原因未记录"，不能留空。
 assert.match(taskRow(real),/等待中（原因未记录）/);
 assert.match(taskRow(taskModel({id:'w',data:{title:'任务',projectId:'p',status:'waiting',blockedReason:'等对方给开发板',executionTarget:'local'}},[{id:'p',name:'项目'}])),/等待中（等对方给开发板）/);assert(!taskRow(taskModel({id:'empty',data:{title:'任务'}},[])).includes('NaN'));});
