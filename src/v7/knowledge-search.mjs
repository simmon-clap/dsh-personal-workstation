import {sharedModal} from './modal.mjs';
import {escapeHtml as esc} from './project-render.mjs';
import {selectHtml,wireSelects} from './vi-select.mjs';

/** 与旧界面一致的证据引用格式：baseId/docId/chunkId 可加处理修订。 */
export function evidenceRef(hit){
 return 'knowledge:'+encodeURIComponent(hit.baseId)+':'+encodeURIComponent(hit.docId)+':'+encodeURIComponent(hit.chunkId)+(hit.processingRevision?'@'+encodeURIComponent(hit.processingRevision):'');
}
export function evidenceArtifact(hit){return {title:(hit.documentTitle||'知识证据').slice(0,480)+' · 摘录',content:hit.text,description:'知识检索证据当时的副本；原文后续更新不会自动同步。',sourceRefs:[evidenceRef(hit)]}}

/** V7 知识检索：只做词法检索，结果需经批次预览才会成为资料记录。 */
export function createKnowledgeSearch(document,send,batch,{notify=()=>{}}={}){
 const modal=sharedModal(document);let token=null;
 async function open({projectId=''}={}){
  const request=token=modal.begin();if(request===null)return null;
  const [{items:bases},{items:projects}]=await Promise.all([send('knowledge_bases'),send('list',{kind:'project',limit:500})]);
  if(!modal.current(request))return null;
  if(!bases.length){if(!modal.present(request,{title:'知识检索',type:'未授权',html:'<p>还没有给工作台任何知识库。做法：在工作台里打开「设置」，让工作台能查到你需要的知识库。</p>'}))return null;return null}
  const html=`<div class="formrow">${selectHtml({name:'base',attribute:'data-role',label:'知识库',value:bases[0]?.id??'',options:bases.map(base=>[base.id,base.title||base.id])})}</div><label>检索词<input data-role="query" placeholder="例如 评测方法"></label><label>保存摘录时的项目归属${selectHtml({name:'project',attribute:'data-role',label:'归属项目',value:projectId??'',options:[['','未归属项目'],...projects.filter(item=>!item.archived).map(item=>[item.id,item.data.title])],placeholder:'未归属项目'})}</label><div id="knowledgehits"></div><p class="notice">词法检索 · 不调用重排序 · 结果不会自动归档或确认关系；保存摘录会先生成待你确认的改动，进收件箱同意后才写进工作台。</p><div class="modalactions"><button class="btn primary" id="knowsearch">检索</button></div>`;
  if(!modal.present(request,{title:'知识检索',type:'检索',html}))return null;
  const body=document.querySelector('#detailbody'),hitsRoot=body.querySelector('#knowledgehits');
  wireSelects(body,{document});
  const base=body.querySelector('[data-role="base"]'),query=body.querySelector('[data-role="query"]'),project=body.querySelector('[data-role="project"]');
  let sequence=0;
  const invalidate=()=>{sequence++;hitsRoot.replaceChildren()};
  base.onchange=invalidate;query.oninput=invalidate;
  const search=body.querySelector('#knowsearch');
  search.onclick=async()=>{
   const run=++sequence;const text=query.value.trim();if(!text)throw Error('请输入检索词');
   const result=await send('knowledge_search',{baseId:base.value,query:text,topK:10});
   if(!modal.current(request)||run!==sequence)return;
   hitsRoot.replaceChildren();
   for(const hit of result.hits??[]){
    const block=document.createElement('section');block.className='evidence';
    const title=document.createElement('h3');title.textContent=hit.documentTitle||'未命名文档';
    const meta=document.createElement('small');meta.textContent='文档 '+hit.docId+' · 片段 '+hit.chunkId+(hit.heading?' · '+hit.heading:'');
    const pre=document.createElement('pre');pre.style.whiteSpace='pre-wrap';pre.textContent=hit.text;
    const save=document.createElement('button');save.className='btn';save.textContent='保存为资料待确认的改动';
    save.onclick=()=>batch.draft('保存知识证据',[{op:'create',kind:'artifact',data:{...evidenceArtifact(hit),...(project.value?{projectId:project.value}:{})}}]).catch(error=>notify(error.message,true));
    block.append(title,meta,pre,save);hitsRoot.append(block);
   }
   if(!(result.hits??[]).length)hitsRoot.append(Object.assign(document.createElement('p'),{textContent:'没有匹配证据，请尝试其他关键词。'}));
  };
  return {bases};
 }
 return {open,dispose(){modal.invalidate(token)}};
}
