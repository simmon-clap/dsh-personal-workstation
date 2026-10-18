import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from '../dev-deps.mjs';

// VI「纸上秩序」验收清单里可以机械核对的部分（其余条目由浏览器对照与账本记录）。
const shellHtml=readFileSync(new URL('../src/v7-shell.html',import.meta.url),'utf8');
const visual=readFileSync(new URL('../src/v7/v7-visual.css',import.meta.url),'utf8');
const dom=()=>new JSDOM(shellHtml);
test('VI-1 page header keeps a breadcrumb and small hint without a display slogan',()=>{
 const document=dom().window.document,top=document.querySelector('.top');
 assert(top,'页头必须存在');
 assert(document.querySelector('.top .breadcrumb'),'页头必须保留面包屑');
 assert(document.querySelector('.top #subtitle'),'页头必须保留小字提示');
 assert.equal(top.querySelectorAll('h1,h2,h3').length,0,'页头不得再出现大号宣传句');
 // VI §3：11 只留给"时间、坐标"；页头提示属于**辅助信息**，用辅助档 12px。
 assert.match(document.querySelector('#subtitle').getAttribute('style')??'',/font-size:\s*12px/,'提示必须是辅助档小字（12px）');
});
test('VI-2 geometry holds: 204px sidebar, 76px top bar, 32px page margin, 12px container radius',()=>{
 assert.match(shellHtml,/\.nav\{[^}]*width:204px/,'侧栏必须为 204px');
 assert.match(shellHtml,/main\{[^}]*margin-left:204px/,'主区必须让出侧栏宽度');
 assert.match(shellHtml,/main\{[^}]*padding:0 32px/,'页边距必须为 32px');
 assert.match(visual,/\.top\{height:76px\}/,'顶栏必须落在 72–80px');
 assert.match(visual,/\.surface,\.metric\{[^}]*border-radius:12px/,'内容容器圆角必须为 12px');
});
test('VI-3 the top bar exposes exactly one primary action',()=>{
 const document=dom().window.document;
 const primaries=[...document.querySelectorAll('.top .actions .btn.primary')];
 assert.equal(primaries.length,1,'主按钮只能有一个，实际 '+primaries.length+' 个');
 assert.match(primaries[0].textContent,/录入/,'留在顶栏的主操作应是「录入」');
 const create=document.querySelector('.top .actions #create');
 assert(create,'新建入口必须仍在顶栏');
 assert(!create.classList.contains('primary'),'新建必须降为白底描边的次操作，类名与视觉一致');
 const secondary=[...document.querySelectorAll('.top .actions .btn')].filter(node=>node!==primaries[0]);
 assert(secondary.length>=2,'次操作应与主操作区分开');
});
test('VI-4 dialogs are centred, and VI-9 mobile targets and focus ring match the spec',()=>{
 assert.match(shellHtml,/\.veil\.open\{[^}]*display:flex[^}]*align-items:center[^}]*justify-content:center/,'详情必须是居中弹窗');
 assert.match(visual,/min-height:44px/,'移动端点击目标至少 44px');
 assert.match(visual,/\.btn\{min-height:44px\}/,'移动端按钮必须达到 44px');
 assert.match(visual,/outline:3px solid/,'焦点环必须为 3px');
});
test('VI-10 illustrations assist only, and decorative gradients are overridden by the VI layer',()=>{
 // 插画只允许出现在手册指定的位置：关联空间入口装饰与空态。
 const references=[...`${shellHtml}\n${visual}`.matchAll(/assets\/illustrations\/[a-z-]+\.svg/g)].map(match=>match[0]);
 assert.deepEqual([...new Set(references)],['assets/illustrations/connections.svg'],'样式层只应引用手册指定的入口插画；空态插画由空态组件按需生成');
 assert.match(visual,/\.spaceentry:before\{[^}]*illustrations\/connections\.svg/,'入口插画必须作为装饰而非数据');
 assert.match(shellHtml,/\.v7-empty img\{[^}]*width:180px/,'空态插画尺寸受限，不会盖住数据');
 // 原型底层的装饰性渐变必须被 VI 覆盖：页面底色为纸色，品牌区不再用渐变色块。
 assert.match(shellHtml,/body\{[^}]*radial-gradient/,'原型底层确有装饰性渐变');
 // 断言「效果」而不是写法：底色必须是纸色 —— 允许字面色值或取自 tokens 的变量（批次 5 收敛后是变量）。
 assert.match(visual,/body\{background:(#f8f9f7|var\(--ws-paper\))/i,'VI 必须把页面底色覆盖为纯色纸面');
 assert.match(visual,/\.brandmark\{background:none/,'VI 必须去掉品牌区的渐变色块');
});
