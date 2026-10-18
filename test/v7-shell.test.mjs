import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {JSDOM} from '../dev-deps.mjs';
import {buildShell,designSprite} from '../prototype/build-shell.mjs';
import {mountNavigation} from '../prototype/navigation.mjs';
const source=readFileSync(new URL('../../工作台-视觉原型-v7.html',import.meta.url),'utf8');
test('live V7 shell preserves initialized controls and styles without demonstration data',()=>{
 const original=new JSDOM(source,{runScripts:'dangerously',beforeParse(w){w.ResizeObserver=class{observe(){}};}}),live=new JSDOM(buildShell(source));
 try{const a=original.window.document,b=live.window.document;
 // 样式层：除**已登记的差异**外与原型逐字一致。
 // 已登记差异（2026-10-14）：外壳里 `.canvas-full` 那 3 处 `!important` 按 VI §12 V6 清理掉了 ——
 //   `#globalCanvas` 元素上并没有内联样式（登记表原先写的"必须压过原型内联色"与事实不符），
 //   类选择器的优先级本来就够，那 3 处 !important 从来没压过任何东西。
 const dropCanvasImportant=text=>text.replace(/(\.canvas-full\{)([^}]*)(\})/g,(whole,open,body,close)=>open+body.replace(/!important/g,'')+close);
 // 已登记差异（2026-10-16）：VI §3.3 只允许 400 / 550（数据）/ 600（标题），
 // 而冻结原型里留着 620 / 650（"比 600 更重"的随手值）与 500（不在阶上）。
 // 与上面那 3 处 !important 同一套做法：**冻结原型一个字不改**，在生成期按 VI 收敛。
 // 注意这里只放行"字重收敛"这一项，其余样式仍然要求与原型逐字一致。
 // 已登记差异（2026-10-16，第二项）：VI §2.2「代码内字面色值 = 0」——生成期只收敛了 hex，
 // **具名颜色漏了过去**（原型里 17 处 `white`，都是颜色位置，不是 white-space）。
 // 换成 `var(--ws-surface)`：浅色下就是 #FFFFFF（零视觉变化），深色下不再硬留一片白。
 const dropViWeights=text=>text.replace(/font-weight:\s*(620|650|700)\b/g,'font-weight:600').replace(/font-weight:\s*500\b/g,'font-weight:550');
 const dropViNamedColors=text=>text.replace(/\bwhite\b(?!-space)/g,'var(--ws-surface)');
 // 已登记差异（2026-10-16，第三项）：VI §4 断点是 **701–1199 双列**，原型写的是 1150
 // （1151–1199 会走全量）。同样在生成期按规范收口，冻结原型一个字不改。
 const dropViBreakpoints=text=>text.replace(/max-width:1150px/g,'max-width:1199px');
 // 已登记差异（2026-10-16，第四项）：VI §11.6 要求 **≤700 单列**，原型的 700 断点只把
 // .lower/.kanban/.resourcegrid 收成单列，漏了 .metrics/.projectstrip —— 生成期按规范补上单列。
 // 方向是**往期望值（原型那侧）补上这条规则**，让两边一致 —— 不是从生成物里删掉它。
 const dropViMobileColumns=text=>text.replace(/(\.metrics,\.projectstrip\{gap:[^}]*?)\}/, '$1;grid-template-columns:1fr}');
 // 已登记差异（2026-10-16，第五项）：VI §4 圆角标尺（控件 8 · 内容容器 12 · 弹窗 20 · 标签 999）。
 // 冻结原型里有 27 处标尺外圆角，生成期按"最近的标尺值"收敛。
 // 实测其中绝大多数**根本不生效**（死声明），真正渲染的只有画布工具条 input 的 9px（→8px，差 1px）。
 // 已登记差异（2026-10-16，第六项）：VI §4 间距标尺没有 22px，而原型有 4 处 `margin:22px`
 // （`.sectionhead`/`.footer`/`.drawer h2`/任务区，含一处内联属性）。实测**确实渲染**，
 // 生成期收敛到 24px（差 2px）—— 这是本轮唯一会动的视觉值，已由几何与像素门禁盯住。
 // 已登记差异（2026-10-17，第七项）：VI §3 字阶 —— 11px 只许用于"时间、坐标"，
 // 原型的 10px（脚注/说明）在生成期升到**辅助档 12px**；`<style>` 里的 11px 同样升 12。
 const dropViFontSizes=text=>text.replace(/font-size:\s*(?:9|10|11)(?:\.\d+)?px/g,'font-size:12px');
 const dropViSpacing=text=>text.replace(/((?:margin|padding|gap)(?:-[a-z]+)?:\s*)22px/g, '$124px');
 const dropViRadii=text=>text.replace(/border-radius:\s*(\d+)px/g, (whole, value) => {
   const px=Number(value);
   if([8,12,20,999].includes(px))return whole;
   const nearest=[8,12,20].reduce((best,scale)=>Math.abs(scale-px)<Math.abs(best-px)?scale:best,8);
   return 'border-radius:'+nearest+'px';
 });
   assert.equal(b.querySelector('style').textContent,dropViFontSizes(dropViSpacing(dropViRadii(dropViMobileColumns(dropViBreakpoints(dropViNamedColors(dropViWeights(dropCanvasImportant(a.querySelector('style').textContent)))))))),'除已登记的 !important 清理与 VI 字重收敛外，样式层必须与原型逐字一致');
 assert.doesNotMatch(b.querySelector('style').textContent,/font-weight:\s*(500|620|650|700)\b/,'VI §3.3：字重只允许 400 / 550 / 600');
 // 注意：**不要**在这里断言"没有字面色值" —— buildShell 的输出还没经过 tokenizeShell，
 // 原始 hex 是中间态（最终产物 src/v7-shell.html 才是零字面色值，由 charter-guard 的门禁 1 管）。
 assert.doesNotMatch(b.querySelector('style').textContent,/\.canvas-full\{[^}]*!important/,'VI §12：canvas-full 不许再带 !important 覆盖色');

 // 三处**用户明确要求**的差异：①VI 验收第 3 条「主按钮只有一个」→ 顶栏「新建」降为次操作；
 // ③用户 2026-10-12 明确授权「把收件箱入口提到顶部」→ 侧栏新增「收件箱」一级入口、知识页签里的同名入口下线。
 // ②用户要求"画布里的节点要能增删" → 画布工具栏新增「新建节点」。除此之外控件清单必须与原型逐项一致。
 const controls=d=>[...d.querySelectorAll('.nav button,.top button,.hero button,.toolbar button,.spacebar button,.spacetools button')]
  .filter(n=>n.id!=='spacenew') // ② 画布新增节点按钮：原型没有，属本次批准的新增
  .filter(n=>n.dataset.view!=='inbox') // ③ 收件箱入口：用户 2026-10-12 授权新增，下面单独断言
  .filter(n=>n.dataset.know!=='inbox') // ③ 参考页里的「知识·收件箱」页签：已按授权挪到侧栏，下面单独断言它下线
  // 2026-10-14 登记的差异：按钮开头的全角「＋」换成了 VI 加号图标（VI §5 V9 不许拿文字符号当图标），
  // 所以文本里不再有那个符号。比较时两侧都剥掉开头的加号，控件清单本身仍然逐项对照。
  // 登记的符号收口：开头的「＋」「−」换成 VI 图标（加号/减号）、结尾的「↗」去掉（都属 VI §5 V9）。
  .map(n=>[n.id,n.textContent.replace(/^[＋+−]\s*/,'').replace(/\s*↗\s*$/,''),n.id==='create'?'btn':n.className]);
 assert.deepEqual(controls(b),controls(a),'除已批准的三处改动外，控件清单必须与原型逐项一致');
 assert.equal(b.querySelector('#spacenew')?.textContent,'新建节点','画布必须提供新增节点入口');
 // ③ 依据：用户 2026-10-12 明确授权把收件箱入口提到顶部（不是实现者自作主张）。
 assert.equal(a.querySelector('.nav [data-view="inbox"]'),null,'设计方参考页里没有收件箱一级入口');
 assert.equal(a.querySelector('#knowtabs [data-know="inbox"]')?.textContent.replace(/\s+/g,''),'收件箱','参考页里它原本是「知识」的二级页签');
 assert.equal(b.querySelector('.nav [data-view="inbox"]')?.textContent.replace(/\s+/g,''),'收件箱','构建后必须有侧栏「收件箱」入口');
 assert.equal(b.querySelector('#knowtabs [data-know="inbox"]'),null,'构建后不再在「知识」下重复一个收件箱入口');
 assert.equal(a.querySelector('.top #create').className,'btn primary','原型里新建原本是主按钮');
 assert.equal(b.querySelector('.top #create').className,'btn','构建后必须降为次操作');
 assert.deepEqual([...b.querySelectorAll('.view')].map(n=>n.id),['home','inbox','space','projects','tasks','knowledge','personal'],'收件箱是构建期注入的第 7 个页面（用户 2026-10-12 授权）');
 assert.equal(b.querySelector('#inboxbody')?.id,'inboxbody','收件箱页面必须带自己的容器');
 assert.equal(b.querySelectorAll('script').length,1);assert.equal(b.querySelector('script').getAttribute('src'),'/personal-workstation/v7/app.mjs');
 for(const id of ['projectstrip','tasksbody','spaceSvg','knowbody'])assert.equal(b.getElementById(id).children.length,0);
 assert.equal(b.querySelector('#projectfocus').options.length,1);
 assert.equal(b.querySelector('#home .lower svg:not(.icon)').children.length,0);
 const navigation=mountNavigation(b);for(const name of ['space','projects','tasks','knowledge','personal','inbox','home']){b.querySelector('.nav [data-view="'+name+'"]').click();assert.equal(b.querySelector('.view.active').id,name);assert.equal(b.querySelectorAll('.view.active').length,1);assert.equal(b.querySelector('.nav [aria-current="page"]').dataset.view,name);}b.querySelector('[data-goto="projects"]').click();assert.equal(b.querySelector('.view.active').id,'projects');navigation.dispose();
 assert.doesNotMatch(b.body.textContent,/伙伴 A|伙伴 B|伙伴 C|伙伴 D|联合验证方案交流|技术路线研究|试点范围跟进|所有数字与状态均为演示|示例计划/);
 }finally{original.window.close();live.window.close();}
});
test('the shell ships the 纸上秩序 icon set and every referenced icon resolves',()=>{
 const live=new JSDOM(buildShell(source)),b=live.window.document;
 try{
  assert.equal(b.querySelectorAll('body > svg[aria-hidden] defs symbol').length>30,true,'外壳应内置完整的 VI 图标集');
  for(const node of b.querySelectorAll('use')){
   const id=(node.getAttribute('href')||'').replace('#','');
   assert(id,'<use> 必须有引用目标');
   assert(b.getElementById(id),'静态图标缺失：'+id);
  }
  // 模块里动态引用（#i-<名> 与 icon('<名>')）的图标也必须在同一 sprite 中。
  const names=new Set();
  for(const file of readdirSync(new URL('../prototype/',import.meta.url)).filter(name=>name.endsWith('.mjs'))){
   const text=readFileSync(new URL('../prototype/'+file,import.meta.url),'utf8');
   for(const match of text.matchAll(/#i-([a-z]+)/g))names.add(match[1]);
   for(const match of text.matchAll(/\bicon\('([a-z]+)'\)/g))names.add(match[1]);
  }
  for(const name of names)assert(b.getElementById('i-'+name),'模块引用的图标缺失：i-'+name);
  assert.equal(designSprite().includes('id="i-inbox"'),true,'VI 图标集应包含收件箱图标');
  assert.doesNotMatch(designSprite(),/fill="white"/,'VI 图标不应保留原型里为白底挖空而写的实心填充');
 }finally{live.window.close()}
});
