import {escapeHtml as esc} from './project-render.mjs';
import {sharedModal} from './modal.mjs';
import {selectHtml,wireSelects} from './vi-select.mjs';
import {renderMarkdown,readerHtml} from './markdown.mjs';
import {downloadFile} from './download.mjs';
import {classify,childrenOf,expandState,outwardDir,expandLayout,fitRect,semanticTier,roleVisual,capacityReport,UNCLASSIFIED_LABEL,UNASSIGNED_LABEL} from './ecosystem-layout.mjs';

const ns='http://www.w3.org/2000/svg';
// 画布配色**只用 VI 的 token**（V5：同一语义不允许两套颜色）。
// SVG 的 fill/stroke 属性不支持 var()，所以运行时从根元素读出 token 的值；
// 读不到就退回纸面/墨色，绝不自己写一个新色值。
const viToken=name=>{
 // 测试沙箱（runInNewContext）里没有 getComputedStyle —— 必须守卫，
 // 否则画布整块渲染直接抛错（第 9 轮实测：13 个测试因此变红）。
 if(typeof getComputedStyle!=='function'||!document?.documentElement)return 'transparent';
 const value=getComputedStyle(document.documentElement).getPropertyValue(name).trim();
 return value||'transparent';
};
const palette=()=>({
 // 10 色扩展板：每一类一个色相，不再靠同色系深浅区分。
 project:[viToken('--pal-indigo-soft'),viToken('--pal-indigo'),'project'],
 task:[viToken('--pal-teal-soft'),viToken('--pal-teal'),'task'],
 artifact:[viToken('--pal-cyan-soft'),viToken('--pal-cyan'),'artifact'],
 topic:[viToken('--pal-violet-soft'),viToken('--pal-violet'),'topic'],
 memory:[viToken('--pal-magenta-soft'),viToken('--pal-magenta'),'memory'],
 judgment:[viToken('--pal-pink-soft'),viToken('--pal-pink'),'judgment'],
 event:[viToken('--pal-orange-soft'),viToken('--pal-orange'),'event'],
 org:[viToken('--pal-slate-soft'),viToken('--pal-slate'),'org'],
 person:[viToken('--pal-gold-soft'),viToken('--pal-gold'),'person'],
});
const kindOrder=['project','task','artifact','topic','memoryRef','judgment','event','organization','person'];
const typeOf=kind=>({project:'project',task:'task',artifact:'artifact',topic:'topic',memoryRef:'memory',judgment:'judgment',event:'event',organization:'org',person:'person'}[kind]||'topic');
const iconOf=kind=>({project:'pg-folder',task:'pg-kanban',artifact:'pg-file-text',topic:'pg-bookmark',memoryRef:'pg-database',event:'pg-calendar-days',organization:'pg-building',person:'pg-users',judgment:'pg-shield'}[kind]||'pg-layers');
// 画布文案必须与原型一致：不把内部枚举直接暴露给用户。
export const statusLabels={todo:'待办',waiting:'等待中',in_progress:'进行中',done:'已完成',cancelled:'已取消'};
export const kindLabels={project:'项目',task:'任务',artifact:'资料',topic:'研究议题',memoryRef:'记忆引用',judgment:'判断',event:'事务',organization:'组织',person:'联系人'};
export function nodeSubtitle(node){
 const kind=kindLabels[node.kind]||node.kind;
 if(node.kind==='project'||node.kind==='task'){
  const done=node.progress?.done??0,total=node.progress?.total??0;
  // 0/0 不画成指标（S4/TK-02）：没有步骤/交付项就如实说「尚无步骤 / 尚无交付项」。
  const progress=total?done+'/'+total+' 项':(node.kind==='task'?'尚无步骤':'尚无交付项');
  return `${kind} · ${progress} · ${statusLabels[node.businessStatus]||node.businessStatus||''}`.replace(/ · $/,'');
 }
 return kind;
 return kind;
}
/** 手册 §07 缩放与层级：低于 60% 只看得到「对象名 + 类型」；60–110% 才补充状态与计数；
 *  高于 110% 才按需显示关系文字。这样缩小时画面不会因为文字互相压叠而变成一团。 */
export function nodeDetailAt(node,zoom){
 const kind=kindLabels[node.kind]||node.kind;
 if(zoom<0.6)return kind;
 return nodeSubtitle(node);
}
export function showsEdgeLabels(zoom){return zoom>1.1}

/** 每个节点多大。
 *  用户 2026-10-16：「不要都很大，要**精致**一些；**不要重要和紧急**，而是**节点** ——
 *  比如项目是个大节点，里面任务是小节点；联动很多的知识是个重要的，小知识就不是很重要」。
 *  所以：**按种类给底**（项目大、任务小）+ **按连接数加成**（联动越多越大），与 priority/urgency 无关。 */
export function nodeSize(kind,degree=0){
 // 星点图：类型决定基础大小（项目最大、联系人/组织最小），连接数再加成。
 const base={project:[260,110],task:[176,72],artifact:[160,64],topic:[150,60],judgment:[176,72],event:[160,64],organization:[140,56],person:[140,56]}[kind]??[150,60];
 const bonus=Math.min(30,Math.max(0,(degree-1))*6);
 return {w:base[0]+bonus,h:base[1]+Math.round(bonus*0.35)};
}
/** 每个节点的尺寸表（与 positions 同一套用法：算一次，五处共用）。 */
function sizeMap(live,edges){
 const degree=new Map();
 for(const edge of edges){degree.set(edge.from,(degree.get(edge.from)??0)+1);degree.set(edge.to,(degree.get(edge.to)??0)+1)}
 const map=new Map();
 for(const node of live)map.set(node.id,nodeSize(node.kind,degree.get(node.id)??0));
 return map;
}
/** 节点卡片里可放文字的宽度（卡片 200 宽，文字从 x=51 起，右侧留 10）。 */
export const NODE_TEXT_WIDTH=139;
export function textWidth(text,fontSize=13){
 let width=0;
 for(const char of String(text))width+=/[⺀-鿿豈-﫿＀-￯]/.test(char)?fontSize:fontSize*0.51;
 return width;
}
/** 最多折两行，第二行放不下就用省略号——宁可截断也不画到卡片外面。 */
export function wrapNodeTitle(text,{maxWidth=NODE_TEXT_WIDTH,fontSize=13,maxLines=2}={}){
 const chars=[...String(text??'')];
 const lines=[];
 let current='';
 for(const char of chars){
  if(textWidth(current+char,fontSize)<=maxWidth){current+=char;continue}
  lines.push(current);
  current=char;
  if(lines.length===maxLines-1)break;
 }
 if(lines.length<maxLines){
  const consumed=lines.join('').length+current.length;
  if(consumed<chars.length){
   // 还有剩余字符：第二行放尽可能多，再加省略号
   let rest=chars.slice(consumed).join('');
   while(rest&&textWidth(current+rest+'…',fontSize)>maxWidth)rest=rest.slice(0,-1);
   current=current+rest+(rest.length<chars.slice(consumed).length?'…':'');
  }
  lines.push(current);
  return lines.filter(line=>line!=='');
 }
 const last=lines[maxLines-1];
 // 已到行数上限但还有剩余：末行加省略号
 if(textWidth(last,fontSize)>maxWidth||chars.join('').length>lines.join('').length+last.length)lines[maxLines-1]=last.replace(/.$/,'…');
 return lines.map(line=>line);
}
const relationFields=['title','description','projectId','sourceRefs','tags','from','to','status','evidence','reason'];

/** Deterministic initial layout: one column per kind in canonical order, rows in stable id order. */
export function spaceLayout(nodes){
 const positions={},columns=new Map();
 for(const node of nodes){if(!columns.has(node.kind))columns.set(node.kind,[]);columns.get(node.kind).push(node.id)}
 const kinds=[...kindOrder.filter(kind=>columns.has(kind)),...[...columns.keys()].filter(kind=>!kindOrder.includes(kind)).sort()];
 let column=0;
 for(const kind of kinds){const ids=columns.get(kind).sort();ids.forEach((id,row)=>{positions[id]={x:column*300,y:row*160}});if(ids.length)column++}
 return positions;
}

/** 星点状布局（2026-10-18）：以一个焦点为中心，按关系距离分环排布。
 *  中心 = 当前聚焦对象 / 连接最多的项目；一环 = 直接关联；二环 = 二度；其余放外环。
 *  同一环内按类型聚合，再按标题稳定排序 —— 每次重开位置一致，不会跳来跳去。 */
export function starLayout(nodes,edges,focus=''){
 const live=edges.filter(edge=>edge.status!=='rejected');
 const degree=new Map();
 for(const edge of live){degree.set(edge.from,(degree.get(edge.from)??0)+1);degree.set(edge.to,(degree.get(edge.to)??0)+1)}
 const byId=new Map(nodes.map(node=>[node.id,node]));
 const projects=nodes.filter(node=>node.kind==='project').sort((a,b)=>(degree.get(b.id)??0)-(degree.get(a.id)??0));
 const hubId=focus&&byId.has(focus)?focus:(projects[0]?.id??[...nodes].sort((a,b)=>(degree.get(b.id)??0)-(degree.get(a.id)??0))[0]?.id);
 if(!hubId)return {};
 const adjacency=new Map(nodes.map(node=>[node.id,[]]));
 for(const edge of live){if(!adjacency.has(edge.from)||!adjacency.has(edge.to))continue;adjacency.get(edge.from).push(edge.to);adjacency.get(edge.to).push(edge.from)}
 const depth=new Map([[hubId,0]]);const queue=[hubId];
 while(queue.length){const id=queue.shift();for(const next of adjacency.get(id)??[]){if(depth.has(next))continue;depth.set(next,depth.get(id)+1);queue.push(next)}}
 const kindRank=['project','task','judgment','event','artifact','topic','memoryRef','organization','person'];
 const ringOf=list=>[...list].sort((a,b)=>{const ka=kindRank.indexOf(a.kind),kb=kindRank.indexOf(b.kind);return ka-kb||String(a.title??'').localeCompare(String(b.title??''),'zh')||a.id.localeCompare(b.id)});
 const rings=[[],[],[],[],[]];
 for(const node of nodes){const d=depth.get(node.id);const ring=d===undefined?4:Math.min(4,d);rings[ring].push(node)}
 const positions={};
 rings.forEach((list,ring)=>{
  if(!list.length)return;
  if(ring===0){positions[list[0].id]={x:0,y:0};return}
  const sorted=ringOf(list);
  const radius=[0,360,650,930,1200][ring]+Math.max(0,sorted.length-10)*26;
  const offset=-Math.PI/2+(ring%2?0.18:-0.18);
  sorted.forEach((node,index)=>{
   const angle=offset+index/sorted.length*Math.PI*2;
   const size=nodeSize(node.kind,degree.get(node.id)??0);
   positions[node.id]={x:Math.round(Math.cos(angle)*radius-size.w/2),y:Math.round(Math.sin(angle)*radius-size.h/2)};
  });
 });
 return positions;
}
/** 旧版布局是「每种类型一列」（x 300 倍数、y 160 倍数）；识别它并在新布局里一次性替换。 */
export function wasColumnLayout(positions){
 const values=Object.values(positions??{});
 if(!values.length)return false;
 return values.every(position=>Math.abs(position.x%300)<1&&Math.abs(position.y%160)<1);
}
/** Same scope semantics as the prototype: all, cross-project shared objects, or nodes reached by pending suggestions. */
export function pendingSuggestions(edges){
 // 待确认候选按 id 稳定排序：同一批数据每次打开看到的是同一条，不在你眼前跳来跳去。
 return edges.filter(edge=>edge.status!=='rejected'&&(edge.status==='suggested'||edge.stale)).sort((left,right)=>String(left.id).localeCompare(String(right.id)));
}
export function scopeNodes(nodes,edges,scope){
 const live=edges.filter(edge=>edge.status!=='rejected');
 // 「AI 建议」范围一次只显示**一条**待确认（CV-08：一次一条，处理完再看下一条）。
 if(scope==='suggestions'){const first=pendingSuggestions(live)[0];const ids=first?new Set([first.from,first.to]):new Set();return nodes.filter(node=>ids.has(node.id))}
 if(scope==='shared'){const owners=id=>new Set(live.filter(edge=>edge.derived&&edge.title==='项目归属'&&(edge.from===id||edge.to===id)).map(edge=>edge.from===id?edge.to:edge.from));const hubs=nodes.filter(node=>['artifact','topic','memoryRef','event'].includes(node.kind)&&owners(node.id).size>1).map(node=>node.id);const ids=new Set(hubs);for(const edge of live)if(hubs.includes(edge.from)||hubs.includes(edge.to)){ids.add(edge.from);ids.add(edge.to)}return nodes.filter(node=>ids.has(node.id))}
 return nodes;
}
export function relationData(edge,status){const data={};for(const field of relationFields){const value=field==='status'?status:field==='from'?edge.from:field==='to'?edge.to:edge[field];if(value!==undefined&&value!==null&&value!=='')data[field]=value}return data}
export function visibleEdges(nodes,edges,scope){
 const ids=new Set(scopeNodes(nodes,edges,scope).map(node=>node.id));
 const visible=edges.filter(edge=>edge.status!=='rejected'&&ids.has(edge.from)&&ids.has(edge.to));
 if(scope!=='suggestions')return visible;
 const first=pendingSuggestions(visible)[0];
 return first?[first]:[];
}

/** 框选：与选框相交的节点即被选中（用节点卡片 200×86 的实际矩形判断）。
 *  纯函数，便于单测；不做副作用。 */
/** 高连接分页：单个节点最多画 N 条关联，其余在状态栏如实计数（CV-04 正式版要求）。
 *  已确认的关系优先于待确认建议——用户确认过的先可见。 */
export const EDGES_PER_NODE=12;
export function capEdges(list,limit=EDGES_PER_NODE){
 const count=new Map(),kept=[],dropped=[];
 for(const edge of [...list].sort((a,b)=>(a.status==='confirmed'?0:1)-(b.status==='confirmed'?0:1))){
  const from=count.get(edge.from)??0,to=count.get(edge.to)??0;
  if(from>=limit||to>=limit){dropped.push(edge);continue}
  count.set(edge.from,from+1);count.set(edge.to,to+1);kept.push(edge);
 }
 return {kept,dropped};
}
export function marqueeSelect(box,placed,sizes=null){
 const left=Math.min(box.x1,box.x2),right=Math.max(box.x1,box.x2);
 const top=Math.min(box.y1,box.y2),bottom=Math.max(box.y1,box.y2);
 return placed.filter(({position,n})=>{if(!position)return false;const sz=sizes?.get(n?.id)??{w:200,h:86};return position.x<right&&position.x+sz.w>left&&position.y<bottom&&position.y+sz.h>top}).map(({node})=>node.id);
}
/** 分组的包围盒：成员节点的最小外接矩形 + 内外边距（含标题行）。 */
export function groupBounds(members,{padding=18,titleHeight=26}={},sizes=null){
 const placed=members.filter(item=>item.position);
 if(!placed.length)return null;
 const left=Math.min(...placed.map(item=>item.position.x)),top=Math.min(...placed.map(item=>item.position.y));
 const right=Math.max(...placed.map(item=>item.position.x+(sizes?.get(item.n?.id)?.w??200))),bottom=Math.max(...placed.map(item=>item.position.y+(sizes?.get(item.n?.id)?.h??86)));
 return {x:left-padding,y:top-padding-titleHeight,width:right-left+padding*2,height:bottom-top+padding*2+titleHeight};
}
/** 折叠分组时隐藏其成员（视图层行为，不改业务数据）。 */
export function hiddenByGroups(groups){
 const hidden=new Set();
 for(const group of groups??[])if(group.collapsed)for(const id of group.nodeIds)hidden.add(id);
 return hidden;
}

/** 把外壳带来的原生下拉换成 VI 选择控件，返回**同名的 hidden input**。
 *  为什么保留同名 id：调用处（.value / .onchange / dispose）用的是原生 select 的形状，
 *  换成 hidden input 后这三件事的语义完全一致，不必把调用点全改一遍。 */
function mountCanvasSelect(document,select){
 if(!select||select.dataset.viMounted==='1')return select;
 const options=[...select.options].map(option=>[option.value,option.textContent]);
 const wrapper=document.createElement('div');
 wrapper.innerHTML=selectHtml({name:select.id,attribute:'id',value:select.value,options,placeholder:options[0]?.[1]??'请选择'});
 const node=wrapper.firstElementChild;
 node.dataset.canvasSelect=select.id;
 select.replaceWith(node);
 const input=node.querySelector('input[type="hidden"]');
 input.dataset.viMounted='1';
 return input;
}

/** 改 hidden input 的值时同步可见文字（否则下拉显示的还是旧选项）。 */
function setViValue(document,input,value){
 if(!input)return;
 input.value=value;
 const wrapper=input.closest('[data-viselect]');
 if(!wrapper)return;
 const option=[...wrapper.querySelectorAll('[data-viselect-option]')].find(item=>item.dataset.viselectOption===value);
 if(option){wrapper.querySelector('[data-viselect-text]').textContent=option.textContent;return}
 const first=wrapper.querySelector('[data-viselect-option]');
 wrapper.querySelector('[data-viselect-text]').textContent=first?first.textContent:'';
}

/** 重建某个 VI 下拉的候选（原来是 focusSelect.replaceChildren() + <option>）。 */
function setViOptions(document,input,list,value=''){
 if(!input)return;
 const wrapper=input.closest('[data-viselect]');
 if(!wrapper)return;
 const listNode=wrapper.querySelector('[data-viselect-list]');
 listNode.replaceChildren();
 for(const [optionValue,label] of list){
  const button=document.createElement('button');
  button.type='button';button.className='viselect-option';button.setAttribute('role','option');
  button.dataset.viselectOption=optionValue;button.textContent=label;
  button.onclick=()=>{setViValue(document,input,optionValue);listNode.hidden=true;wrapper.querySelector('[data-viselect-button]')?.setAttribute('aria-expanded','false');input.dispatchEvent(new Event('change',{bubbles:true}))};
  listNode.append(button);
 }
 setViValue(document,input,value);
}

export function mountSpace(document,{send,batch,open,create:onCreate,notify=()=>{},projects=[],key=()=>'space:'+Date.now()+':'+Math.random().toString(36).slice(2)}){
 // 2026-10-14（用户点名「下拉框感觉 VI 有点土」+ VI §6 组件唯一）：外壳带来的是两个原生下拉控件，
 // 与表单里的 .viselect 并存。这里在挂载时换成同一套 VI 选择控件，并保留同名的 hidden input，
 // 于是 .value / .onchange 的调用点全部不用改。
 const svg=document.querySelector('#spaceSvg'),status=document.querySelector('#graphstatus'),
  focusSelect=mountCanvasSelect(document,document.querySelector('#projectfocus')),
  scopeSelect=mountCanvasSelect(document,document.querySelector('#scopefilter'));
 if(scopeSelect||focusSelect)wireSelects(document,{document});
 // 范围选择器（不是新入口，沿用画布原有那一个）：结构态是默认（D8=全部机构），
 // 其余三个是既有关系态。选项补在运行时，冻结外壳一个字不动。
 if(scopeSelect){setViOptions(document,scopeSelect,[['structure','按分类'],['all','全部关系'],['shared','跨项目共享'],['suggestions','AI 建议']],'structure')}
 const modal=sharedModal(document);let token=null,disposed=false,epoch=0;
 let nodes=[],edges=[],relationList=[],positions={},sizes=new Map(),revision=0,gx=20,gy=20,zoom=1,scope='all',focus='',drag=null,moved=false,pending=null;
 // 结构态（A2 / spec/54 §1·§2）：同一张画布的两个范围，不新增入口。
 // mode 来自范围选择器：structure（默认，D8=全部机构）/ all / shared / suggestions（后三个是既有关系态）。
 // 展开状态只存在本次会话（spec/54 §2.3：v1 不写业务数据）；拖拽位置也只在本会话生效（显式保存归 A4）。
 let mode='structure',structure=null,structPositions={},childPositions={},expandedOrg=null,expandedProject=null,structMoved={},cameraFrame=0,roleMap=null,bucketVisual=new Map();
 // 画布第 1 批：框选 / 批量操作 / 分组。分组属于**视图层**（CV-05：不改业务事实），随 layout 一起保存。
 let selection=new Set(),groups=[],marquee=null,selectMode=false,link=null;
 const se=(name,attributes={},text)=>{const node=document.createElementNS(ns,name);for(const [name2,value]of Object.entries(attributes))node.setAttribute(name2,value);if(text!==undefined)node.textContent=text;return node};
 const wire=(selector,handler)=>{const node=document.querySelector(selector);if(node)node.onclick=handler};
 function shown(){const scoped=scopeNodes(nodes,edges,scope);if(!focus)return scoped;const near=new Set([focus]);for(const edge of edges)if(edge.status!=='rejected'&&(edge.from===focus||edge.to===focus)){near.add(edge.from);near.add(edge.to)}return scoped.filter(node=>near.has(node.id))}
 function transform(){const world=svg.querySelector('#spaceworld');if(!world)return;world.setAttribute('transform',`translate(${gx} ${gy}) scale(${zoom})`);const label=document.querySelector('#zoomlabel');if(label)label.textContent=Math.round(zoom*100)+'%'}
 // 缩放分层（VI §9，**强制**）：<60% 名称+类型 · 60–110% 补状态与计数 · >110% 才显示关系文字。
 // 这些内容是在 draw() 里按当时的 zoom 算出来的，而原来所有缩放入口**只调 transform()、不重绘** ——
 // 于是缩到 250% 也不会出现关系文字、缩到 25% 也不会隐藏副标题（2026-10-16 在真实浏览器上实测确认）。
 // 修法：把"改缩放"与"平移"分开 —— `setZoom()` 在缩放真的变了之后，用 requestAnimationFrame 节流重绘一次；
 // 平移仍然只改 transform（平移不影响分层，不必重绘）。
 let zoomDraw=0;
 function setZoom(next){
  const value=Number.isFinite(next)?next:zoom;
  const changed=Math.abs(value-zoom)>1e-6;
  zoom=value;transform();
  if(!changed)return;
  if(zoomDraw)return;
  // 兜底：jsdom（单元测试）里没有 requestAnimationFrame —— 直接用它会让 setZoom 抛错，
  // 后面那句 saveLayout() 就永远不执行（实测把"连续保存"的断言打成了 revision 1）。
  const schedule=typeof requestAnimationFrame==='function'?requestAnimationFrame:callback=>setTimeout(callback,0);
  zoomDraw=schedule(()=>{zoomDraw=0;draw()});
 }
 function fit(){
  if(mode==='structure'){
   // 适配要把**分类列的框与列头**也算进去：只按节点矩形算会让最右一列的外框超出视口
   //（实测 390 下右边界 425，移动端门禁抓到的就是这条）。
   const rects=Object.keys(structPositions).map(id=>rectOf(id)).filter(Boolean);
   for(const bucket of structure?.buckets??[])if(Number.isFinite(bucket.x))rects.push({x:bucket.x,y:bucket.top??20,w:bucket.width??300,h:Math.max(110,bucket.height??120)});
   const viewport=viewportSize();
   if(!rects.length||!viewport.w){gx=20;gy=20;zoom=1;transform();return}
   // 手机（窄画布）保持「全图适配」：390 宽本来就放不下多列，VI §9 允许 <60% 只显示名称+类型；
   // 桌面则守住 60%（spec/54 §2.3 / S5），其余靠无限画布平移看。
   cameraTo(fitRect({rects,viewport,padding:viewport.w<700?28:70,minZoom:viewport.w<700?0.2:0.6,maxZoom:1}),{animate:false});
   return;
  }
  const rect=svg.getBoundingClientRect(),live=shown();if(!rect.width||!live.length){gx=20;gy=20;zoom=1;transform();return}const xs=live.map(node=>positions[node.id]?.x??0),ys=live.map(node=>positions[node.id]?.y??0);const x=Math.min(...xs),y=Math.min(...ys),w=Math.max(...xs)+200-x,h=Math.max(...ys)+86-y;if(w<=0||h<=0){gx=20;gy=20;zoom=1;transform();return}
  // 默认视图必须可读：46 号审计实测原型自动适配到 44%，节点文字只剩 5.7px（17 §4.6 不成立）。
  // 整张图画得下就居中；画不下也不缩到 44% —— 72% 起，其余靠无限画布平移看。这是对原型的**有意偏离**，已入账。
  const fitted=Math.min(1.1,(rect.width-70)/w,(rect.height-95)/h);
  // 手机（窄画布）保持"全图适配"：390 宽本来就不可能既全览又 12px；手册 §07 允许 <60% 只显示名称+类型。
  const readable=rect.width>=700?0.72:0;
  if(!readable||fitted>=readable){zoom=fitted;gx=(rect.width-w*zoom)/2-x*zoom;gy=(rect.height-h*zoom)/2-y*zoom}
  else{zoom=readable;gx=(rect.width/2-(x+w/2)*zoom);gy=(rect.height/2-(y+h/2)*zoom)}
  transform()}
 function draw(){
  svg.dataset.canvasMode=mode;
  if(mode==='structure')return drawStructure();
  return drawRelations();
 }
  /** 画布底：网格 + 世界坐标组。关系态与结构态共用一份，避免两套坐标系。 */
  function canvasBase(){
   svg.replaceChildren();const defs=se('defs'),pattern=se('pattern',{id:'spacegrid',width:24,height:24,patternUnits:'userSpaceOnUse'});pattern.append(se('circle',{cx:1,cy:1,r:.7,fill:viToken('--ws-line')}));defs.append(pattern);svg.append(defs,se('rect',{width:'100%',height:'100%',fill:'url(#spacegrid)'}));
   const world=se('g',{id:'spaceworld'});svg.append(world);return world;
  }
  /** 节点卡 = **一套实现两档密度**（spec/54 §4 / registry.components.card）：
   *  关系态用标准档、结构态用画布紧凑变体 `canvasNode`（同一函数，差别只有内边距与去留）。
   *  两档都只用 VI token；颜色永远不是唯一的区分手段（还有类型名/角色名/形状）。 */
  function nodeCard(node,position,{dim=false,accent=null,roleShape=null,compact=false,showHandle=false,extraSubtitle=''}={}){
   const typeColour=accent?viToken(accent):null,[bg,colour]=typeColour?[viToken(accent+'-soft'),typeColour]:palette()[typeOf(node.kind)];
   const selected=selection.has(node.id);
   const size=sizes.get(node.id)??nodeSize(node.kind,0);
   const projectNode=node.kind==='project';
   const radius=compact?12:17;
   const group=se('g',{class:'graphnode graphnode-'+node.kind+(compact?' graphnode-compact':''),'data-kind':node.kind,'data-density':compact?'canvasNode':'standard','data-selected':selected?'1':'0',transform:`translate(${position.x} ${position.y})`,tabindex:0,role:'button','data-node':node.id,'aria-label':(kindLabels[node.kind]||node.kind)+'：'+(node.title||'未命名')+'，单击'+(compact?'展开':'看详情')+'，双击看详情，拖动调整位置',...(dim?{opacity:'.32','data-dim':'1'}:{})});
   group.append(se('rect',{x:0,y:0,width:size.w,height:compact?3:4,rx:2,fill:colour,'fill-opacity':projectNode?'.95':'.6'}));
   group.append(se('rect',{x:0,y:compact?12:14,width:compact?3:4,height:size.h-(compact?24:28),rx:2,fill:colour,'fill-opacity':projectNode?'1':'.75'}));
   group.append(se('rect',{width:size.w,height:size.h,rx:radius,fill:selected?viToken('--ws-paper'):viToken('--ws-surface'),stroke:selected?viToken('--ws-action'):colour,'stroke-opacity':selected?'1':projectNode?'.8':'.55','stroke-width':selected?2.4:projectNode?2:1}),se('rect',{x:compact?12:12,y:compact?12:14,width:compact?25:29,height:compact?25:29,rx:compact?8:9,fill:bg}));
   const glyph=se('svg',{x:compact?17:18,y:compact?16:20,width:compact?15:17,height:compact?15:17,viewBox:'0 0 24 24',fill:'none',stroke:colour,'stroke-width':1.6,'stroke-linecap':'round','stroke-linejoin':'round'});glyph.append(se('use',{href:'#i-'+iconOf(node.kind)}));group.append(glyph);
   // 关系角色是**三重编码**之一：形状徽标（颜色之外的第二重），名称写在副标题里（第三重）。
   if(roleShape)group.append(shapeBadge(roleShape,size.w-16,compact?14:16,5,colour));
   const titleLines=wrapNodeTitle(node.title||'未命名',{maxWidth:size.w-(compact?51:51)-14});
   const title=se('text',{x:compact?44:51,y:titleLines.length>1?31:33,'font-size':compact?12:13,fill:viToken('--ws-ink'),'font-weight':550});
   titleLines.forEach((line,index)=>{title.append(se('tspan',{x:compact?44:51,dy:index===0?0:14},line))});
   title.append(se('title',{},node.title||'未命名'));
   group.append(title);
   const dots=[['importance',size.w-28,'重要程度'],['urgency',size.w-14,'紧急程度']];
   const levelText={high:'高',medium:'中',low:'低'};
   const tooltip=[];
   for(const [field,x,label] of dots){
    const value=node[field];
    if(!['high','medium','low'].includes(value))continue;
    group.append(se('circle',{cx:x,cy:16,r:4,fill:value==='high'?viToken('--ws-action'):value==='medium'?viToken('--ws-muted'):viToken('--ws-line')}));
    tooltip.push(label+'：'+levelText[value]);
   }
   if(node.folder)tooltip.push('项目文件夹：'+node.folder);
   if(tooltip.length)group.append(se('title',{},tooltip.join(' · ')));
   if(node.kind==='task'&&(node.businessStatus==='waiting'||node.businessStatus==='in_progress')){
    group.append(se('circle',{cx:12,cy:12,r:5,fill:node.businessStatus==='waiting'?viToken('--ws-warning'):viToken('--ws-action')}));
   }
   const subtitle=[nodeDetailAt(node,zoom),extraSubtitle].filter(Boolean).join(' · ');
   group.append(se('text',{x:compact?13:14,y:size.h-13,'font-size':12,fill:viToken('--ws-muted')},subtitle));
   if(['artifact','topic'].includes(node.kind)&&!compact){
    const preview=se('text',{x:186,y:titleLines.length>1?72:60,'font-size':12,fill:viToken('--ws-action'),class:'nodepreview','text-anchor':'end'});
    preview.textContent='预览';preview.append(se('title',{},'在画布内预览内容（文本 / 图片 / PDF）'));
    preview.addEventListener('click',event=>{event.stopPropagation();void openPreview(node.id)});
    group.append(preview);
   }
   if(showHandle){
    const handle=se('circle',{cx:size.w,cy:size.h/2,r:7,fill:viToken('--ws-surface'),stroke:viToken('--ws-muted'),'stroke-width':1.6,class:'nodehandle'});
    handle.append(se('title',{},'从这里拖到另一个对象，建立关联'));
    handle.addEventListener('pointerdown',event=>{
     event.stopPropagation();
     link={id:event.pointerId,from:node.id};
     svg.querySelectorAll('#linkghost').forEach(node=>node.remove());
     const ghost=se('path',{id:'linkghost',fill:'none',stroke:viToken('--ws-muted'),'stroke-width':2,'stroke-dasharray':'5 4'});
     svg.querySelector('#spaceworld')?.append(ghost);
     try{svg.setPointerCapture?.(event.pointerId)}catch{/* 指针已失效时忽略：连线仍可按坐标落点判断 */}
    });
    group.append(handle);
   }
   return group;
  }
  /** 分类徽标形状（5 种，非图标）：颜色不单独承担区分，同色也能靠形状分开。 */
  function shapeBadge(shape,x,y,r,fill){
   const n=r*2;
   if(shape==='circle')return se('circle',{cx:x,cy:y,r,fill,class:'roleshape'});
   if(shape==='square')return se('rect',{x:x-r,y:y-r,width:n,height:n,rx:1.5,fill,class:'roleshape'});
   if(shape==='diamond')return se('polygon',{points:[[x,y-r],[x+r,y],[x,y+r],[x-r,y]].map(pair=>pair.join(',')).join(' '),fill,class:'roleshape'});
   if(shape==='triangle')return se('polygon',{points:[[x,y-r],[x+r,y+r*0.85],[x-r,y+r*0.85]].map(pair=>pair.join(',')).join(' '),fill,class:'roleshape'});
   // 默认六边形
   const points=[];
   for(let i=0;i<6;i+=1){const angle=Math.PI/180*(60*i-30);points.push([(x+Math.cos(angle)*r).toFixed(2),(y+Math.sin(angle)*r).toFixed(2)])}
   return se('polygon',{points:points.map(pair=>pair.join(',')).join(' '),fill,class:'roleshape'});
  }

  // ── 结构态：按关系角色分组 + 原地展开 + 镜头（spec/54 §1·§2） ────────────────
  const STRUCTURE='structure';
  function structureScope(){return focus?'project:'+focus:'all'}
  function nodeOf(id){return nodes.find(node=>node.id===id)}
  function cardSize(id){return sizes.get(id)??nodeSize(nodeOf(id)?.kind??'topic',0)}
  function rectOf(id){const position=structPositions[id]??childPositions[id];if(!position)return null;const size=cardSize(id);return {x:position.x,y:position.y,w:size.w,h:size.h}}
  function viewportSize(){const rect=svg.getBoundingClientRect?.()??{width:0,height:0};return {w:rect.width??0,h:rect.height??0}}
  function isNarrowViewport(){const width=viewportSize().w||0;return width>0&&width<700}
  function viewportCenter(){const {w,h}=viewportSize();if(!w||!h)return null;return {x:(w/2-gx)/zoom,y:(h/2-gy)/zoom}}
  function visualForBucket(bucket,index){
   const name=bucket.kind==='role'?bucket.label:'';
   const saved=bucket.kind==='role'?roleMap?.roleColors?.[name]:null;
   const savedShape=bucket.kind==='role'?roleMap?.roleShapes?.[name]:null;
   let colorToken=saved&&/^--pal-[a-z]+(-soft)?$/.test(saved)?saved.replace(/-soft$/,''):roleVisual(name||'other',index).colorToken;
   let shape=savedShape??roleVisual(name||'other',index).shape;
   if(bucket.kind==='unclassified'){colorToken='--pal-slate';shape='circle'}
   if(bucket.kind==='unassigned'){colorToken='--pal-slate';shape='diamond'}
   return {colorToken,shape};
  }
  /** 结构排版：每个角色一列（未分类/未归属在最后），列头是角色名与真实数量。
   *  不移动用户原有位置：会话内拖动结果放在 structMoved 里覆盖计算值（不写库）。 */
  function buildStructure(){
   structure=classify({nodes,scope:structureScope()});
   // classify 的「未归属」口径是「没有 organizationId 也没有 partnerId」。
   // 但旧数据里只有 partnerId 的项目（A1 迁移只做 dry-run，还没映射成 participants）也必须看得见——
   // 结构态不猜它的主责机构，如实放进「未归属」桶，而不是让它在画布上消失。
   if(!focus){
    // ① 参与关系已经归属的项目不算「未归属」：classify 的未归属口径只看 organizationId/partnerId，
    //    有 participants 的项目（按角色挂在某些机构下）必须从这一桶里摘掉，否则同一个项目会出现两次。
    const attributed=new Set(nodes.filter(node=>node.kind==='project'&&(node.participants??[]).length).map(node=>node.id));
    if(attributed.size){
     for(const bucket of structure.buckets)if(bucket.kind==='unassigned')bucket.roleIds=bucket.roleIds.filter(id=>!attributed.has(id));
     structure.unassignedIds=(structure.unassignedIds??[]).filter(id=>!attributed.has(id));
     structure.buckets=structure.buckets.filter(bucket=>bucket.kind!=='unassigned'||bucket.roleIds.length);
    }
    // ② 旧数据里只有 partnerId 的项目（A1 迁移只做 dry-run，还没映射成 participants）也必须看得见：
    //    结构态不猜它的主责机构，如实放进「未归属」，而不是让它在画布上消失。
    const listed=new Set(structure.buckets.flatMap(bucket=>bucket.roleIds));
    const orphans=nodes.filter(node=>node.kind==='project'&&!listed.has(node.id)&&!String(node.organizationId??'').trim()&&!(node.participants??[]).length).map(node=>node.id);
    const missing=orphans.filter(id=>!(structure.unassignedIds??[]).includes(id));
    if(missing.length){
     const bucket=structure.buckets.find(item=>item.kind==='unassigned');
     if(bucket){bucket.roleIds.push(...missing);(structure.unassignedIds??=[]).push(...missing)}
     else{structure.unassignedIds=[...missing];structure.buckets.push({key:'unassigned',label:UNASSIGNED_LABEL,kind:'unassigned',roleIds:missing.slice(),counts:{organizations:0,projects:missing.length,tasks:0}})}
    }
   }
   const live=[];const seen=new Set();
   for(const bucket of structure.buckets)for(const id of bucket.roleIds){if(seen.has(id))continue;seen.add(id);const node=nodeOf(id);if(node)live.push(node)}
   sizes=sizeMap(live,edges);
   // 结构态卡片的最小尺寸：标题最多两行（wrapNodeTitle），卡片太矮会让两行标题与副标题压在一起。
   // 只放大结构态的卡，关系态沿用原尺寸（两态视觉一致，但结构态要容纳分类角色名）。
   const structureMin={organization:{w:220,h:86},project:{w:260,h:96},task:{w:190,h:76}};
   for(const [id,size] of sizes){const node=nodeOf(id),min=structureMin[node?.kind];if(!min)continue;sizes.set(id,{w:Math.max(size.w,min.w),h:Math.max(size.h,min.h)})}
   structPositions={};
   bucketVisual=new Map();
   // 手机（窄画布）：分类列竖排成一列分组列表 —— 390 的宽度放不下 5 列，硬挤会让文字小到读不了。
   // 桌面沿用「一角色一列」。
   const narrow=isNarrowViewport();
   let columnX=0,stackY=20;
   structure.buckets.forEach((bucket,index)=>{
    const visual=visualForBucket(bucket,index);bucketVisual.set(bucket.key,visual);
    const ids=bucket.roleIds.filter(id=>sizes.has(id));
    if(narrow){
     const width=Math.max(300,(viewportSize().w||340)-16);
     bucket.x=8;bucket.width=width;bucket.top=stackY;bucket.headerTop=stackY+24;
     let y=stackY+52;
     for(const id of ids){structPositions[id]={x:bucket.x+16,y};y+=(sizes.get(id)?.h??86)+14}
     bucket.height=Math.max(110,y-stackY+8);
     stackY+=bucket.height+12;
     return;
    }
    const width=Math.max(300,...ids.map(id=>(sizes.get(id)?.w??200)+64));
    bucket.x=columnX;bucket.width=width;bucket.top=20;bucket.headerTop=48;
    let y=64;
    for(const id of ids){structPositions[id]={x:columnX+32,y};y+=(sizes.get(id)?.h??86)+26}
    bucket.height=Math.max(120,y-64+40);
    columnX+=width;
   });
   // 分类顺序是视图配置（layout:ecosystem 的 order）：配了就把角色桶按它排；
   // 未分类永远最后、未归属在未分类之前（这条不受配置影响，避免"看不见未分类"）。
   const configuredOrder=Array.isArray(roleMap?.order)?roleMap.order.map(name=>String(name).trim()).filter(Boolean):[];
   if(configuredOrder.length){
    const rank=bucket=>{if(bucket.kind==='unclassified')return 1e9;if(bucket.kind==='unassigned')return 1e8;const index=configuredOrder.indexOf(bucket.label);return index>=0?index:1e7};
    structure.buckets=structure.buckets.map((bucket,index)=>({bucket,index,rank:rank(bucket)})).sort((left,right)=>left.rank-right.rank||left.index-right.index).map(item=>item.bucket);
   }
   for(const [id,position] of Object.entries(structMoved))if(structPositions[id])structPositions[id]={...position};
  }
  /** 展开布局：机构旁一列项目、项目旁一列任务（只算位置，不改父卡；不写库）。 */
  function layoutBranch(){
   childPositions={};
   if(!expandedOrg&&!expandedProject)return;
   const childIds=[];
   if(expandedOrg)for(const id of childrenOf(expandedOrg,{nodes}).items)childIds.push(id);
   if(expandedProject)for(const id of childrenOf(expandedProject,{nodes}).items)childIds.push(id);
   const visibleIds=[...new Set([...Object.keys(structPositions),...childIds])];
   const live=visibleIds.map(nodeOf).filter(Boolean);
   sizes=sizeMap(live,edges);
   const structureMin={organization:{w:220,h:86},project:{w:260,h:96},task:{w:190,h:76}};
   for(const [id,size] of sizes){const node=nodeOf(id),min=structureMin[node?.kind];if(!min)continue;sizes.set(id,{w:Math.max(size.w,min.w),h:Math.max(size.h,min.h)})}
   const center=viewportCenter();
   const occupied=Object.keys(structPositions).map(id=>rectOf(id)).filter(Boolean);
   const place=(parentId,list)=>{
    const parentRect=rectOf(parentId);if(!parentRect||!list.length)return;
    const dir=outwardDir(parentRect,center);
    const children=list.map(id=>{const size=cardSize(id);return {id,w:size.w,h:size.h}});
    const result=expandLayout({parentRect,children,occupied:[...occupied,...Object.keys(childPositions).map(id=>rectOf(id)).filter(Boolean)],dir,gap:44});
    for(const [id,position] of Object.entries(result.positions))childPositions[id]=position;
   };
   if(expandedOrg)place(expandedOrg,childrenOf(expandedOrg,{nodes}).items);
   if(expandedProject)place(expandedProject,childrenOf(expandedProject,{nodes}).items);
  }
  function branchNodeIds(){
   const ids=new Set();
   if(expandedOrg){ids.add(expandedOrg);for(const id of childrenOf(expandedOrg,{nodes}).items)ids.add(id)}
   if(expandedProject){ids.add(expandedProject);for(const id of childrenOf(expandedProject,{nodes}).items)ids.add(id)}
   return ids;
  }
  function branchRects(){return [...branchNodeIds()].map(id=>rectOf(id)).filter(Boolean)}
  function scheduleFrame(callback){return typeof requestAnimationFrame==='function'?requestAnimationFrame(callback):setTimeout(callback,16)}
  function cancelFrame(handle){if(!handle)return;if(typeof cancelAnimationFrame==='function')cancelAnimationFrame(handle);else clearTimeout(handle)}
  /** 镜头：fitRect(机构+子节点)，220ms、缩放 0.6–1.0（spec/54 §2.3）；减动效偏好下直接到位。 */
  function cameraTo(target,{animate=true}={}){
   if(!target)return;
   const reduce=globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches??false;
   const tierBefore=semanticTier(zoom);
   const apply=()=>{zoom=target.zoom;gx=target.gx;gy=target.gy;transform()};
   if(!animate||reduce||typeof performance==='undefined'){
    apply();if(semanticTier(zoom)!==tierBefore)draw();return;
   }
   cancelFrame(cameraFrame);
   const from={zoom,gx,gy},started=performance.now(),duration=220;
   const step=now=>{const t=Math.min(1,Math.max(0,(now-started)/duration)),ease=1-(1-t)**3;
    zoom=from.zoom+(target.zoom-from.zoom)*ease;gx=from.gx+(target.gx-from.gx)*ease;gy=from.gy+(target.gy-from.gy)*ease;transform();
    if(t<1)cameraFrame=scheduleFrame(step);else{cameraFrame=0;if(semanticTier(zoom)!==tierBefore)draw()}};
   cameraFrame=scheduleFrame(step);
  }
  function focusBranch(){
   const rects=branchRects();const viewport=viewportSize();
   if(!rects.length||!viewport.w||!viewport.h)return;
   const narrow=viewport.w<700;
   cameraTo(fitRect({rects,viewport,padding:narrow?24:70,minZoom:narrow?0.2:0.6,maxZoom:1}),{animate:true});
  }
  /** 结构态的空态：如实说「还没分类/还没归属」，不猜、不画假结构。 */
  function structureEmptyText(){
   if(focus)return '这个项目还没有参与机构；在项目详情里给机构标注角色后，这里按角色分组显示。';
   return '还没有可用于分组的机构；新建机构并填写分类后，这里按角色分组显示。';
  }
  function drawStructure(){
   const world=canvasBase();
   svg.dataset.canvasMode=STRUCTURE;
   buildStructure();
   layoutBranch();
   const branch=branchNodeIds();
   const dimOthers=branch.size>0;
   const tier=semanticTier(zoom);
   // 低缩放：展开的子节点折叠成「N 个项目 / N 个任务」计数（spec/54 §2.2）
   const collapsedBranch=tier==='name'&&branch.size>0;
   // 外框先画（在卡片之下）：每列一个淡底 + 列头（角色名 + 真实数量）
   for(const bucket of structure.buckets){
    const visual=bucketVisual.get(bucket.key)??roleVisual('other',0);
    const frameTop=bucket.top??20;
    const frame=se('g',{class:'graphbucket','data-bucket':bucket.key,role:'group','aria-label':bucket.label+'：'+bucket.roleIds.length+' 个'});
    frame.append(se('rect',{x:bucket.x,y:frameTop,width:bucket.width,height:Math.max(110,bucket.height),rx:18,fill:viToken(visual.colorToken+'-soft'),'fill-opacity':'.5',stroke:viToken('--ws-line'),'stroke-dasharray':'5 7'}));
    const name=bucket.kind==='unclassified'?UNCLASSIFIED_LABEL:bucket.kind==='unassigned'?UNASSIGNED_LABEL:bucket.label;
    const unit=bucket.kind==='unassigned'?'个项目':'个机构';
    const headY=(bucket.headerTop??48);
    const head=se('text',{x:bucket.x+22,y:headY,'font-size':15,fill:viToken('--ws-ink'),'font-weight':600},name+' · '+bucket.roleIds.length+' '+unit);
    head.append(se('title',{},'角色：'+name+'（点列内机构展开它的项目）'));
    frame.append(head,shapeBadge(bucket.kind==='role'?visual.shape:'circle',bucket.x+bucket.width-30,headY-6,6,viToken(visual.colorToken)));
    world.append(frame);
   }
   if(!structure.buckets.length){
    world.append(se('text',{x:40,y:120,'font-size':15,fill:viToken('--ws-muted')},structureEmptyText()));
   }
   // 连线：父卡→子卡实线（明确、已确认的结构关系）
   for(const id of Object.keys(childPositions)){
    const parentId=expandedProject&&childrenOf(expandedProject,{nodes}).items.includes(id)?expandedProject:expandedOrg;
    const parentRect=parentId?rectOf(parentId):null,childRect=rectOf(id);
    if(!parentRect||!childRect)continue;
    const fromRight=childRect.x>parentRect.x;
    const x1=fromRight?parentRect.x+parentRect.w:parentRect.x,x2=fromRight?childRect.x:childRect.x+childRect.w;
    const y1=parentRect.y+parentRect.h/2,y2=childRect.y+childRect.h/2;
    world.append(se('path',{class:'graphbranchline',d:`M${x1} ${y1} L${x2} ${y2}`,fill:'none',stroke:viToken('--ws-line'),'stroke-width':1.6}));
   }
   // 顶层卡片
   for(const bucket of structure.buckets){
    const visual=bucketVisual.get(bucket.key)??roleVisual('other',0);
    for(const id of bucket.roleIds){
     const node=nodeOf(id),position=structPositions[id];if(!node||!position)continue;
     const accent=bucket.kind==='role'?visual.colorToken:null;
     const extra=bucket.kind==='role'?bucket.label:bucket.kind==='unclassified'?UNCLASSIFIED_LABEL:bucket.kind==='unassigned'?UNASSIGNED_LABEL:'';
     const card=nodeCard(node,position,{compact:true,accent,roleShape:bucket.kind==='role'?visual.shape:null,extraSubtitle:extra,dim:dimOthers&&!branch.has(id)});
     if(id===expandedOrg||id===expandedProject)card.dataset.expanded='1';
     world.append(card);
    }
   }
   // 展开的子卡（低缩放时改画计数胶囊）
   for(const id of Object.keys(childPositions)){
    const node=nodeOf(id),position=childPositions[id];if(!node||!position)continue;
    if(collapsedBranch)continue;
    const card=nodeCard(node,position,{compact:true});
    card.dataset.branchChild='1';
    world.append(card);
   }
   if(collapsedBranch){
    const parentId=expandedProject??expandedOrg;
    const parentRect=parentId?rectOf(parentId):null;
    if(parentRect){
     const counts=new Map();
     for(const id of Object.keys(childPositions)){const kind=nodeOf(id)?.kind??'topic';counts.set(kind,(counts.get(kind)??0)+1)}
     const text=[...counts].map(([kind,count])=>count+' 个'+(kindLabels[kind]??'对象')).join(' · ');
     const isLeft=(viewportCenter()?.x??0)>parentRect.x;
     const pill=se('g',{class:'graphbranchcount','data-branch-count':'1'});
     pill.append(se('rect',{x:isLeft?parentRect.x+parentRect.w+20:parentRect.x-20-150,y:parentRect.y+parentRect.h/2-16,width:150,height:32,rx:16,fill:viToken('--ws-surface'),stroke:viToken('--ws-line')}));
     pill.append(se('text',{x:isLeft?parentRect.x+parentRect.w+95:parentRect.x-95,y:parentRect.y+parentRect.h/2+5,'text-anchor':'middle','font-size':12,fill:viToken('--ws-muted')},text));
     world.append(pill);
    }
   }
   transform();
   if(status){
    const organisations=structure.buckets.filter(bucket=>bucket.kind!=='unassigned').reduce((sum,bucket)=>sum+bucket.roleIds.length,0);
    const unclassified=structure.buckets.find(bucket=>bucket.kind==='unclassified')?.roleIds.length??0;
    const unassigned=structure.buckets.find(bucket=>bucket.kind==='unassigned')?.roleIds.length??0;
    const branchText=expandedOrg||expandedProject?' · 已展开 '+(expandedOrg?nodeOf(expandedOrg)?.title??'':'')+(expandedProject?' → '+(nodeOf(expandedProject)?.title??''):''):'';
    status.dataset.readout='1';
    const capacity=capacityReport({bucketCount:structure.buckets.length,nodeCount:structure.buckets.reduce((max,bucket)=>Math.max(max,bucket.roleIds.length),0)});
    status.textContent=structure.buckets.length
     ?'按分类：'+structure.buckets.length+' 类 · '+organisations+' 个机构'+(unclassified?'（未分类 '+unclassified+'）':'')+(unassigned?' · 未归属项目 '+unassigned:'')+' · 单击机构展开项目，双击看详情'+branchText+(capacity.overCap?' · '+capacity.message:'')
     :structureEmptyText();
   }
  }
 function drawRelations(){
  const world=canvasBase();
  // 星点结构底纹：以焦点（或连接最多的项目）为圆心画三圈；只在有节点时出现，缩放时跟随。
  const ringHub=(()=>{const degree=new Map();for(const edge of edges){if(edge.status==='rejected')continue;degree.set(edge.from,(degree.get(edge.from)??0)+1);degree.set(edge.to,(degree.get(edge.to)??0)+1)}return (focus&&positions[focus]?focus:(nodes.filter(n=>n.kind==='project').sort((a,b)=>(degree.get(b.id)??0)-(degree.get(a.id)??0))[0]?.id))})();
  const hubPosition=ringHub?positions[ringHub]:null;
  if(hubPosition){
   const hubSize=sizes.get(ringHub)??{w:200,h:86};
   for(const radius of [360,650,930])world.append(se('circle',{cx:hubPosition.x+hubSize.w/2,cy:hubPosition.y+hubSize.h/2,r:radius,fill:'none',stroke:viToken('--ws-action'),'stroke-opacity':'.16','stroke-dasharray':'4 10'}));
  }
  const hidden=hiddenByGroups(groups);
  const allLive=shown(),live=allLive.filter(node=>!hidden.has(node.id));
  // 尺寸表在 live 之后算一次：分组框、节点、框选三处共用同一份。
  // 踩过两次作用域坑：放分组循环体里 → 循环外拿不到；放 draw 开头 → live 还没初始化。
  sizes=sizeMap(live,edges);
  const visible=visibleEdges(allLive,edges,scope).filter(edge=>!hidden.has(edge.from)&&!hidden.has(edge.to));
  const {kept:liveEdges,dropped:droppedEdges}=capEdges(visible);
  // 分组框画在节点之下：成员位置决定包围盒。点标题折叠/展开、双击改名、× 解散——都只改视图，随 layout 保存。
  for(const group of groups){
   const members=group.nodeIds.map(id=>({node:allLive.find(item=>item.id===id),position:positions[id]})).filter(item=>item.node);
   const box=groupBounds(members,{padding:18,titleHeight:26},sizes);if(!box)continue;
   const frame=se('g',{class:'graphgroup','data-group':group.id,tabindex:0,role:'button','aria-label':'分组 '+(group.title||'')+'，'+group.nodeIds.length+' 个对象'});
   frame.append(se('rect',{x:box.x,y:box.y,width:box.width,height:box.height,rx:22,fill:viToken('--ws-action-soft'),'fill-opacity':'.55',stroke:viToken('--ws-line'),'stroke-dasharray':'6 5'}));
   const label=se('text',{x:box.x+14,y:box.y+19,'font-size':12,fill:viToken('--ws-ink'),'font-weight':550});
   label.textContent=(group.collapsed?'▸ ':'▾ ')+(group.title||'分组')+' · '+group.nodeIds.length;
   label.append(se('title',{},'点击折叠/展开；双击改名；右侧 × 解散分组'));
   const remove=se('text',{x:box.x+box.width-20,y:box.y+19,'font-size':14,fill:viToken('--ws-muted'),class:'groupremove'});
   remove.textContent='×';remove.append(se('title',{},'解散分组（只解散分组，不删除对象）'));
   frame.append(label,remove);
   frame.addEventListener('click',event=>{
    pushHistory();
    if(event.target===remove){groups=groups.filter(item=>item.id!==group.id);markDirtyLayout();draw();return}
    group.collapsed=!group.collapsed;markDirtyLayout();draw();
   });
   frame.addEventListener('dblclick',event=>{event.preventDefault();void renameGroup(group)});
   world.append(frame);
  }
  for(const edge of liveEdges){
   const a=positions[edge.from],b=positions[edge.to];if(!a||!b)continue;
   // 待确认建议与「已确认但依据失效」都画成虚线：前者未经确认，后者不再可信。
   const suggested=edge.status==='suggested',review=Boolean(edge.stale);const dashed=suggested||review;
   // VI §8 V1 来源三态：AI 推的必须是「紫 + 虚线 + **「AI 判断」文字**」三样齐全。
   // 原来只有紫与虚线，文字一次都没出现过 —— 颜色不得单独承担判断（VI §2 / 宪章第八条）。
   const sourceLabel=suggested?'AI 判断':'';
   const group=se('g',{class:'graphlink',tabindex:0,role:'button','data-edge':edge.id,'aria-label':(edge.title||'关联')+'，'+(review?'依据已变化，待复核':suggested?'AI 判断，待确认建议':'已明确记录')});
   const sa=sizes.get(edge.from)??{w:170,h:74},sb=sizes.get(edge.to)??{w:170,h:74};
   const ax=a.x+sa.w/2,ay=a.y+sa.h/2,bx=b.x+sb.w/2,by=b.y+sb.h/2,d=`M${ax} ${ay} L${bx} ${by}`;
   const active=selection.has(edge.from)||selection.has(edge.to)||focus===edge.from||focus===edge.to;
   group.append(se('path',{d,class:'graph-hit'}),se('path',{d,fill:'none',stroke:review?viToken('--ws-warning'):suggested?viToken('--ws-knowledge'):active?viToken('--ws-action'):viToken('--ws-line'),'stroke-width':active?2.2:1.4,'stroke-opacity':active?'0.95':'0.7','stroke-dasharray':dashed?'6 6':'none'}));
   if(showsEdgeLabels(zoom)){
    const mx=(ax+bx)/2,my=(ay+by)/2,label=se('g',{class:'graph-minor graphlabel'});
    const labelText=(sourceLabel?sourceLabel+' · ':'')+(edge.title||'')+(review?' · 待复核':'');const labelWidth=labelText.length*10+16;
    label.append(se('rect',{x:mx-labelWidth/2,y:my-11,width:labelWidth,height:20,rx:7,fill:viToken('--ws-surface')}),se('text',{x:mx,y:my+3,'text-anchor':'middle','font-size':10,fill:review?viToken('--ws-warning'):suggested?viToken('--ws-knowledge'):viToken('--ws-muted')},labelText));
    group.append(label);
   }
   world.append(group);
  }
  for(const node of live){const position=positions[node.id];if(!position)continue;world.append(nodeCard(node,position,{showHandle:true}));}
  transform();
  if(status)status.dataset.readout='1';
  if(status)status.textContent=nodes.length?(()=>{
   const pending=pendingSuggestions(edges);
   const pendingText=scope==='suggestions'&&pending.length?` · 待确认 ${pending.length} 条，当前看第 1 条（点连线用操作条处理，处理完看下一条）`:'';
   return `${selection.size?'已选 '+selection.size+' 个 · ':''}${droppedEdges.length?'已隐藏 '+droppedEdges.length+' 条关联（单个对象最多显示 12 条） · ':''}共 ${nodes.length} 个对象 · ${edges.filter(edge=>edge.status!=='rejected').length} 条关联（单个对象最多显示 12 条） · 当前显示 ${live.length} 个${live.length<nodes.length?'（已按筛选收起）':''}${pendingText}`;
  })():'暂无关联对象；创建项目、任务或资料后在此显示。';
 }
 async function load(){
  const run=++epoch;let offset=0,all=[],allEdges=[],allRelationList=[],total=0;
  for(;;){const page=await send('graph',{limit:250,offset});if(disposed||run!==epoch)return;if(!Array.isArray(page?.nodes)||!Array.isArray(page?.edges))throw Error('画布数据响应无效');all=all.concat(page.nodes);allEdges=allEdges.concat(page.edges);allRelationList=allRelationList.concat(page.relations??page.edges.filter(edge=>!edge.derived));total=page.total;if(page.nextOffset===null||page.nextOffset===undefined||all.length>=1000)break;offset=page.nextOffset}
  const layout=await send('layout_get',{view:'space'});if(disposed||run!==epoch)return;
  // 角色颜色/形状映射是视图配置（layout:ecosystem）：有就按用户配置，没有就按角色稳定自动映射（不写库）。
  try{const eco=await send('layout_get',{view:'ecosystem'});if(!disposed&&run===epoch)roleMap=eco?.item?.data??null}catch{roleMap=null}
  if(disposed||run!==epoch)return;
  const savedRaw=layout?.item?.data?.positions??{};const ids=new Set(all.map(node=>node.id));
  const saved=Object.fromEntries(Object.entries(savedRaw).filter(([id])=>ids.has(id)));
  const star=starLayout(all,allEdges);
  // 星点布局一次性迁移（2026-10-18）：旧浏览器里可能存着列布局或局部拖动位置；
  // 第一次进入新画布时整体换成星点并保存，之后保留用户自己的拖动结果。
  let migrateStar=false;
  try{migrateStar=!globalThis.localStorage?.getItem('ws-space-star-v5');if(migrateStar)globalThis.localStorage?.setItem('ws-space-star-v5','1')}catch{}
  positions=migrateStar?star:wasColumnLayout(saved)?star:{...star,...saved};
  revision=layout.item?.revision??0;nodes=all;edges=allEdges;relationList=allRelationList;
  groups=(layout.item?.data?.groups??[]).map(group=>({...group,nodeIds:[...group.nodeIds]}));
  selection=new Set([...selection].filter(id=>all.some(node=>node.id===id)));
  setViValue(document,focusSelect,'');
  draw();
  // 画布打开时总是先看全图：星点/手拖布局都从全局开始，再自己缩放。
  fit();
  if(status&&total>all.length)status.textContent+=' · 数据超过画布显示条数，仅显示前 '+all.length+' 个';
  if(migrateStar)void saveLayout();
  // 挂载时页面可能还藏着（宽高为 0），等它真正显示后再全图一次。
  let tries=0;const wait=setInterval(()=>{if(disposed||tries++>20){clearInterval(wait);return}const page=document.querySelector('#space');if(page&&!page.hidden&&page.classList.contains('active')){clearInterval(wait);fit()}},200);
 }
 // ── 画布第 3 批：撤销/重做（仅视图层：位置与分组）、导出、高连接分页 ──────────
 const history={past:[],future:[]};
 const snapshot=()=>({positions:JSON.parse(JSON.stringify(positions)),groups:groups.map(group=>({...group,nodeIds:[...group.nodeIds]}))});
 function pushHistory(){
  history.past.push(snapshot());
  if(history.past.length>50)history.past.shift();
  history.future.length=0;
  syncHistoryButtons();
 }
 function restore(state){
  positions=JSON.parse(JSON.stringify(state.positions));
  groups=state.groups.map(group=>({...group,nodeIds:[...group.nodeIds]}));
  draw();void saveLayout();syncHistoryButtons();
 }
 function undo(){const state=history.past.pop();if(!state){notify('没有可撤销的画布操作',true);return}history.future.push(snapshot());restore(state)}
 function redo(){const state=history.future.pop();if(!state){notify('没有可重做的画布操作',true);return}history.past.push(snapshot());restore(state)}
 const syncHistoryButtons=()=>{
  const undoButton=document.querySelector('#canvasundo'),redoButton=document.querySelector('#canvasredo');
  if(undoButton)undoButton.disabled=!history.past.length;
  if(redoButton)redoButton.disabled=!history.future.length;
 };
 // 高连接分页用模块级纯函数（EDGES_PER_NODE / capEdges），便于单测。
 /** 导出：SVG 直接序列化（带内联样式）；PNG 把同一份 SVG 画到画布再导出。 */
 async function exportCanvas(kind){
  const clone=svg.cloneNode(true);
  clone.setAttribute('xmlns',ns);
  clone.setAttribute('width',Math.max(600,svg.clientWidth||900));
  clone.setAttribute('height',Math.max(400,svg.clientHeight||600));
  const style=document.createElementNS(ns,'style');
  style.textContent='.graphnode text{font-family:system-ui,-apple-system,sans-serif}.graphgroup text{font-family:system-ui,-apple-system,sans-serif}';
  clone.prepend(style);
  const markup=new XMLSerializer().serializeToString(clone);
  if(kind==='svg'){downloadFile(document,{filename:'关联空间.svg',mime:'image/svg+xml;charset=utf-8',content:markup});notify('已导出 SVG（只包含画布内容，不含业务数据之外的任何东西）');return}
  const image=new Image();
  const url='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(markup);
  await new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=()=>reject(Error('无法把画布转换成图片'));image.src=url});
  const canvas=document.createElement('canvas');
  canvas.width=clone.getAttribute('width');canvas.height=clone.getAttribute('height');
  const context=canvas.getContext('2d');
  context.fillStyle=viToken('--ws-surface');context.fillRect(0,0,canvas.width,canvas.height);
  context.drawImage(image,0,0);
  const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
  if(!blob)throw Error('导出 PNG 失败');
  downloadFile(document,{filename:'关联空间.png',mime:'image/png',content:blob});
  notify('已导出 PNG');
 }
 /** 连线时问清楚：什么关系 + 一句话依据（默认给一句候选，你改也行）。
  *  这块是"当场问"，不是事后用报错拦你。 */
 function askLink(source,destination){
  return new Promise(resolve=>{
   const a=source?.title??'这个对象',b=destination?.title??'那个对象';
   // 候选依据：优先取其中一方已有的描述/摘要，取不到就如实写成"你在画布上手动连线"。
   const snippet=(value)=>{
    const text=String(value??'').trim();
    if(!text)return '';
    const first=text.split(/\n|。/).map(part=>part.trim()).filter(Boolean)[0]??'';
    return first.slice(0,60);
   };
   const candidate=snippet(source?.data?.summary)||snippet(source?.data?.description)||snippet(destination?.data?.summary)||snippet(destination?.data?.description)||('你在画布上把「'+a+'」和「'+b+'」连在一起');
   // 走唯一的弹窗实现（modal.mjs）。第 12 轮实测这里曾是**全站第二套弹窗**：
   // 自己 createElement('div').className='veil'，绕过 modal.mjs，几何/焦点/关闭口径与其它弹窗不一致。
   // 用户 2026-10-13 明确要求"同一控件全站唯一实现"。改走 sharedModal 后焦点锁定、Escape、
   // 遮罩点击关闭、背景不可操作全部由那一处承担，这里只负责内容与动作。
   const request=modal.begin();
   if(request===null){resolve(null);return}
   const html=`<p class="noticeline">${esc(a)} → ${esc(b)}</p>
     <label class="field"><span>这是什么关系？</span>
      ${selectHtml({name:'linktype',attribute:'data-linktype',value:'相关',options:[['相关','相关'],['依赖','依赖'],['证据','证据'],['负责人','负责人'],['其他','其他']],placeholder:'选择关系',id:'linktype'})}</label>
     <label class="field"><span>为什么连在一起？（一句话，之后能回看）</span>
      <textarea data-linkbasis="1" rows="3">${esc(candidate)}</textarea></label>
     <p class="noticeline" data-linkhint="1">保存后立刻生效；顶部会出现「已保存 · 撤销」。</p>
     <div class="modalactions"><button class="btn primary" type="button" data-linksave="1">保存</button><button class="btn" type="button" data-linkcancel="1">取消</button></div>`;
   if(!modal.present(request,{title:'建立关联',type:'关联',html})){resolve(null);return}
   const body=document.querySelector('#detailbody');
   try{wireSelects(body,{document})}catch{/* VI 下拉初始化失败不影响保存 */}
   let settled=false;
   const finish=answer=>{if(settled)return;settled=true;modal.close();resolve(answer)};
   body.querySelector('[data-linksave]').onclick=()=>{
    const type=body.querySelector('[data-linktype]')?.value||body.querySelector('#linktype')?.value||'相关';
    const basis=body.querySelector('[data-linkbasis]').value.trim();
    if(!basis){body.querySelector('[data-linkhint]').textContent='还差一句依据：写清为什么把它们连在一起。';return}
    finish({type,basis});
   };
   for(const node of body.querySelectorAll('[data-linkcancel]'))node.onclick=()=>finish(null);
   body.querySelector('[data-linkbasis]').focus();
  });
 }
 // ── A4：布局的显式保存 ───────────────────────────────────────────────────
 // 17 C9 的只读纪律：缩放/平移/拖拽/折叠都只是视图状态，**不写库**；只有点「保存布局」才落一次
 // （revision +1）。结构态更严格：展开状态 v1 只存在于本次会话，保存按钮也不落它（spec/54 §2.3）。
 let layoutDirty=false;
 function syncSaveButton(){
  const button=document.querySelector('#savelayout');
  if(!button)return;
  button.textContent=layoutDirty?'保存布局 •':'保存布局';
  button.dataset.dirty=layoutDirty?'1':'0';
  button.setAttribute('aria-label',layoutDirty?'保存布局（有未保存的位置与缩放）':'保存布局（已保存）');
 }
 function markDirtyLayout(){
  if(mode==='structure'){syncSaveButton();return}
  layoutDirty=true;syncSaveButton();
 }
 function saveLayout(){
  // 结构态：展开/镜头/拖动都只是本次会话的视图状态，不写业务数据（显式保存归 A4）。
  if(mode==='structure'){layoutDirty=false;syncSaveButton();return Promise.resolve();}
  if(pending)return pending;
  const run=++epoch,snapshot={...positions},viewport={x:gx,y:gy,zoom};
  pending=(async()=>{try{await send('layout_save',{view:'space',revision,positions:snapshot,viewport,groups:groups.map(group=>({...group,nodeIds:[...group.nodeIds]})),key:key()});if(!disposed&&run===epoch){revision+=1;layoutDirty=false;syncSaveButton()}}catch(error){if(!disposed)notify('画布布局未保存：'+error.message,true)}finally{pending=null}})();
  return pending;
 }
 async function decide(edge,next,{withBasis=false}={}){
  const data=relationData(edge,next);
  if(withBasis){
   // 确认时记录两端版本作为依据，之后任一来源更新即显示待复核。
   const basis=[];
   for(const id of [edge.from,edge.to]){const node=nodes.find(item=>item.id===id);if(!node)continue;const {item}=await send('get',{id});if(item&&!item.archived)basis.push(id+'@'+item.revision);}
   if(basis.length)data.basis=basis;
  }
  await batch.draft('关系判定 · '+(edge.title||'关联'),[{op:'update',id:edge.id,expectedRevision:edge.revision,data}]);
 }
 /** 处理一条"AI 提议的关联"：同意 = 提交收件箱里那条改动；不用了 = 撤销它。
  *  为什么走收件箱链路而不是另写一条关系：同一条建议在两个地方要有同一个结果，
  *  否则"在画布上点了同意"和"在收件箱里点了同意"会变成两件事。 */
 async function respondPending(edge,accept){
  try{
   // 注意：浏览器接口的提交参数名是 `id`（Agent 工具那边叫 `batchId`）—— 传错会得到一个笼统的"服务错误"。
   if(accept)await send('commit',{id:edge.pendingBatchId,revision:edge.pendingRevision,key:'canvas-accept-'+edge.pendingBatchId});
   else await send('cancel_draft',{id:edge.pendingBatchId,revision:edge.pendingRevision});
   notify(accept?'已同意这条关联':'这条关联不再提了');
   await load();
  }catch(error){notify('没能处理这条关联：'+error.message,true)}
 }
 /** 点虚线（AI 建议 / 待确认 / 待复核）时的**画布内操作条**（PRD CV-08：不强制弹窗）。
  *  看依据 → 打开现有的关联证据弹窗（内容仍是同一份）；同意 / 不同意 / 稍后 直接处理，
  *  走的是与收件箱同一条链路（不另造一套写入）。 */
 function showEdgeActions(id){
  const edge=relationList.find(item=>item.id===id)??edges.find(item=>item.id===id);
  if(!edge)return;
  const light=edge.status==='suggested'||Boolean(edge.pendingBatchId)||Boolean(edge.stale);
  if(!light){edgeDialog(id);return}
  document.querySelector('#canvasactionbar')?.remove();
  const fromPosition=positions[edge.from],toPosition=positions[edge.to];
  const stage=document.querySelector('#space .spacestage');
  if(!stage||!fromPosition||!toPosition){edgeDialog(id);return}
  const svgRect=svg.getBoundingClientRect?.()??{left:0,top:0};
  const fromSize=sizes.get(edge.from)??{w:200,h:86},toSize=sizes.get(edge.to)??{w:200,h:86};
  const midX=svgRect.left+((fromPosition.x+fromSize.w/2+toPosition.x+toSize.w/2)/2)*zoom+gx;
  const midY=svgRect.top+((fromPosition.y+fromSize.h/2+toPosition.y+toSize.h/2)/2)*zoom+gy;
  const bar=document.createElement('div');
  bar.className='canvasactionbar';bar.id='canvasactionbar';bar.dataset.edgeActions=id;
  bar.innerHTML='<span class="canvasactionbar-title">'+esc(edge.title||'关联')+'</span>'
   +'<span class="canvasactionbar-state">'+(edge.pendingBatchId?'AI 提议 · 还没生效 · 等你决定':edge.stale?'已确认 · 待复核':'待确认建议')+'</span>'
   +'<button class="btn" type="button" data-edge-action="basis">看依据</button>'
   +'<button class="btn primary" type="button" data-edge-action="accept">同意</button>'
   +'<button class="btn" type="button" data-edge-action="reject">不同意</button>'
   +'<button class="btn txt" type="button" data-edge-action="later">稍后</button>';
  bar.style.left=Math.max(8,Math.min(midX-140,Math.max(8,(globalThis.innerWidth??1440)-300)))+'px';
  bar.style.top=Math.max(8,midY-46)+'px';
  stage.append(bar);
  const close=()=>bar.remove();
  bar.querySelector('[data-edge-action="basis"]').onclick=()=>{close();edgeDialog(id)};
  bar.querySelector('[data-edge-action="later"]').onclick=close;
  bar.querySelector('[data-edge-action="accept"]').onclick=()=>{
   close();
   if(edge.pendingBatchId)void respondPending(edge,true);
   else decide(edge,'confirmed',{withBasis:true}).catch(error=>notify(error.message,true));
  };
  bar.querySelector('[data-edge-action="reject"]').onclick=()=>{
   close();
   if(edge.pendingBatchId)void respondPending(edge,false);
   else decide(edge,'rejected').catch(error=>notify(error.message,true));
  };
  // 点空白处 / Esc 收起操作条（不改变任何数据）
  const dismiss=event=>{if(!bar.isConnected)return;if(event.type==='keydown'&&event.key!=='Escape')return;if(event.type==='pointerdown'&&bar.contains(event.target))return;close()};
  document.addEventListener('pointerdown',dismiss);
  document.addEventListener('keydown',dismiss);
 }
 function edgeDialog(id){
  const edge=relationList.find(item=>item.id===id)??edges.find(item=>item.id===id);if(!edge)return;const request=token=modal.begin();if(request===null)return;
  const from=nodes.find(node=>node.id===edge.from),to=nodes.find(node=>node.id===edge.to),suggested=edge.status==='suggested',review=Boolean(edge.stale);
  const isPending=Boolean(edge.pendingBatchId);
  const state=isPending?'AI 提议 · 等你决定':suggested?'待确认建议':review?'已确认 · 待复核':edge.status==='confirmed'?'已确认':'未记录状态';
  const html=`<p>${esc(from?.title??edge.from)} → ${esc(to?.title??edge.to)}</p><div class="proof"><b>关联类型</b><br>${esc(edge.title||'未命名')}<br><br><b>来源依据</b><br>${esc(edge.evidence||'由对象字段推导，没有独立保存的依据。')}</div><p>状态：${esc(state)}${edge.derived?' · 由对象字段推导，不可在此修改':''}</p>${review?`<p class="notice">复核原因：${esc(edge.stale)}。确认时的对象版本已变化，关系不再自动可信；重新确认会记录当前版本，或忽略。</p>`:''}<p class="notice">${isPending?'这条是 AI 从已有数据里推断的，还没生效 —— 只有你同意之后才会成为正式关联。':'关系状态保存在工作台数据库；确认、忽略或撤销都会先生成待你确认的改动，并让你先看一眼。'}</p><div class="modalactions">${isPending?'<button class="btn primary" id="edgeAccept">同意这条关联</button><button class="btn" id="edgeDecline">不用了</button>':''}${!isPending&&!edge.derived&&suggested?'<button class="btn primary" id="edgeConfirm">确认关联</button><button class="btn" id="edgeReject">忽略建议</button>':''}${!edge.derived&&review?'<button class="btn primary" id="edgeReconfirm">重新确认（记录当前版本）</button><button class="btn" id="edgeReject">忽略</button>':''}${!edge.derived&&!suggested&&!review?'<button class="btn" id="edgeReopen">撤销判断</button>':''}<button class="btn" id="edgeFocus">聚焦此关系</button><button class="btn" id="edgeClose">关闭</button></div>`;
  if(!modal.present(request,{title:edge.title||'关联证据',type:'关联证据',html}))return;
  const act=(selector,next,options)=>{const node=document.querySelector(selector);if(node)node.onclick=()=>{modal.close();decide(edge,next,options).catch(error=>notify(error.message,true))}};
  wire('#edgeClose',()=>modal.close());
  wire('#edgeFocus',()=>{focus=edge.from;setViValue(document,scopeSelect,'all');setViValue(document,focusSelect,nodes.find(node=>node.id===edge.from)?.kind==='project'?edge.from:'');modal.close();draw();fit()});
  if(isPending){
   // 同意 / 不用了：直接处理收件箱里那一条（同一条链路，不另造一套）。
   wire('#edgeAccept',()=>{modal.close();void respondPending(edge,true)});
   wire('#edgeDecline',()=>{modal.close();void respondPending(edge,false)});
  } else if(suggested)act('#edgeConfirm','confirmed',{withBasis:true}),act('#edgeReject','rejected');
  else if(review)act('#edgeReconfirm','confirmed',{withBasis:true}),act('#edgeReject','rejected');
  else act('#edgeReopen','suggested');
 }
 function focusOn(id){
  if(!nodes.some(item=>item.id===id))return false;
  focus=id;setViValue(document,scopeSelect,'all');
  // hidden input 没有 .options；能不能聚焦看的是**候选里有没有这个 id**（VI 下拉的选项）。
  const focusWrapper=focusSelect?.closest('[data-viselect]');
  const canFocus=Boolean(focusWrapper&&[...focusWrapper.querySelectorAll('[data-viselect-option]')].some(option=>option.dataset.viselectOption===id));
  setViValue(document,focusSelect,canFocus?id:'');
  draw();fit();return true;
 }
 /** 重命名：只改 title，其余字段原样带回（不覆盖 Agent 写过的属性）。 */
 /** 结构态单击：机构 → 原地长出项目；项目 → 旁边长出任务；再点同一对象收起（D4：一次只展开一个分支）。
  *  不换页、不改路由、不移动其它节点；镜头由 focusBranch() 放大到这一支。 */
 function toggleNode(id,{openOnUnsupported=false}={}){
  const node=nodeOf(id);if(!node)return false;
  if(!['organization','project'].includes(node.kind)){if(openOnUnsupported)open?.(id);return false}
  if(node.kind==='organization'){
   const next=expandState({expandedId:expandedOrg,itemIds:[]},id,{nodes});
   expandedOrg=next.expandedId;expandedProject=null;
   if(expandedOrg&&!childrenOf(expandedOrg,{nodes}).items.length)notify('这个机构还没有主责或参与的项目');
  }else if(expandedProject===id){expandedProject=null}
  else{
   expandedProject=id;
   // 项目在机构分支里被点开时保留机构分支；不在该分支里（未归属桶里的项目）就只开它自己的任务。
   if(expandedOrg&&!childrenOf(expandedOrg,{nodes}).items.includes(id))expandedOrg=null;
  }
  draw();
  if(branchRects().length)focusBranch();else fit();
  return true;
 }
 function activate(id){
  const node=nodes.find(item=>item.id===id);if(!node)return;
  if(mode==='structure')return toggleNode(id,{openOnUnsupported:true});
  if(['project','task','artifact','topic','memoryRef','event'].includes(node.kind)){
   focusOn(id);notify('已展开「'+(node.title||'未命名')+'」及其关联节点');
   return;
  }
  open?.(id);
 }
 function relations(){  const request=token=modal.begin();if(request===null)return;
  const html=`<div class="relationlist">${relationList.map(edge=>`<button class="btn" data-region="${esc(edge.id)}">${esc(edge.title||'关联')} · ${esc(edge.stale?'待复核':edge.status==='suggested'?'待确认':edge.status==='rejected'?'已忽略':'已确认')}${edge.stale?`（${esc(edge.stale)}）`:edge.derived?'（由内容推导）':''}</button>`).join('')||'<p>当前没有关联记录。</p>'}</div><p class="notice">已忽略的建议不会出现在画布上；撤销判断会恢复为待确认。</p>`;
  if(!modal.present(request,{title:'关系与依据',type:'关联清单',html:html+'<div class="modalactions"><button class="btn" id="relationsclose">关闭</button></div>'}))return;
  {const close=document.querySelector('#detailbody #relationsclose');if(close)close.onclick=()=>modal.close();}
  for(const node of document.querySelectorAll('#detailbody [data-region]'))node.onclick=()=>edgeDialog(node.dataset.region);
 }
 function explain(){
  const request=token=modal.begin();if(request===null)return;
  const html='<div class="proof">业务记录：项目、任务、会议与当前状态。<br>知识：资料、议题与引用证据。<br>关系层：对象 ID、关联类型、依据、确认与失效状态。</div><p>当前画布只展示数据库中的真实对象与关联：项目归属、负责人、合作方、组织与任务依赖由对象字段推导；其余关系来自保存的关联记录。虚线表示状态为待确认的关联。</p><p class="notice">模型推断服务尚未接入：这里不会自动生成 AI 建议，也不会自动确认关系。原文更新、权限撤回或事实失效后的重新评估同样未实现。</p>';
  if(modal.present(request,{title:'关联如何产生',type:'关联如何产生',html:html+'<div class="modalactions"><button class="btn" id="explainclose">关闭</button></div>'})){
   const close=document.querySelector('#detailbody #explainclose');if(close)close.onclick=()=>modal.close();
   return;
  }
 }
 wire('#more',()=>{setZoom(Math.min(2.5,zoom*1.2));markDirtyLayout()});
 wire('#less',()=>{setZoom(Math.max(.25,zoom/1.2));markDirtyLayout()});
 wire('#fitspace',()=>{fit();markDirtyLayout()});
 wire('#resetlayout',()=>{
  if(mode==='structure'){structMoved={};expandedOrg=null;expandedProject=null;draw();fit();return}
  pushHistory();positions={...spaceLayout(nodes)};draw();fit();markDirtyLayout();});
 wire('#allrelations',relations);

 // ── 画布第 2 批：节点内预览（文本/图片/PDF/Office）与手动连线 ───────────
 const stageEl0=document.querySelector('.spacestage');
 const panel=document.createElement('div');
 panel.className='canvaspreview';panel.id='canvaspreview';panel.hidden=true;
 if(stageEl0)stageEl0.append(panel);
 function closePreview(){panel.hidden=true;panel.replaceChildren()}
 // 预览路由需要工作区标识：读一次运行状态并缓存（读不到就返回空串，路由会如实报错）
 let workspaceId='';
 async function currentWorkspace(){
  if(workspaceId)return workspaceId;
  try{const status=await send('runtime_status');workspaceId=status?.workspace?.id??''}catch{workspaceId=''}
  return workspaceId;
 }
 /** 在画布内直接看内容：图片/PDF/Office 走既有受权字节路由；文本走阅读器（markdown 渲染）。
  *  只读，不改记录；没有文件路径的材料显示其正文。 */
 async function openPreview(nodeId){
  const node=nodes.find(item=>item.id===nodeId);if(!node)return;
  const {item}=await send('get',{id:nodeId});if(!item)return;
  const data=item.data??{};
  panel.hidden=false;
  panel.replaceChildren();
  const head=document.createElement('div');head.className='canvaspreview-head';
  const title=document.createElement('strong');title.textContent=node.title||'预览';
  const close=document.createElement('button');close.className='btn';close.type='button';close.textContent='关闭';
  close.onclick=closePreview;
  head.append(title,close);panel.append(head);
  const body=document.createElement('div');body.className='canvaspreview-body';panel.append(body);
  const suffix=String(data.path??'').toLowerCase().split('.').pop();
  const office=['doc','docx','xls','xlsx','ppt','pptx'].includes(suffix);
  if(data.path&&data.fileGrantId){
   const source='/personal-workstation/file?'+new URLSearchParams({workspace:await currentWorkspace(),grantId:data.fileGrantId,path:data.path});
   if(['png','jpg','jpeg','gif','webp','svg','bmp'].includes(suffix)){const img=document.createElement('img');img.src=source;img.alt=node.title||'';body.append(img)}
   else if(suffix==='pdf'||office){const frame=document.createElement('iframe');frame.src=source;frame.title=node.title||'预览';body.append(frame)}
   else {
    // 文本走 file_read（与材料详情的「读取文件内容」同一条通道）：预览路由只收图片/PDF/Office。
    const caption=document.createElement('p');caption.className='notice';caption.textContent='正在读取文件…';body.append(caption);
    try{
     const result=await send('file_read',{grantId:data.fileGrantId,path:data.path});
     caption.remove();const holder=document.createElement('div');holder.className='reader';holder.innerHTML=readerHtml(result.content??'');body.append(holder);
    }catch(error){caption.textContent='打不开这个文件：'+error.message+'（可能是目录未授权，或文件已移动）'}
   }
  }else if(typeof data.content==='string'&&data.content.trim()){
   const holder=document.createElement('div');holder.className='reader';holder.innerHTML=readerHtml(data.content);body.append(holder);
  }else{
   const empty=document.createElement('p');empty.className='notice';empty.textContent='这条记录既没有文件路径也没有正文，没有可预览的内容。';
   body.append(empty);
  }
 }
 closePreview();

 // ── 画布第 1 批：框选后的批量操作条 + 分组 ─────────────────────────────
 const stageEl=document.querySelector('.spacestage');
 const bar=document.createElement('div');
 bar.className='canvasbar';bar.id='canvasbar';bar.hidden=true;
 bar.innerHTML='<span class="count" id="canvasbarcount">已选 0 个</span>'
  +'<button class="btn" id="canvasgroup">归为一组</button>'
  +'<button class="btn" id="canvasassign">改归属项目</button>'
  +'<button class="btn" id="canvasconfirm">确认建议</button>'
  +'<button class="btn" id="canvasignore">忽略建议</button>'
  +'<button class="btn" id="canvasarchive">归档</button>'
  +'<button class="btn" id="canvascancel">取消选择</button>';
 if(stageEl)stageEl.append(bar);
 const tool=(id,text,run)=>{const button=document.createElement('button');button.className='btn';button.id=id;button.type='button';button.textContent=text;button.onclick=run;return button};
 const undoButton=tool('canvasundo','撤销',undo),redoButton=tool('canvasredo','重做',redo);
 const exportSvg=tool('canvasexportsvg','导出 SVG',()=>void exportCanvas('svg').catch(error=>notify(error.message,true)));
 const exportPng=tool('canvasexportpng','导出 PNG',()=>void exportCanvas('png').catch(error=>notify(error.message,true)));
 const saveButton=tool('savelayout','保存布局',()=>void saveLayout().then(()=>notify(layoutDirty?'布局仍未保存':'已保存画布布局')).catch(error=>notify('画布布局未保存：'+error.message,true)));
 syncSaveButton();
 const selectButton=document.createElement('button');
 selectButton.className='btn';selectButton.id='canvasselect';selectButton.type='button';selectButton.textContent='框选';
 const toolbar=document.querySelector('#space .spacebar');
 if(toolbar)toolbar.append(selectButton,undoButton,redoButton,exportSvg,exportPng);
 syncHistoryButtons();
 selectButton.onclick=()=>{selectMode=!selectMode;selectButton.classList.toggle('active',selectMode);notify(selectMode?'框选模式：在空白处拖拽选择对象（Shift+拖拽同样可用）':'已退出框选模式')};

 function syncBar(){
  const count=selection.size;
  if(bar){bar.hidden=count===0;const label=bar.querySelector('#canvasbarcount');if(label)label.textContent='已选 '+count+' 个'}
  const suggested=selectedSuggestedEdges().length;
  for(const [id,visible] of [['#canvasgroup',count>1],['#canvasassign',count>0],['#canvasarchive',count>0],['#canvasconfirm',suggested>0],['#canvasignore',suggested>0]]){
   const button=bar?.querySelector(id);if(button)button.hidden=!visible;
  }
 }
 /** 选中节点之间的「待确认建议」关系：批量确认/忽略的作用对象。 */
 function selectedSuggestedEdges(){
  return edges.filter(edge=>edge.status==='suggested'&&selection.has(edge.from)&&selection.has(edge.to));
 }
 function clearSelection(){selection=new Set();draw();syncBar()}
 const groupName=async(defaultName)=>{
  const request=token=modal.begin();if(request===null)return null;
  const html='<div class="formrow"><label>分组名称<input id="groupname" value="'+esc(defaultName)+'" placeholder="例如：示例科技相关"></label></div><p class="notice">分组只改变画布视图（位置与折叠），不会修改项目、任务或关系；随布局一起保存。</p>';
  if(!modal.present(request,{title:'归为一组',type:'画布分组',html:html+'<div class="modalactions"><button class="btn primary" id="groupok">创建分组</button><button class="btn" id="groupcancel">取消</button></div>'}))return null;
  return await new Promise(resolve=>{
   wire('#groupcancel',()=>{modal.close();resolve(null)});
   wire('#groupok',()=>{const value=document.querySelector('#detailbody #groupname')?.value?.trim();modal.close();resolve(value||null)});
  });
 };
 async function renameGroup(group){
  const name=await groupName(group.title||'分组');if(!name)return;
  group.title=name;markDirtyLayout();draw();
 }
 async function makeGroup(){
  if(selection.size<2){notify('至少选中两个对象才能分组',true);return}
  const name=await groupName('分组 '+(groups.length+1));if(!name)return;
  pushHistory();
  const members=[...selection];
  // 同一对象只属于一个分组：先从旧分组里摘掉，避免"一物两组"。
  for(const group of groups)group.nodeIds=group.nodeIds.filter(id=>!members.includes(id));
  groups=groups.filter(group=>group.nodeIds.length);
  groups.push({id:'group-'+Date.now().toString(36),title:name,nodeIds:members,collapsed:false});
  markDirtyLayout();draw();syncBar();notify('已创建分组「'+name+'」：'+members.length+' 个对象');
 }
 /** 批量改归属：一个批次里多条更新，走同一套草稿与确认（可撤销）。 */
 async function assignProject(){
  const {items=[]}=await send('list',{kind:'project',limit:200});
  const live=items.filter(item=>!item.archived);
  if(!live.length){notify('还没有项目可归属',true);return}
  const targets=nodes.filter(node=>selection.has(node.id)&&['task','artifact','topic','event'].includes(node.kind));
  if(!targets.length){notify('选中的对象里没有可归属的类型（只有任务/资料/议题/事务能归属项目）',true);return}
  const request=token=modal.begin();if(request===null)return;
  const html='<div class="formrow">'+selectHtml({name:'project',label:'归属项目',value:'',options:[['','（不归属）'],...live.map(item=>[item.id,item.data.title])],placeholder:'选择项目'})+'</div><p class="notice">将对 '+targets.length+' 个对象生成一条变更待确认的改动，在收件箱确认后生效；可凭记录编号撤销。</p>';
  if(!modal.present(request,{title:'批量改归属',type:'批量操作',html:html+'<div class="modalactions"><button class="btn primary" id="assignok">生成待确认的改动</button><button class="btn" id="assigncancel">取消</button></div>'}))return;
  wireSelects(document.querySelector('#detailbody'),{document});
  wire('#assigncancel',()=>modal.close());
  wire('#assignok',()=>{
   const value=document.querySelector('#detailbody input[type="hidden"][data-field="project"]')?.value??'';
   modal.close();
   void (async()=>{
    const list=[];
    for(const node of targets){
     const {item}=await send('get',{id:node.id});if(!item)continue;
     const data={...item.data};if(value)data.projectId=value;else delete data.projectId;
     list.push({op:'update',id:item.id,expectedRevision:item.revision,data,sources:{projectId:value?'用户在画布批量指定归属':'用户在画布取消归属'}});
    }
    if(!list.length){notify('没有可更新的对象',true);return}
    await batch.draft('画布批量改归属 · '+list.length+' 个对象',list);
    clearSelection();
   })().catch(error=>notify(error.message,true));
  });
 }
 /** 批量确认/忽略：作用于"选中对象之间"的建议关系（一次一条草稿）。 */
 async function decideSelected(next){
  const list=selectedSuggestedEdges();
  if(!list.length){notify('选中的对象之间没有待确认的建议',true);return}
  await batch.draft((next==='confirmed'?'画布批量确认 ':'画布批量忽略 ')+list.length+' 条建议',
   list.map(edge=>({op:'update',id:edge.id,expectedRevision:edge.revision,data:relationData(edge,next),sources:{status:'用户在画布批量'+(next==='confirmed'?'确认':'忽略')}})));
  clearSelection();
 }
 async function archiveSelected(){
  const targets=nodes.filter(node=>selection.has(node.id)&&!['layout','relation'].includes(node.kind));
  if(!targets.length){notify('选中的对象不可归档',true);return}
  await batch.draft('画布批量归档 · '+targets.length+' 个对象',targets.map(node=>({op:'archive',id:node.id,expectedRevision:node.revision,sources:{}})));
  clearSelection();
 }
 wire('#canvascancel',clearSelection);
 const groupButton=bar.querySelector('#canvasgroup');if(groupButton)groupButton.onclick=()=>{void makeGroup()};
 const assignButton=bar.querySelector('#canvasassign');if(assignButton)assignButton.onclick=()=>{void assignProject()};
 const confirmButton=bar.querySelector('#canvasconfirm');if(confirmButton)confirmButton.onclick=()=>{void decideSelected('confirmed')};
 const ignoreButton=bar.querySelector('#canvasignore');if(ignoreButton)ignoreButton.onclick=()=>{void decideSelected('rejected')};
 const archiveButton=bar.querySelector('#canvasarchive');if(archiveButton)archiveButton.onclick=()=>{void archiveSelected()};
 syncBar();
 wire('#aiExplain',explain);
 // 新增节点：走统一新建流程（同一套草稿与确认），创建后由控制器重新加载并重新适配视图。
 const newButton=document.querySelector('#spacenew');
 if(newButton)newButton.onclick=()=>onCreate?.();
 wire('#globalCanvas',()=>{scope='all';focus='';expandedOrg=null;expandedProject=null;structMoved={};setViValue(document,scopeSelect,mode==='structure'?'structure':'all');setViValue(document,focusSelect,'');draw();fit()});
 // 原型中由布局脚本插入的两个控件：整屏画布与聚焦对象详情。
 // 画布提示条：把真实交互说清楚（冻结原型的文案不能改，这里在运行时更新）。
 (function refreshCaption(){
  const caption=document.querySelector('#space .spacecaption');
  if(caption)caption.textContent='单击开详情 · 双击展开 · 拖动平移 · 滚轮缩放 · 拖右侧圆点连线';
 })();
 // 顶部按钮收拢：一行只留高频操作，其余进「更多」。原来一行 15 个按钮，
 // 「全局视图 / 全屏画布 / 全图」三个还长得像，用户分不清（用户 2026-10-12 反馈）。
 (function consolidateToolbar(){
  const bar=document.querySelector('#space .spacebar');
  if(!bar||bar.querySelector('[data-moretools]'))return;
  const more=document.createElement('button');
  more.className='btn';more.type='button';more.dataset.moretools='1';more.textContent='更多 ▾';
  const panel=document.createElement('div');
  panel.className='morepanel';panel.hidden=true;panel.dataset.morepanel='1';
  panel.innerHTML='<p class="noticeline">画布操作</p>';
  bar.append(more);
  bar.parentElement?.append(panel);
  const move=(id,label)=>{const node=typeof id==='string'?document.querySelector(id):id;if(!node)return;if(label&&node.textContent.trim().length>8)node.textContent=label;panel.append(node)};
  move('#aiExplain');move('#allrelations');move('#canvasselect');move('#canvasundo');move('#canvasredo');
  move(saveButton);move('#canvasexportsvg');move('#canvasexportpng');move('#resetlayout');
  const full=[...document.querySelectorAll('#space button')].find(node=>/全屏画布|退出全屏/.test(node.textContent));
  const focus=[...document.querySelectorAll('#space button')].find(node=>node.textContent.trim()==='打开聚焦对象详情');
  move(full);move(focus);
  const global=document.querySelector('#globalCanvas');
  if(global)global.textContent='全部关系';
  more.onclick=()=>{panel.hidden=!panel.hidden};
  for(const button of panel.querySelectorAll('button'))button.addEventListener('click',()=>{panel.hidden=true});
 })();

 const space=document.querySelector('#space'),stage=document.querySelector('.spacestage');
 const buttons=[...document.querySelectorAll('#space button')];
 const fullButton=buttons.find(node=>/全屏画布|退出全屏/.test(node.textContent));
 const focusButton=buttons.find(node=>node.textContent.trim()==='打开聚焦对象详情');
 const expanded=()=>space.classList.contains('expanded-screen');
 const toggleFullscreen=()=>{
  const on=!expanded();space.classList.toggle('expanded-screen',on);
  stage.style.cssText=on?'position:fixed;inset:0;z-index:7;background:var(--ws-paper);padding:var(--ws-space-16);overflow:auto;margin:0':'';
  stage.style.height=on?'calc(100dvh - 155px)':'';
  if(fullButton)fullButton.textContent=on?'退出全屏':'全屏画布';
  fit();
 };
 const shortcuts=event=>{
  if(!(event.metaKey||event.ctrlKey))return;
  if(event.key.toLowerCase()!=='z')return;
  event.preventDefault();
  if(event.shiftKey)redo();else undo();
 };
 document.addEventListener('keydown',shortcuts);
 const escapeFullscreen=event=>{
  if(event.key!=='Escape'||document.querySelector('#veil').classList.contains('open'))return;
  if(mode==='structure'&&(expandedOrg||expandedProject)){expandedOrg=null;expandedProject=null;draw();fit();return}
  if(selection.size){selection=new Set();draw();syncBar();return}
  if(expanded())toggleFullscreen();
 };
 if(fullButton)fullButton.onclick=toggleFullscreen;
 if(focusButton)focusButton.onclick=()=>{if(!focus){notify('请先点击节点或选择聚焦项目',true);return}open?.(focus)};
 document.addEventListener('keydown',escapeFullscreen);
 if(scopeSelect)scopeSelect.onchange=()=>{
  mode=['structure','all','shared','suggestions'].includes(scopeSelect.value)?scopeSelect.value:'structure';
  scope=scopeSelect.value==='structure'?'all':scopeSelect.value;
  focus='';expandedOrg=null;expandedProject=null;structMoved={};setViValue(document,focusSelect,'');
  draw();fit();
 };
 if(focusSelect){setViOptions(document,focusSelect,[['','所有项目'],...projects.map(project=>[project.id,project.title])]);focusSelect.onchange=()=>{focus=focusSelect.value;scope='all';expandedOrg=null;expandedProject=null;structMoved={};if(mode!=='structure')setViValue(document,scopeSelect,'all');draw();fit()}}
 const search=document.querySelector('#graphsearch');
 if(search)search.onkeydown=async event=>{if(event.key!=='Enter')return;const query=search.value.trim();if(!query)return;try{const result=await send('node_search',{query,limit:20});if(disposed)return;const hit=result.items?.[0];if(!hit){notify('未找到匹配对象',true);return}focus=hit.id;draw();fit()}catch(error){notify(error.message,true)}};
 // 世界坐标（画布坐标系）换算：框选与分组都用它。
 const toWorld=event=>{const rect=svg.getBoundingClientRect();return {x:(event.clientX-rect.left-gx)/zoom,y:(event.clientY-rect.top-gy)/zoom}};
 const pointerDown=event=>{
  if(event.button!==0)return;
  const target=event.target.closest?.('[data-node]'),id=target?.dataset.node;
  // Shift+点击节点＝加入/移出选择（不触发聚焦或详情）；空白处 Shift+拖拽＝框选。
  if(id&&event.shiftKey){if(selection.has(id))selection.delete(id);else selection.add(id);draw();syncBar();event.preventDefault();return}
  if(!id&&(selectMode||event.shiftKey)){const point=toWorld(event);marquee={id:event.pointerId,x1:point.x,y1:point.y,x2:point.x,y2:point.y};moved=false;try{svg.setPointerCapture?.(event.pointerId)}catch{/* 节点重绘后指针可能已失效：忽略即可，不影响点击与拖动 */};drawMarquee();return}
  if(id)pushHistory();
  const startPosition=mode==='structure'?(structPositions[id]??childPositions[id]):positions[id];
  drag={id:event.pointerId,x:event.clientX,y:event.clientY,gx,gy,nodeId:id,start:startPosition?{...startPosition}:null};moved=false;try{svg.setPointerCapture?.(event.pointerId)}catch{/* 节点重绘后指针可能已失效：忽略，不影响点击与拖动 */}};
 const drawMarquee=()=>{const world=svg.querySelector('#spaceworld');if(!world)return;world.querySelector('#marquee')?.remove();if(!marquee)return;
  const rect=se('rect',{id:'marquee',x:Math.min(marquee.x1,marquee.x2),y:Math.min(marquee.y1,marquee.y2),width:Math.abs(marquee.x2-marquee.x1),height:Math.abs(marquee.y2-marquee.y1),fill:viToken('--ws-action'),'fill-opacity':'.08',stroke:viToken('--ws-action'),'stroke-dasharray':'4 4'});
  world.append(rect)};
 const pointerMove=event=>{
  if(link&&event.pointerId===link.id){
   const point=toWorld(event),from=positions[link.from];
   const ghost=svg.querySelector('#linkghost');
   if(ghost&&from)ghost.setAttribute('d',`M${from.x+(sizes.get(link.from)?.w??200)} ${from.y+(sizes.get(link.from)?.h??74)/2} L${point.x} ${point.y}`);
   return;
  }
  if(marquee&&event.pointerId===marquee.id){const point=toWorld(event);marquee.x2=point.x;marquee.y2=point.y;moved=true;drawMarquee();return}
  if(!drag||event.pointerId!==drag.id)return;const dx=event.clientX-drag.x,dy=event.clientY-drag.y;if(Math.abs(dx)+Math.abs(dy)>4)moved=true;if(!moved)return;
  if(drag.nodeId&&drag.start){
   const target=mode==='structure'?(structPositions[drag.nodeId]?structPositions:childPositions[drag.nodeId]?childPositions:null):positions;
   if(target)target[drag.nodeId]={x:drag.start.x+dx/zoom,y:drag.start.y+dy/zoom};
   draw();
  }else{gx=drag.gx+dx;gy=drag.gy+dy;transform()}};
 const pointerUp=event=>{
  if(link&&event.pointerId===link.id){
   const from=link.from;link=null;
   svg.querySelector('#linkghost')?.remove();
   // 用了 pointer capture，pointerup 的 event.target 是 SVG 而不是节点；
   // 因此按坐标命中（elementFromPoint）判断松手时落在哪个节点上。
   const under=document.elementFromPoint?.(event.clientX,event.clientY);
   const target=under?.closest?.('[data-node]')?.dataset.node??event.target.closest?.('[data-node]')?.dataset.node;
   if(!target||target===from){notify('连线取消：请从节点右侧的小圆点拖到另一个对象上',true);return}
   const exists=edges.some(edge=>((edge.from===from&&edge.to===target)||(edge.from===target&&edge.to===from))&&edge.status!=='rejected');
   if(exists){notify('这两个对象之间已经有关联了',true);return}
   void (async()=>{
    const source=nodes.find(node=>node.id===from),destination=nodes.find(node=>node.id===target);
    // 你自己连的线：当场问清"什么关系、为什么"，保存即生效（不再生成待确认的改动、也不会事后报错卡住）。
    const answer=await askLink(source,destination);
    if(!answer)return;
    try{
     const receipt=await batch.apply('画布关联：'+(source?.title??from)+' → '+(destination?.title??target),[{op:'create',kind:'relation',data:{
      title:answer.type,from,to:target,status:'confirmed',
      reason:answer.basis,evidence:answer.basis,
     },sources:{from:'你在画布上手动连线',to:'你在画布上手动连线',status:'你在画布上手动连线',reason:'你在画布上填写的依据',evidence:'你在画布上填写的依据'}}],{label:'这条关联'});
     void receipt;
    }catch(error){notify(error.message,true)}
   })();
   return;
  }
  if(marquee&&event.pointerId===marquee.id){
   const box={...marquee};const dragged=moved;marquee=null;
   svg.querySelector('#spaceworld #marquee')?.remove();
   if(dragged){const hiddenNow=hiddenByGroups(groups);const vis=shown().filter(node=>!hiddenNow.has(node.id));const sm=sizeMap(vis,edges);const placed=vis.map(node=>({n:node,position:positions[node.id]}));const hit=marqueeSelect(box,placed,sm);selection=new Set(hit);notify(hit.length?'已选中 '+hit.length+' 个对象':'没有选中对象')}
   else selection=new Set();
   draw();syncBar();return;
  }
  if(!drag)return;const dragged=moved,draggedNode=drag.nodeId;drag=null;
  if(dragged){
   // 结构态拖动只在本次会话生效（不写业务数据）；关系态沿用原来的布局保存。
   if(mode==='structure'){if(draggedNode){const position=structPositions[draggedNode]??childPositions[draggedNode];if(position)structMoved[draggedNode]={...position}}return}
   markDirtyLayout();return;
  }
  // 单击 = 打开详情；想看关联改双击（或右键菜单）。
  // 注意：pointerdown 里 pushHistory() 会重绘节点，pointerup 的 target 会变成 SVG 而不是节点，
  // 只按 event.target 判断会导致"点了没反应"（实测事件序列：pointerup@(svg)）。
  // 所以这里按坐标命中，和连线落点用同一套办法。
  const under=document.elementFromPoint?.(event.clientX,event.clientY);
  const target=event.target.closest?.('[data-node],[data-edge]')??under?.closest?.('[data-node],[data-edge]');
  if(!target)return;
  if(target.dataset.node){if(mode==='structure')toggleNode(target.dataset.node,{openOnUnsupported:true});else open?.(target.dataset.node)}else if(target.dataset.edge)showEdgeActions(target.dataset.edge)};
 // CV-02 键盘访问：聚焦的节点/连线用 Enter 或空格激活，与点击同一条路径。
 const keydown=event=>{if(event.key!=='Enter'&&event.key!==' ')return;const target=event.target.closest?.('[data-node],[data-edge]');if(!target)return;event.preventDefault();if(target.dataset.node)activate(target.dataset.node);else showEdgeActions(target.dataset.edge)};
 svg.addEventListener('keydown',keydown);
 const wheel=event=>{event.preventDefault?.();const rect=svg.getBoundingClientRect?.()??{left:0,top:0};const x=event.clientX-rect.left,y=event.clientY-rect.top;const next=Math.max(.25,Math.min(2.5,zoom*Math.exp(-event.deltaY*.0015))),ratio=next/zoom;gx=x-(x-gx)*ratio;gy=y-(y-gy)*ratio;setZoom(next)};
 svg.addEventListener('dblclick',event=>{const node=event.target.closest?.('[data-node]');if(!node)return;event.preventDefault();if(mode==='structure')open?.(node.dataset.node);else activate(node.dataset.node)});
 svg.addEventListener('pointerdown',pointerDown);svg.addEventListener('pointermove',pointerMove);svg.addEventListener('pointerup',pointerUp);svg.addEventListener('pointercancel',()=>{drag=null});svg.addEventListener('wheel',wheel,{passive:false});
 // 结构态的画布尺寸会随页面布局（滚动条、容器内边距）变化：宽度一变就重新适配，
 // 否则「加载时算的适配」会停在旧宽度上，窄屏就会出现元素超出右边（实测 390 下右边界 425）。
 const ResizeObserverCtor=document.defaultView?.ResizeObserver;
 const sizeObserver=ResizeObserverCtor?new ResizeObserverCtor(()=>{if(!disposed&&mode==='structure')fit()}):null;
 sizeObserver?.observe(svg);
 // 操作长在画布上（用户 2026-10-12）：缩放与新建放进画布浮动控件，空白处右键/双击也能操作，
 // 顶栏只留"看什么"的筛选，不再堆一排功能按钮。
 (function canvasNative(){
  const stage=document.querySelector('#space .spacestage');
  if(!stage)return;
  const zoomBox=document.createElement('div');
  zoomBox.className='canvaszoom';zoomBox.dataset.canvaszoom='1';
  // 交互律 04：缩放读数是个状态（当前 49%），点它回到 100% —— 这是通用约定，
  // 也让这个数字不再是"只能看不能动"的装饰。
  {const label=document.getElementById('zoomlabel');
   if(label){label.dataset.readout='1';label.style.cursor='pointer';label.title='点一下回到 100%';
    label.onclick=()=>{gx=0;gy=0;setZoom(1);};}}
  for(const id of ['less','zoomlabel','more','fitspace']){
   const node=document.querySelector('#'+id);
   if(node)zoomBox.append(node);
  }
  stage.append(zoomBox);
  // 顶栏已经有「全部关系」下拉，按钮是重复的 → 移进「更多」里当"回到全局视图"。
  const globalButton=document.querySelector('#globalCanvas');
  const morePanel=document.querySelector('[data-morepanel]');
  if(globalButton&&morePanel){globalButton.textContent='回到全局视图';morePanel.append(globalButton)}
  const fab=document.createElement('div');
  fab.className='canvasfab';fab.dataset.canvasfab='1';
  const newButton=document.querySelector('#spacenew');
  if(newButton)fab.append(newButton);
  stage.append(fab);
  // 2026-10-14（用户点名「画布仍然有右键点击的很多多余的功能」）：**两个右键菜单都删掉**。
  // 依据宪章六「克制：新元素必须证明无法被现有元素表达」与 §7「不依赖隐藏手势」：
  //   · 节点原本 7 项 —— 打开详情＝单击、展开关联＝双击、从这里连线＝拖右侧圆点、
  //     编辑/归档/删除＝详情弹窗里的编辑、在画布内预览＝详情已有；「重命名」也只是改标题。
  //   · 空白原本 3 项 —— 新建节点＝画布常驻按钮、全图＝缩放组按钮、关系列表＝「更多」面板已有。
  // 没有一项是别处表达不了的，所以整块去掉；画布上只留看得见、点得到的常驻控件。
  // 空白处双击：直接新建（画布里的直觉动作）
  stage.addEventListener('dblclick',event=>{
   if(event.target.closest?.('[data-node]'))return;
   event.preventDefault();
   document.querySelector('#spacenew')?.click();
  });
  })();
 return {load,refit(){if(svg.getBoundingClientRect().width)fit()},focusNode:focusOn,dispose(){disposed=true;epoch++;document.querySelector('#canvasactionbar')?.remove();document.removeEventListener('keydown',escapeFullscreen);document.removeEventListener('keydown',shortcuts);document.querySelector('#nodemenu')?.remove();svg.removeEventListener('keydown',keydown);if(space)space.classList.remove('expanded-screen');if(stage)stage.style.cssText='';if(fullButton)fullButton.onclick=null;if(focusButton)focusButton.onclick=null;svg.removeEventListener('pointerdown',pointerDown);svg.removeEventListener('pointermove',pointerMove);svg.removeEventListener('pointerup',pointerUp);svg.removeEventListener('wheel',wheel);for(const selector of ['#more','#less','#fitspace','#resetlayout','#allrelations','#aiExplain','#globalCanvas'])wire(selector,null);if(scopeSelect)scopeSelect.onchange=null;if(focusSelect)focusSelect.onchange=null;if(search)search.onkeydown=null;try{sizeObserver?.disconnect()}catch{}modal.invalidate(token)}};
}