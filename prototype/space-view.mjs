import {escapeHtml as esc} from './project-render.mjs';
import {sharedModal} from './modal.mjs';
import {selectHtml,wireSelects} from './vi-select.mjs';
import {renderMarkdown,readerHtml} from './markdown.mjs';
import {downloadFile} from './download.mjs';

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
 project:[viToken('--ws-action-soft'),viToken('--ws-action'),'project'],
 task:[viToken('--ws-success-soft'),viToken('--ws-success'),'task'],
 knowledge:[viToken('--ws-knowledge-soft'),viToken('--ws-knowledge'),'knowledge'],
 memory:[viToken('--ws-knowledge-soft'),viToken('--ws-knowledge'),'knowledge'],
 event:[viToken('--ws-warning-soft'),viToken('--ws-warning'),'calendar'],
 // 组织与联系人：VI §9 明写「联系人/机构灰」。
 // 之前它们被 typeOf 归进了 knowledge —— 于是**资料/议题/组织/联系人全是一个紫色**，
 // 用户 2026-10-16 报的"每个框颜色都一样"就是这个（他说「应该按类别吧，项目、任务、知识、**企业**、日程等等」）。
 org:[viToken('--ws-line'),viToken('--ws-muted'),'cloud'],
});
const kindOrder=['project','task','artifact','topic','memoryRef','judgment','event','organization','person'];
const typeOf=kind=>{
 if(kind==='project'||kind==='task'||kind==='event')return kind;
 if(kind==='memoryRef')return 'memory';
 // 组织与联系人不能并入知识 —— 颜色要按类别分得开（用户 2026-10-16）。
 if(kind==='organization'||kind==='person')return 'org';
 return 'knowledge';
};
const iconOf=kind=>({project:'project',task:'task',artifact:'doc',topic:'knowledge',memoryRef:'knowledge',event:'calendar',organization:'cloud',person:'link',judgment:'knowledge'}[kind]||'knowledge');
// 画布文案必须与原型一致：不把内部枚举直接暴露给用户。
export const statusLabels={todo:'待办',waiting:'等待中',in_progress:'运行中',done:'已完成',cancelled:'已取消'};
export const kindLabels={project:'项目',task:'任务',artifact:'资料',topic:'研究议题',memoryRef:'记忆引用',judgment:'判断',event:'事务',organization:'组织',person:'联系人'};
export function nodeSubtitle(node){
 const kind=kindLabels[node.kind]||node.kind;
 if(node.kind==='project'||node.kind==='task')return `${node.progress?.done??0}/${node.progress?.total??0} 项 · ${statusLabels[node.businessStatus]||node.businessStatus||kind}`;
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
 const base={project:[200,86],task:[156,66],event:[170,74]}[kind]??[170,74];
 const bonus=Math.min(24,Math.max(0,(degree-1))*6);        // 连接加成，封顶 24 —— 不让它膨胀
 return {w:base[0]+bonus,h:base[1]+Math.round(bonus*0.4)};
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
/** Same scope semantics as the prototype: all, cross-project shared objects, or nodes reached by pending suggestions. */
export function scopeNodes(nodes,edges,scope){
 const live=edges.filter(edge=>edge.status!=='rejected');
 if(scope==='suggestions'){const ids=new Set(live.filter(edge=>edge.status==='suggested'||edge.stale).flatMap(edge=>[edge.from,edge.to]));return nodes.filter(node=>ids.has(node.id))}
 if(scope==='shared'){const owners=id=>new Set(live.filter(edge=>edge.derived&&edge.title==='项目归属'&&(edge.from===id||edge.to===id)).map(edge=>edge.from===id?edge.to:edge.from));const hubs=nodes.filter(node=>['artifact','topic','memoryRef','event'].includes(node.kind)&&owners(node.id).size>1).map(node=>node.id);const ids=new Set(hubs);for(const edge of live)if(hubs.includes(edge.from)||hubs.includes(edge.to)){ids.add(edge.from);ids.add(edge.to)}return nodes.filter(node=>ids.has(node.id))}
 return nodes;
}
export function relationData(edge,status){const data={};for(const field of relationFields){const value=field==='status'?status:field==='from'?edge.from:field==='to'?edge.to:edge[field];if(value!==undefined&&value!==null&&value!=='')data[field]=value}return data}
export function visibleEdges(nodes,edges,scope){const ids=new Set(scopeNodes(nodes,edges,scope).map(node=>node.id));return edges.filter(edge=>edge.status!=='rejected'&&ids.has(edge.from)&&ids.has(edge.to))}

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
 const modal=sharedModal(document);let token=null,disposed=false,epoch=0;
 let nodes=[],edges=[],relationList=[],positions={},revision=0,gx=20,gy=20,zoom=1,scope='all',focus='',drag=null,moved=false,pending=null;
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
 function fit(){const rect=svg.getBoundingClientRect(),live=shown();if(!rect.width||!live.length){gx=20;gy=20;zoom=1;transform();return}const xs=live.map(node=>positions[node.id]?.x??0),ys=live.map(node=>positions[node.id]?.y??0);const x=Math.min(...xs),y=Math.min(...ys),w=Math.max(...xs)+200-x,h=Math.max(...ys)+86-y;if(w<=0||h<=0){gx=20;gy=20;zoom=1;transform();return}
  // 默认视图必须可读：46 号审计实测原型自动适配到 44%，节点文字只剩 5.7px（17 §4.6 不成立）。
  // 整张图画得下就居中；画不下也不缩到 44% —— 72% 起，其余靠无限画布平移看。这是对原型的**有意偏离**，已入账。
  const fitted=Math.min(1.1,(rect.width-70)/w,(rect.height-95)/h);
  // 手机（窄画布）保持"全图适配"：390 宽本来就不可能既全览又 12px；手册 §07 允许 <60% 只显示名称+类型。
  const readable=rect.width>=700?0.72:0;
  if(!readable||fitted>=readable){zoom=fitted;gx=(rect.width-w*zoom)/2-x*zoom;gy=(rect.height-h*zoom)/2-y*zoom}
  else{zoom=readable;gx=35-x*zoom;gy=60-y*zoom}
  transform()}
 function draw(){
  svg.replaceChildren();const defs=se('defs'),pattern=se('pattern',{id:'spacegrid',width:24,height:24,patternUnits:'userSpaceOnUse'});pattern.append(se('circle',{cx:1,cy:1,r:.7,fill:viToken('--ws-line')}));defs.append(pattern);svg.append(defs,se('rect',{width:'100%',height:'100%',fill:'url(#spacegrid)'}));
  const world=se('g',{id:'spaceworld'});svg.append(world);
  const hidden=hiddenByGroups(groups);
  const allLive=shown(),live=allLive.filter(node=>!hidden.has(node.id));
  // 尺寸表在 live 之后算一次：分组框、节点、框选三处共用同一份。
  // 踩过两次作用域坑：放分组循环体里 → 循环外拿不到；放 draw 开头 → live 还没初始化。
  const sizes=sizeMap(live,edges);
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
    if(event.target===remove){groups=groups.filter(item=>item.id!==group.id);void saveLayout();draw();return}
    group.collapsed=!group.collapsed;void saveLayout();draw();
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
   const ax=a.x+100,ay=a.y+43,bx=b.x+100,by=b.y+43,d=`M${ax} ${ay} L${bx} ${by}`;
   group.append(se('path',{d,class:'graph-hit'}),se('path',{d,fill:'none',stroke:review?viToken('--ws-warning'):suggested?viToken('--ws-knowledge'):viToken('--ws-line'),'stroke-width':1.6,'stroke-dasharray':dashed?'6 6':'none'}));
   if(showsEdgeLabels(zoom)){
    const mx=(ax+bx)/2,my=(ay+by)/2,label=se('g',{class:'graph-minor graphlabel'});
    const labelText=(sourceLabel?sourceLabel+' · ':'')+(edge.title||'')+(review?' · 待复核':'');const labelWidth=labelText.length*10+16;
    label.append(se('rect',{x:mx-labelWidth/2,y:my-11,width:labelWidth,height:20,rx:7,fill:viToken('--ws-surface')}),se('text',{x:mx,y:my+3,'text-anchor':'middle','font-size':10,fill:review?viToken('--ws-warning'):suggested?viToken('--ws-knowledge'):viToken('--ws-muted')},labelText));
    group.append(label);
   }
   world.append(group);
  }
  for(const node of live){const position=positions[node.id];if(!position)continue;const [bg,colour]=palette()[typeOf(node.kind)];
   const group=se('g',{class:'graphnode','data-selected':selection.has(node.id)?'1':'0',transform:`translate(${position.x} ${position.y})`,tabindex:0,role:'button','data-node':node.id,'aria-label':(node.title||'未命名')+'，点击详情，拖动调整位置'});
   const selected=selection.has(node.id);
   const size=sizes.get(node.id)??nodeSize(node.kind,0);
   group.append(se('rect',{width:size.w,height:size.h,rx:17,fill:selected?viToken('--ws-paper'):viToken('--ws-surface'),stroke:selected?viToken('--ws-action'):colour,'stroke-opacity':selected?'1':'.55','stroke-width':selected?2.2:1}),se('rect',{x:12,y:14,width:29,height:29,rx:9,fill:bg}));
   const glyph=se('svg',{x:18,y:20,width:17,height:17,viewBox:'0 0 24 24',fill:'none',stroke:colour,'stroke-width':1.6,'stroke-linecap':'round','stroke-linejoin':'round'});glyph.append(se('use',{href:'#i-'+iconOf(node.kind)}));group.append(glyph);
   // 手册 §07「对象名称最多两行，全文可展开」：实测长标题会画到卡片外面（最严重超出 41px），
   // 因此按宽度折行、最多两行，超出用省略号；全文放在 <title> 与 aria-label 里。
   const titleLines=wrapNodeTitle(node.title||'未命名',{maxWidth:size.w-51-14});
   const title=se('text',{x:51,y:titleLines.length>1?31:33,'font-size':13,fill:viToken('--ws-ink'),'font-weight':550});
   titleLines.forEach((line,index)=>{title.append(se('tspan',{x:51,dy:index===0?0:14},line))});
   title.append(se('title',{},node.title||'未命名'));
   group.append(title);
   // 项目节点：重要度（左）+ 紧急度（右）各一个色点，悬停给文字；有项目文件夹也写进提示。
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
   const subtitle=nodeDetailAt(node,zoom);
   group.append(se('text',{x:14,y:titleLines.length>1?72:60,'font-size':12,fill:viToken('--ws-muted')},subtitle));
   // 材料类节点就地预览：不打开详情弹窗，直接在画布里看文本/图片/PDF。
   if(['artifact','topic'].includes(node.kind)){
    const preview=se('text',{x:186,y:titleLines.length>1?72:60,'font-size':12,fill:viToken('--ws-action'),class:'nodepreview','text-anchor':'end'});
    preview.textContent='预览';preview.append(se('title',{},'在画布内预览内容（文本 / 图片 / PDF）'));
    preview.addEventListener('click',event=>{event.stopPropagation();void openPreview(node.id)});
    group.append(preview);
   }
   // 手动连线手柄：从这里拖到另一个节点，生成一条由你确认的关系。
   const handle=se('circle',{cx:200,cy:43,r:7,fill:viToken('--ws-surface'),stroke:viToken('--ws-muted'),'stroke-width':1.6,class:'nodehandle'});
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
   world.append(group);
  }
  transform();
  if(status)status.dataset.readout='1';
  if(status)status.textContent=nodes.length?`${selection.size?'已选 '+selection.size+' 个 · ':''}${droppedEdges.length?'已隐藏 '+droppedEdges.length+' 条关联（单个对象最多显示 12 条） · ':''}共 ${nodes.length} 个对象 · ${edges.filter(edge=>edge.status!=='rejected').length} 条关联（单个对象最多显示 12 条） · 当前显示 ${live.length} 个${live.length<nodes.length?'（已按筛选收起）':''}`:'暂无关联对象；创建项目、任务或资料后在此显示。';
 }
 async function load(){
  const run=++epoch;let offset=0,all=[],allEdges=[],allRelationList=[],total=0;
  for(;;){const page=await send('graph',{limit:250,offset});if(disposed||run!==epoch)return;if(!Array.isArray(page?.nodes)||!Array.isArray(page?.edges))throw Error('画布数据响应无效');all=all.concat(page.nodes);allEdges=allEdges.concat(page.edges);allRelationList=allRelationList.concat(page.relations??page.edges.filter(edge=>!edge.derived));total=page.total;if(page.nextOffset===null||page.nextOffset===undefined||all.length>=1000)break;offset=page.nextOffset}
  const layout=await send('layout_get',{view:'space'});if(disposed||run!==epoch)return;
  const saved=layout?.item?.data?.positions??{},ids=new Set(all.map(node=>node.id));
  positions={...spaceLayout(all),...Object.fromEntries(Object.entries(saved).filter(([id])=>ids.has(id)))};
  revision=layout.item?.revision??0;nodes=all;edges=allEdges;relationList=allRelationList;
  groups=(layout.item?.data?.groups??[]).map(group=>({...group,nodeIds:[...group.nodeIds]}));
  selection=new Set([...selection].filter(id=>all.some(node=>node.id===id)));
  setViValue(document,focusSelect,'');
  draw();
  if(layout.item?.data?.viewport&&Number.isFinite(layout.item.data.viewport.zoom)){gx=layout.item.data.viewport.x;gy=layout.item.data.viewport.y;
   // 旧布局里可能存着 44% 的视口：桌面宽度下低于可读线时抬到 72%，避免一打开就是 5.7px 的字。
   const desktop=(svg.getBoundingClientRect().width||0)>=700;
   zoom=desktop?Math.max(0.72,layout.item.data.viewport.zoom):layout.item.data.viewport.zoom;transform()}else fit();
  if(status&&total>all.length)status.textContent+=' · 数据超过画布显示条数，仅显示前 '+all.length+' 个';
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
 function saveLayout(){
  if(pending)return pending;
  const run=++epoch,snapshot={...positions},viewport={x:gx,y:gy,zoom};
  pending=(async()=>{try{await send('layout_save',{view:'space',revision,positions:snapshot,viewport,groups:groups.map(group=>({...group,nodeIds:[...group.nodeIds]})),key:key()});if(!disposed&&run===epoch)revision+=1}catch(error){if(!disposed)notify('画布布局未保存：'+error.message,true)}finally{pending=null}})();
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
 function activate(id){
  const node=nodes.find(item=>item.id===id);if(!node)return;
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
 wire('#more',()=>{setZoom(Math.min(2.5,zoom*1.2));void saveLayout()});
 wire('#less',()=>{setZoom(Math.max(.25,zoom/1.2));void saveLayout()});
 wire('#fitspace',()=>{fit();void saveLayout()});
 wire('#resetlayout',()=>{pushHistory();positions={...spaceLayout(nodes)};draw();fit();void saveLayout()});
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
  group.title=name;void saveLayout();draw();
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
  void saveLayout();draw();syncBar();notify('已创建分组「'+name+'」：'+members.length+' 个对象');
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
 wire('#globalCanvas',()=>{scope='all';focus='';setViValue(document,scopeSelect,'all');setViValue(document,focusSelect,'');draw();fit()});
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
  move('#canvasexportsvg');move('#canvasexportpng');move('#resetlayout');
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
  if(selection.size){selection=new Set();draw();syncBar();return}
  if(expanded())toggleFullscreen();
 };
 if(fullButton)fullButton.onclick=toggleFullscreen;
 if(focusButton)focusButton.onclick=()=>{if(!focus){notify('请先点击节点或选择聚焦项目',true);return}open?.(focus)};
 document.addEventListener('keydown',escapeFullscreen);
 if(scopeSelect)scopeSelect.onchange=()=>{scope=scopeSelect.value;focus='';setViValue(document,focusSelect,'');draw();fit();void saveLayout()};
 if(focusSelect){setViOptions(document,focusSelect,[['','所有项目'],...projects.map(project=>[project.id,project.title])]);focusSelect.onchange=()=>{focus=focusSelect.value;scope='all';setViValue(document,scopeSelect,'all');draw();fit()}}
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
  drag={id:event.pointerId,x:event.clientX,y:event.clientY,gx,gy,nodeId:id,start:positions[id]?{...positions[id]}:null};moved=false;try{svg.setPointerCapture?.(event.pointerId)}catch{/* 节点重绘后指针可能已失效：忽略，不影响点击与拖动 */}};
 const drawMarquee=()=>{const world=svg.querySelector('#spaceworld');if(!world)return;world.querySelector('#marquee')?.remove();if(!marquee)return;
  const rect=se('rect',{id:'marquee',x:Math.min(marquee.x1,marquee.x2),y:Math.min(marquee.y1,marquee.y2),width:Math.abs(marquee.x2-marquee.x1),height:Math.abs(marquee.y2-marquee.y1),fill:viToken('--ws-action'),'fill-opacity':'.08',stroke:viToken('--ws-action'),'stroke-dasharray':'4 4'});
  world.append(rect)};
 const pointerMove=event=>{
  if(link&&event.pointerId===link.id){
   const point=toWorld(event),from=positions[link.from];
   const ghost=svg.querySelector('#linkghost');
   if(ghost&&from)ghost.setAttribute('d',`M${from.x+200} ${from.y+43} L${point.x} ${point.y}`);
   return;
  }
  if(marquee&&event.pointerId===marquee.id){const point=toWorld(event);marquee.x2=point.x;marquee.y2=point.y;moved=true;drawMarquee();return}
  if(!drag||event.pointerId!==drag.id)return;const dx=event.clientX-drag.x,dy=event.clientY-drag.y;if(Math.abs(dx)+Math.abs(dy)>4)moved=true;if(!moved)return;if(drag.nodeId&&drag.start){positions[drag.nodeId]={x:drag.start.x+dx/zoom,y:drag.start.y+dy/zoom};draw()}else{gx=drag.gx+dx;gy=drag.gy+dy;transform()}};
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
  if(!drag)return;const dragged=moved;drag=null;if(dragged){void saveLayout();return}
  // 单击 = 打开详情；想看关联改双击（或右键菜单）。
  // 注意：pointerdown 里 pushHistory() 会重绘节点，pointerup 的 target 会变成 SVG 而不是节点，
  // 只按 event.target 判断会导致"点了没反应"（实测事件序列：pointerup@(svg)）。
  // 所以这里按坐标命中，和连线落点用同一套办法。
  const under=document.elementFromPoint?.(event.clientX,event.clientY);
  const target=event.target.closest?.('[data-node],[data-edge]')??under?.closest?.('[data-node],[data-edge]');
  if(!target)return;
  if(target.dataset.node)open?.(target.dataset.node);else if(target.dataset.edge)edgeDialog(target.dataset.edge)};
 // CV-02 键盘访问：聚焦的节点/连线用 Enter 或空格激活，与点击同一条路径。
 const keydown=event=>{if(event.key!=='Enter'&&event.key!==' ')return;const target=event.target.closest?.('[data-node],[data-edge]');if(!target)return;event.preventDefault();if(target.dataset.node)activate(target.dataset.node);else edgeDialog(target.dataset.edge)};
 svg.addEventListener('keydown',keydown);
 const wheel=event=>{event.preventDefault?.();const rect=svg.getBoundingClientRect?.()??{left:0,top:0};const x=event.clientX-rect.left,y=event.clientY-rect.top;const next=Math.max(.25,Math.min(2.5,zoom*Math.exp(-event.deltaY*.0015))),ratio=next/zoom;gx=x-(x-gx)*ratio;gy=y-(y-gy)*ratio;setZoom(next)};
 svg.addEventListener('dblclick',event=>{const node=event.target.closest?.('[data-node]');if(!node)return;event.preventDefault();activate(node.dataset.node)});
 svg.addEventListener('pointerdown',pointerDown);svg.addEventListener('pointermove',pointerMove);svg.addEventListener('pointerup',pointerUp);svg.addEventListener('pointercancel',()=>{drag=null});svg.addEventListener('wheel',wheel,{passive:false});
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
 return {load,refit(){if(svg.getBoundingClientRect().width)fit()},focusNode:focusOn,dispose(){disposed=true;epoch++;document.removeEventListener('keydown',escapeFullscreen);document.removeEventListener('keydown',shortcuts);document.querySelector('#nodemenu')?.remove();svg.removeEventListener('keydown',keydown);if(space)space.classList.remove('expanded-screen');if(stage)stage.style.cssText='';if(fullButton)fullButton.onclick=null;if(focusButton)focusButton.onclick=null;svg.removeEventListener('pointerdown',pointerDown);svg.removeEventListener('pointermove',pointerMove);svg.removeEventListener('pointerup',pointerUp);svg.removeEventListener('wheel',wheel);for(const selector of ['#more','#less','#fitspace','#resetlayout','#allrelations','#aiExplain','#globalCanvas'])wire(selector,null);if(scopeSelect)scopeSelect.onchange=null;if(focusSelect)focusSelect.onchange=null;if(search)search.onkeydown=null;modal.invalidate(token)}};
}