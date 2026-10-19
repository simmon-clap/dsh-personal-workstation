// Preserve V7 card markup. Only data output and unknown-state text differ.
import {showEmpty} from './empty-state.mjs';
export const escapeHtml=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
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
 // 统一卡片骨架：不管有没有交付项，四行结构一致 —— 对象/标题/关键标签/指标。
 // 两张卡不再因为数据多少长出不同形状（2026-10-18 走查：一张有日期 chip、一张没有，看着像两套组件）。
 const ringHtml=ring(p.done,p.total,p.color,'mini-ring');
 const tags=priorityTags(p);
 const steps=Array.from({length:5},(_,i)=>`<i style="--pc:${p.color};${i<p.stage?'background:var(--pc)':''}"></i>`).join('');
 return `<button class="project surface" data-project="${escapeHtml(p.id)}"><div class="projecttop"><span class="symbol" style="--pc:${p.color};--pb:${p.bg};color:var(--pc);background:var(--pb)">${icon(p.icon||'project')}</span><span class="chip">${escapeHtml(p.stageLabel||'阶段未设置')}</span>${ringHtml}</div><h3>${escapeHtml(p.name)}</h3><p class="projectpartner">${escapeHtml(p.partner||'合作方未设置')}</p><div class="projecttagline">${tags||'<span class="chip" data-empty="1">优先级未设置</span>'}</div><div class="steps">${steps}</div><div class="projectnumbers"><span><b>${p.total?p.done+'/'+p.total:'尚未设置'}</b> 交付</span><span><b>${p.docs}</b> 资料</span><span><b>${p.block}</b> 阻塞</span></div></button>`;}

export function renderProjectStrip(root,projects,{onCreate}={}){root.innerHTML=projects.map(projectCard).join('');if(!projects.length)showEmpty(root,{illustration:'projects',title:'还没有项目',description:'创建第一个项目后，交付项、任务与资料都会汇总到这里。',action:onCreate?{label:'新建项目',run:onCreate}:undefined});}
