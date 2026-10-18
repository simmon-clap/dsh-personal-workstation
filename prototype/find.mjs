import {escapeHtml as esc} from './project-render.mjs';

/** 全类型查找：用户说"找不到会议纪要"——因为知识页默认落在「研究议题」，
 *  而材料在「文件与资料」；类型分页会让人以为东西不存在。
 *  这里在知识页顶部放一个查找框：按名称/路径/正文搜**所有类型**，
 *  命中后直接打开该记录（材料走内嵌阅读），不必先猜它在哪个页签。 */
const kindLabels={project:'项目',task:'任务',artifact:'资料',topic:'议题',event:'事务',memoryRef:'记忆',organization:'组织',person:'联系人',relation:'关联',brief:'简报',layout:'布局',judgment:'判断'};

export function mountFind(document,{send,open,openBatch,notify=()=>{}}){
 const toolbar=document.querySelector('#knowtabs')?.closest('.toolbar');
 if(!toolbar)return {dispose(){}};
 const box=document.createElement('div');
 box.className='findbox';
 box.innerHTML='<input id="findinput" type="search" placeholder="查找：项目、任务、资料、议题、事务…" aria-label="在工作台里查找记录"><span class="findhint">按名称、路径或正文</span>';
 toolbar.append(box);
 // 结果挂在查找框内部：这样下拉相对输入框定位，永远出现在输入框正下方（挂到 toolbar 上会跑到别处）。
 const list=document.createElement('div');
 list.className='findresults';list.id='findresults';list.hidden=true;
 box.append(list);
 const input=box.querySelector('#findinput');
 let items=[],loaded=false,epoch=0,disposed=false;

 let loading=null;
 async function ensure(){
  if(loaded)return;
  // 连续输入时只拉一次：进行中的请求直接复用，避免每敲一个字就全量读一遍。
  if(loading)return loading;
  loading=(async()=>{
   try{const result=await send('list',{limit:200});items=result.items??[];loaded=true}
   catch(error){notify('读取工作台数据失败：'+error.message,true)}
   finally{loading=null}
  })();
  return loading;
 }
 const haystack=item=>[item.data?.title,item.data?.path,item.data?.description,item.data?.goal,item.data?.content].filter(Boolean).join('\n').toLowerCase();
 async function render(query){
  const keyword=query.trim().toLowerCase();
  if(!keyword){list.hidden=true;list.replaceChildren();return}
  const run=++epoch;
  await ensure();
  if(disposed||run!==epoch)return;
  const hits=items.filter(item=>haystack(item).includes(keyword)).slice(0,12);
  list.hidden=false;
  if(!hits.length){
   list.innerHTML='<p class="findempty">没有匹配的记录。资料与会议材料在「文件与资料」页签里；也可以到「关联空间」用节点查找。</p>';
   return;
  }
  list.innerHTML=hits.map(item=>`<button class="findrow" data-find="${esc(item.id)}"><span class="findkind">${esc(kindLabels[item.kind]??item.kind)}</span><span class="findtitle">${esc(item.data?.title??item.id)}</span>${item.archived?'<span class="findarch">已归档</span>':''}</button>`).join('');
  for(const row of list.querySelectorAll('[data-find]'))row.onclick=()=>{
   const item=items.find(entry=>entry.id===row.dataset.find);
   list.hidden=true;input.value='';
   // 资料优先打开内嵌阅读（详情打开后会自动读取文件内容）
   open?.(item.id);
  };
 }
 input.oninput=()=>void render(input.value);
 input.onfocus=()=>void ensure();
 input.onkeydown=event=>{
  if(event.key==='Escape'){list.hidden=true;input.value='';input.blur();return}
  if(event.key==='Enter'){const first=list.querySelector('[data-find]');if(first)first.click()}
 };
 // 点空白处收起结果（不关弹窗）
 const outside=event=>{if(!box.contains(event.target)&&!list.contains(event.target))list.hidden=true};
 document.addEventListener('pointerdown',outside,true);
 const refresh=()=>{loaded=false;ensure()};
 return {refresh,dispose(){disposed=true;document.removeEventListener('pointerdown',outside);box.remove();list.remove()}};
}
