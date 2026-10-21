// Preserve V7 card markup. Only data output and unknown-state text differ.
import {showEmpty} from './empty-state.mjs';
// 卡片外壳/密度/标题/元信息行只有一处实现（spec/54 §4 · spec/56 §1）。
import {cardOpen,cardClose,cardTitle,cardMetaLine,escapeHtml} from './card.mjs';
export {escapeHtml};
const pct=(a,b)=>b?Math.round(a/b*100):0;
const icon=n=>`<svg class="icon" aria-hidden="true"><use href="#i-${escapeHtml(n)}"/></svg>`;
export function ring(a,b,color='var(--ws-action)',cls='ring'){const p=pct(a,b);return `<svg class="${cls}" viewBox="0 0 80 80" role="img" aria-label="${b?`完成 ${a} / ${b}，${p}%`:'尚未设置交付项'}"><circle cx="40" cy="40" r="30" fill="none" stroke="var(--ring-track,var(--ws-line))" stroke-width="5"/><circle cx="40" cy="40" r="30" fill="none" stroke="${color}" stroke-width="5" stroke-linecap="round" stroke-dasharray="${p*1.885} 188.5" transform="rotate(-90 40 40)"/><text x="40" y="45" text-anchor="middle" font-size="15" font-weight="550" fill="var(--ws-muted)">${b?p+'%':'—'}</text></svg>`;}
export /** 优先级标签：直接把"重要/紧急"写在卡片上（此前只在筛选与排序里体现，卡片上看不到）。
 *  未设置就不显示标签——不用默认值假装用户表达过优先级。逾期单独标出来。 */
function priorityTags(p){
 const level=value=>({high:'高',medium:'中',low:'低'})[value];
 const tags=[];
 if(p.importance)tags.push(`<span class="chip priority" data-priority="importance" data-level="${escapeHtml(p.importance)}">重要 ${level(p.importance)}</span>`);
 if(p.urgency)tags.push(`<span class="chip priority" data-priority="urgency" data-level="${escapeHtml(p.urgency)}">紧急 ${level(p.urgency)}</span>`);
 if(p.lateCount)tags.push(`<span class="chip late" data-late="1">${p.lateCount} 项逾期</span>`);
 if(p.folder)tags.push(`<span class="chip folder" data-folder="1" title="${escapeHtml(p.folder)}">文件夹 ${escapeHtml(p.folder.length>18?p.folder.slice(0,16)+'…':p.folder)}</span>`);
 return tags.join('');
}
export function projectCard(p){
 // 一张卡只表达一次这个项目（spec/54 §3.2 / PJ-01）：阶段、负责人、截止、任务数、真实交付进度
 // 都在这一张卡上；0/0 不画环、不画满宽条（S4），没有交付项就如实写「尚无交付项」，不拿 0% 冒充进度。
 const ringHtml=p.total?ring(p.done,p.total,p.color,'mini-ring'):'';
 const tags=priorityTags(p);
 const owner=p.ownerName?'负责人 '+escapeHtml(p.ownerName):'负责人未设置';
 const due=p.dueDate?'截止 '+escapeHtml(String(p.dueDate).slice(0,10)):'无截止';
 const taskText=p.tasks?p.tasks+' 个任务':'暂无任务';
 return cardOpen({className:'project surface',project:p.id})
  +`<div class="projecttop"><span class="symbol" style="--pc:${p.color};--pb:${p.bg};color:var(--pc);background:var(--pb)">${icon(p.icon||'project')}</span><span class="chip">${escapeHtml(p.stageLabel||'阶段未设置')}</span>${ringHtml}</div>`
  +cardTitle(p.name)
  +`<p class="projectpartner">${escapeHtml(p.partner||'合作方未设置')}</p>`
  +cardMetaLine([owner,due,taskText],{className:'projectmeta'})
  +`<div class="projecttagline">${tags||'<span class="chip" data-empty="1">优先级未设置</span>'}</div><div class="projectnumbers">${p.total?`<span><b>${p.done}/${p.total}</b> 交付</span>`:'<span><b>尚无交付项</b></span>'}<span><b>${p.docs}</b> 资料</span><span><b>${p.block}</b> 阻塞</span></div>`
  +cardClose();}


export function renderProjectStrip(root,projects,{onCreate}={}){root.innerHTML=projects.map(projectCard).join('');if(!projects.length)showEmpty(root,{illustration:'projects',title:'还没有项目',description:'创建第一个项目后，交付项、任务与资料都会汇总到这里。',action:onCreate?{label:'新建项目',run:onCreate}:undefined});}
