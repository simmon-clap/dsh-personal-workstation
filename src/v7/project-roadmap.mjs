import {escapeHtml} from './project-render.mjs';
import {validDate} from './validation.mjs';
const day=86400000;
function interval(p){if(!validDate(p.startDate)||!validDate(p.dueDate))return null;const a=Date.parse(p.startDate),b=Date.parse(p.dueDate);return a<=b?[Math.floor(a/day),Math.floor(b/day)+1]:null;}
export function projectRoadmap(projects){const ranges=projects.map(interval),valid=ranges.filter(Boolean);const start=valid.length?Math.min(...valid.map(r=>r[0])):null;const span=valid.length?Math.max(6,Math.max(...valid.map(r=>r[1]))-start):6;
 const axes=Array.from({length:6},(_,i)=>start===null?'—':new Date((start+Math.floor(i*span/6))*day).toISOString().slice(5,10).replace('-','.'));
 // 二级时间线：交付项排了日期就画在项目条下方（细条 + 截止三角）；没排期就如实写"未排期"。
 const milestones=p=>{
  const dated=(p.deliverables??[]).filter(item=>validDate(item.dueDate));
  if(!(p.deliverables??[]).length)return '';
  if(!dated.length)return '<span class="axis" data-milestones="none">交付项未排期</span>';
  return `<div class="milestones" data-milestones="1">${dated.map(item=>{
   const at=Math.floor(Date.parse(item.dueDate)/day);
   const left=(at-start)/span*100;
   const done=item.done===true||item.status==='done';
   const late=!done&&at<Math.floor(Date.now()/day);
   return `<button class="milestone" data-deliverable="${escapeHtml(item.id)}" data-done="${done?'1':'0'}"${late?' data-late="1"':''} title="${escapeHtml(item.title)} · ${escapeHtml(item.dueDate)}${late?' · 已逾期':''}" style="left:${Math.max(0,Math.min(96,left))}%">${escapeHtml(item.title.slice(0,8))}</button>`;
  }).join('')}</div>`;
 };
 return `<div class="gantt"><span class="axis" style="text-align:left">项目 / 交付完成</span>${axes.map(x=>`<span class="axis">${x}</span>`).join('')}${projects.map((p,i)=>{const r=ranges[i];return `<button class="name" data-project="${escapeHtml(p.id)}">${escapeHtml(p.name)}<small>${p.total?p.done+'/'+p.total+' 项 · '+Math.round(p.done/p.total*100)+'%':'尚无交付项'}</small></button><div class="lane">${r?`<button class="bar" data-project="${escapeHtml(p.id)}" title="${escapeHtml(p.startDate)} → ${escapeHtml(p.dueDate)}" style="left:${(r[0]-start)/span*100}%;width:${(r[1]-r[0])/span*100}%;--pb:${p.bg};--pc:${p.color};background:var(--pb);color:var(--pc);border:1px solid ${p.color}35"><span class="diamond"></span>${escapeHtml(p.name)} · ${escapeHtml(p.stageLabel)}</button>${milestones(p)}`:'<span class="axis">计划日期未设置或无效</span>'}</div>`}).join('')}</div>`;
}
