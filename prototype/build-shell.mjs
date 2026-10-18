import {readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {JSDOM} from '../dev-deps.mjs';
import {PRESETS,tokenizeShell} from './shell-tokenize.mjs';

// 「纸上秩序」图标集：以 VI 图标替换原型自绘 sprite，同时保留原型与模块使用的 #i-* 名称。
const icons=new URL('../../design-system/assets/icons/',import.meta.url);
const iconNames=readdirSync(fileURLToPath(icons)).filter(name=>name.endsWith('.svg')).map(name=>name.replace('.svg',''));
const aliases={home:'overview',star:'assistant',doc:'file',chip:'chip'};

function iconBody(name){
 const source=readFileSync(new URL(name+'.svg',icons),'utf8');
 const inner=source.replace(/^[\s\S]*?<svg[^>]*>/,'').replace(/<\/svg>\s*$/,'').trim();
 if(!inner)throw Error('VI 图标为空：'+name);
 return inner;
}
/** 用 VI 图标重建 sprite；原型的 #i-* 名称保持可用，另外补上 VI 新增的名称。 */
export function designSprite(){
 const ids=[...new Set([...Object.keys(aliases),...iconNames])];
 return '<svg style="display:none" aria-hidden="true"><defs>'+ids.map(id=>`<symbol id="i-${id}" viewBox="0 0 24 24">${iconBody(aliases[id]??id)}</symbol>`).join('')+'</defs></svg>';
}

export function buildShell(source){
 if(createHash('sha256').update(source).digest('hex')!=='e863a0aa7765968243689307240222cc87aac91539ed3cb7ab86726d9cd5f4a5')throw Error('V7基线变化，请重新核对');
 const dom=new JSDOM(source,{runScripts:'dangerously',pretendToBeVisual:true,beforeParse(w){w.ResizeObserver=class{observe(){}disconnect(){}};}});
 try{
 const d=dom.window.document;
 for(const script of d.querySelectorAll('script'))script.remove();
 // 以 VI 图标替换原型 sprite，保留 #i-* 名称；先取原型仍在使用的 id，确保不会漏掉。
 const used=new Set([...d.querySelectorAll('use')].map(node=>(node.getAttribute('href')||'').replace('#i-','')).filter(Boolean));
 // 模块里用 #i-<名> 或 icon('<名>') 动态引用的图标也必须存在，否则运行时会出现空图标。
 for(const file of readdirSync(fileURLToPath(new URL('./',import.meta.url))).filter(name=>name.endsWith('.mjs')&&!['build-shell.mjs','build-v7.mjs','extract-v7.mjs','verify-v7.mjs','visual-check.mjs','control-audit.mjs','visual-seed.mjs'].includes(name))){
  const text=readFileSync(new URL('./'+file,import.meta.url),'utf8');
  for(const match of text.matchAll(/#i-([a-z]+)/g))used.add(match[1]);
  for(const match of text.matchAll(/\bicon\('([a-z]+)'\)/g))used.add(match[1]);
 }
 const sprite=designSprite();
 for(const id of used)if(!sprite.includes('id="i-'+id+'"'))throw Error('V7 引用了 VI 图标集中不存在的图标：'+id);
 d.querySelector('body > svg[aria-hidden]')?.remove();
 d.body.insertAdjacentHTML('afterbegin',sprite);
 for(const id of ['metrics','projectstrip','roadmap','taskmini','projectsbody','taskmetrics','tasksbody','knowbody','personalbody','spaceSvg','detailbody'])d.getElementById(id).replaceChildren();
 const lower=d.querySelector('#home .lower');
 for(const row of lower.querySelectorAll('.scheduleline,[data-note]'))row.remove();
 for(const micro of lower.querySelectorAll('svg:not(.icon)'))micro.replaceChildren();
 // Keep the original focus selector, but no demonstration project options.
 const focus=d.querySelector('#projectfocus');while(focus.options.length>1)focus.remove(1);
 // VI §5 V9：图标是 24×24 / 1.6px 的线稿，**不许拿文字符号当图标**（`＋` U+FF0B、`↗` U+2197 这类）。
 // 门禁原来只查 emoji 码位（\p{Extended_Pictographic}），而 `＋`/`−`/`×` 都不是 emoji，所以一路漏过。
 // 这里在生成期把「＋ 录入」「＋ 新建项目」这类按钮换成真图标；`−`（缩小）属于数值控件的运算符，
 // 与它成对的放大键已按同一形状处理，暂留并记账（见审计报告）。
 for(const button of d.querySelectorAll('button')){
  let text=(button.textContent||'').replace(/\s+/g,' ').trim();
  const glyph=text.startsWith('＋')?'plus':text.startsWith('−')?'minus':null;
  if(glyph&&!button.querySelector('svg')){
   const label=text.replace(/^[＋−]\s*/,'');
   button.textContent='';
   button.insertAdjacentHTML('afterbegin','<svg class="icon" aria-hidden="true"><use href="#i-'+glyph+'"/></svg>');
   if(label)button.append(label);
   if(!button.getAttribute('aria-label')&&label)button.setAttribute('aria-label',label);
   text=label;
  }
  // 文案末尾的「↗」（"去那边"）也是拿符号当图标。只改文字节点，别动子元素里的真图标。
  if(text.endsWith('↗')){
   for(const node of button.childNodes){
    if(node.nodeType===3&&node.textContent.includes('↗'))node.textContent=node.textContent.replace(/\s*↗\s*/g,'');
   }
  }
 }
 // VI §3：产品页**不设大号宣传句**（页头＝面包屑 + 一行小字提示）。用户 2026-10-10 也明确要求过
 // 「移除每页大号口号及标题区，仅顶栏小字 tips」——首页那条「让分散的工作，连成一张图。」一直还在。
 // 这里只删**宣传句**，保留它的功能说明与「打开关联空间」入口（信息架构与入口清单不动）。
 const promo=d.querySelector('#home .spaceentry h3');
 if(promo&&/让分散的工作/.test(promo.textContent))promo.remove();
 // #24（独立走查 P2）：「点击项目查看量化详情」被写成了 <span class="chip"> ——
 // 136×36、描边、圆角，长得就是个按钮，**实测点了没反应**。它本来就是一句说明，
 // 那就让它长得像说明（诚实：不装成能点的样子）。
 for(const hint of d.querySelectorAll('#projects .chip, #projects span')) {
  if(hint.textContent.trim() !== '点击项目查看量化详情') continue;
  if(hint.tagName.toLowerCase() !== 'span') continue;
  hint.className = 'hint';
 }
 // VI §2：冻结原型把「执行视图」这个**跳转动作**写成了 knowledge 紫，而且是 inline style
 // —— inline 压过任何样式表规则，所以只能在生成期摘掉，改由样式表给中性色。
 // （与 VI 冲突时不改冻结原型，在生成期纠正 —— 本仓库既定做法。）
 const execViewColor=d.querySelector('#home .panelhead button[data-goto="tasks"]');
 if(execViewColor)execViewColor.removeAttribute('style');
 // VI §12 V6：外壳里 3 处 `!important` 覆盖色必须清理。登记表写的理由是"必须压过原型内联色"，
 // 但实测 `#globalCanvas`（`.btn.canvas-full`）**元素上没有内联样式**，类选择器的优先级本来就够——
 // 也就是说这 3 处 !important 从来没有压过任何东西，只是让门禁 9「!important 覆盖色 = 0」永远过不去。
 // 冻结原型一个字不改，在生成期把这三个 !important 摘掉；同值的无 !important 规则由 v7-workbench.css 接管。
 for(const rule of d.querySelectorAll('style')){
  if(!rule.textContent.includes('.canvas-full{'))continue;
  // 按**选择器**锚定、不按值匹配：此时还没经过 token 收敛，颜色仍是原型字面值。
  rule.textContent=rule.textContent.replace(/\.canvas-full\{([^}]*)\}/, (whole,body)=>'.canvas-full{'+body.replace(/!important/g,'')+'}');
 }
 // VI 优先 · §3.3 字重归一（2026-10-16）：规范只允许 400 / 550（数据）/ 600（标题），
 // 而冻结原型里还留着 620 / 650 / 500 —— 620 与 650 是"比 600 更重"的随手值，500 不在阶上。
 // 与上面三处 !important 同一套做法：**冻结原型一个字不改**，在生成期按 VI 收敛。
 // （可核对：`npm run verify` 的 type-scale-audit 现在会查字重，改坏了会红。）
 for(const rule of d.querySelectorAll('style')){
  rule.textContent=rule.textContent
   .replace(/font-weight:\s*(620|650|700)\b/g,'font-weight:600')
   .replace(/font-weight:\s*500\b/g,'font-weight:550')
   // VI §2.2「代码内字面色值 = 0」：生成期只收敛了 hex（tokenizeShell 干的），
   // **具名颜色漏了过去** —— 原型里 17 处 `white`（颜色位置，不是 white-space）。
   // 换成 --ws-surface（浅色下就是 #FFFFFF，零视觉变化；深色下不再硬留一片白，顺带修掉深色 bug）。
   .replace(/\bwhite\b(?!-space)/g,'var(--ws-surface)')
   // VI §4 断点：≥1200 全量 · **701–1199 双列** · ≤700 单列。
   // 原型写的是 `max-width:1150px`（1151–1199 这一段会走全量，与规范不符），按规范收到 1199。
   .replace(/max-width:1150px/g,'max-width:1199px')
   // VI §11.6：**≤700 单列**。原型在 700 断点里只把 .lower/.kanban/.resourcegrid 收成单列，
   // 漏了 .metrics 与 .projectstrip —— 它们继续吃 1150 断点的两列，于是手机上仍是 2 列（实测 390 确认）。
   // 取材**按规则原文精确定位**（`.metrics,.projectstrip{gap:10px}` 全文件唯一，只出现在 700 断点里），
   // 不用"块首匹配"那种写法 —— 那种写法我试过一次，规则不在块首，静默没生效。
   .replace(/\.metrics,\.projectstrip\{gap:10px\}/, '.metrics,.projectstrip{gap:10px;grid-template-columns:1fr}')
   // VI §4 圆角标尺：控件 8 · 内容容器 12 · 居中弹窗 20 · 标签 999。
   // 冻结原型里有 27 处标尺外圆角（3/4/5/7/9/10/11/13/14/15/18/19/22/25px）。
   // **实测（真浏览器逐元素量）**：其中绝大多数**根本不生效**（被后面的覆盖层压掉或没用到），
   // 真正渲染出来的只有一处 —— 画布工具条上的 `input`（9px，4 个元素）。
   // 这里按"最近的标尺值"在生成期收敛；对照实验证明确实渲染的那一处只差 1px，其余是死声明、零视觉影响。
   // VI §4 间距标尺（4/8/12/16/24/32/48/64/96）：原型里 4 处 `margin:22px`（.sectionhead / .footer /
   // .drawer h2 / 任务区）收敛到 24px。**实测它确实渲染出来了**（不像圆角那样大多是死声明），
   // 所以这是本次唯一会动的视觉值 —— 2px 的纵向节奏，收口时用几何与像素门禁盯住。
   // 注意覆盖面：第一版只写了 `margin:22px` 与 `margin-bottom:22px`，漏了两类 ——
   // ① `padding-inline:22px`（在 1150 媒体查询里）；② **内联属性** `style="margin-bottom:22px"`（不在 <style> 里）。
   // 所以这里按"padding/margin/gap 的任一变体"统一处理，并在下面单独走一遍内联属性。
   .replace(/((?:margin|padding|gap)(?:-[a-z]+)?:\s*)22px/g, '$124px')
   // 字号：VI 字阶里 **11px 只许用于「时间、坐标等非关键信息」**（规范 §3 表格最后一行），
   // 而冻结原型把 11px 用在了导航组标题、指标标签、按钮、芯片上 —— 这是**用错档**，不是标尺外。
   // 生成期统一抬到辅助档 12px；时间类（time 元素 / .caldate）在下面显式保留 11px。
   .replace(/font-size:\s*(?:9|10|11)px/g, 'font-size:12px')
   .replace(/border-radius:\s*(\d+)px/g, (whole, value) => {
     const px = Number(value);
     if ([8, 12, 20, 999].includes(px)) return whole;
     const nearest = [8, 12, 20].reduce((best, scale) => Math.abs(scale - px) < Math.abs(best - px) ? scale : best, 8);
     return 'border-radius:' + nearest + 'px';
   })
 }
 // 内联样式里的标尺外间距同样要收敛（`.metrics` 那处就是写在 style 属性里的）。
 for(const node of d.querySelectorAll('[style*="22px"]')){
  node.setAttribute('style', node.getAttribute('style').replace(/((?:margin|padding|gap)(?:-[a-z]+)?:\s*)22px/g, '$124px'));
 }
 d.querySelector('.top .chip').textContent='业务数据 · 按记录计算';
 d.querySelector('.navfoot small').textContent='DSH 工作台';
 const plan=d.querySelector('#home > .sectionhead .chip');if(plan)plan.textContent='项目计划区间';
 // 画布工具栏加「新建节点」：之前画布只能看和拖，不能新增对象。
 const relationList=d.querySelector('#allrelations');
 if(relationList&&!d.querySelector('#spacenew')){
  const button=d.createElement('button');
  // W2-2：每页只留顶栏「新建」一个主色动作；画布内的新建节点是次级动作。
  button.className='btn';button.id='spacenew';button.type='button';button.textContent='新建节点';
  relationList.after(button);
 }
 // 用户 2026-10-12 明确授权：把「收件箱」从「知识」二级页签**提到侧栏顶部**（第三处已批准差异）。
 // 设计方参考页保持原样、基线哈希不重算，所以这里与 spacenew / detailback / 顶栏降级用同一套构建期注入。
 const homeNav=d.querySelector('.nav [data-view="home"]');
 if(homeNav&&!d.querySelector('.nav [data-view="inbox"]')){
  const button=d.createElement('button');
  button.setAttribute('data-view','inbox');
  button.innerHTML='<svg class="icon"><use href="#i-inbox"/></svg>收件箱';
  homeNav.after(button);
 }
 if(!d.getElementById('inbox')){
  const section=d.createElement('section');
  section.id='inbox';section.className='view';
  section.innerHTML='<div class="sectionhead"><h2>收件箱</h2><small>要不要采纳，由你决定；确认前不改动任何业务数据</small></div><div id="inboxbody"></div>';
  d.getElementById('home').after(section);
 }
 // 入口是"挪"不是"复制"：知识页签里的收件箱随之下线，避免两个入口对同一份队列各说一套。
 const inboxTab=d.querySelector('#knowtabs [data-know="inbox"]');
 if(inboxTab)inboxTab.remove();
 const notices=d.querySelectorAll('#space > .canvasnotice');for(const n of notices)if(n.id!=='graphstatus')n.textContent='';
 // 手册「无障碍」：状态变化必须通过 aria-live 宣告。原型只有 role="status"，
 // 这里补上显式 aria-live，保证读屏软件在任何实现下都会播报。
 // 弹窗头部左侧加「返回」：所有详情/编辑器都有统一的返回入口（原来只有右上角 ✕）。
 const detailType=d.querySelector('#detailtype');
 if(detailType&&!d.querySelector('#detailback')){
  const back=d.createElement('button');
  back.className='back';back.id='detailback';back.type='button';back.setAttribute('aria-label','返回');
  back.innerHTML='<svg class="icon" style="width:16px;height:16px"><use href="#i-arrow"></use></svg><span>返回</span>';
  detailType.before(back);
 }
 for(const [selector,polite]of [['#toast','polite'],['#graphstatus','polite'],['#detailbody','off']]){
  const node=d.querySelector(selector);if(node&&polite!=='off')node.setAttribute('aria-live',polite);
 }
 const toast=d.querySelector('#toast');if(toast)toast.setAttribute('aria-atomic','true');
 d.querySelector('#tasks > .notice').textContent='进度 = 已完成步骤 / 总步骤。';
 for(const n of d.querySelectorAll('.footer span'))n.textContent='';
 // VI 标识：设计方参考页把 mark.svg 内联在 .brandmark 中，这里照做，品牌区不再用星形符号。
 const brandmark=d.querySelector('.brandmark');
 if(!brandmark)throw Error('外壳缺少品牌区');
 const markInner=readFileSync(new URL('../../design-system/assets/mark.svg',import.meta.url),'utf8').replace(/^[\s\S]*?<svg[^>]*>/,'').replace(/<\/svg>\s*$/,'').trim();
 if(!markInner)throw Error('VI 标识为空');
 brandmark.innerHTML='<svg viewBox="0 0 52 52" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="个人工作台标识">'+markInner+'</svg>';
 // VI 验收第 3 条「主按钮只有一个」：顶栏只保留「＋录入」为主色，其余降为白底描边。
 const createButton=d.querySelector('.top .actions #create');
 if(!createButton)throw Error('外壳缺少新建入口');
 createButton.className='btn';
 // 「纸上秩序」VI：变量与覆盖样式必须在原型内联样式之后加载，才能覆盖默认视觉。
 for(const [order,href]of [['tokens','/personal-workstation/v7/tokens.css'],['hosttheme','/personal-workstation/v7/v7-host-theme.css'],['data','/personal-workstation/v7/v7-data.css'],['visual','/personal-workstation/v7/v7-visual.css'],['dark','/personal-workstation/v7/v7-dark.css'],['contrast','/personal-workstation/v7/v7-contrast.css'],['workbench','/personal-workstation/v7/v7-workbench.css']]){
  const style=d.createElement('link');style.rel='stylesheet';style.href=href;style.dataset.design=order;d.head.append(style);
 }
 // 空态：极简样式由工作台自己维护，插画取 VI 资产（VI 只定义了手册里的展示样式）。
 const empty=d.createElement('style');empty.dataset.v7='empty-state';
 empty.textContent='.v7-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;padding:24px 16px;text-align:center;color:#626c78;grid-column:1/-1}.v7-empty img{width:180px;height:120px;opacity:.9}.v7-empty h3{margin:4px 0 0;font-size:14px;font-weight:550;color:#252a31}.v7-empty p{margin:0;font-size:12px;max-width:38ch;line-height:1.6}.v7-empty .btn{margin-top:8px}';
 d.head.append(empty);
 const link=d.createElement('script');link.type='module';link.src='/personal-workstation/v7/app.mjs';d.body.append(link);
 return '<!doctype html>\n'+d.documentElement.outerHTML;
 }finally{dom.window.close();}
}
if(process.argv[1]===new URL(import.meta.url).pathname){
 const source=readFileSync(new URL('../../工作台-视觉原型-v7.html',import.meta.url),'utf8');
 writeFileSync(new URL('./live-shell.html',import.meta.url),buildShell(source));
 console.log('Built V7 initialized shell without demo scripts or business records. Not published.');
}
