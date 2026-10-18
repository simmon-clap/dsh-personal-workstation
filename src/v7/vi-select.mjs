/** VI 选择控件：替掉原生 <select>。
 *  原生下拉在 macOS 上呈现为系统控件，与「纸上秩序」的按钮/字段完全不是一套语言；
 *  这里用按钮 + 浮层列表实现，视觉取 VI token，键盘与读屏行为与原生一致。
 *  关键兼容点：仍然输出一个 `[data-field]`/`[data-role]` 的 hidden input，
 *  因此现有取值逻辑（field.value）无需改动。 */

const escapeHtml=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));

/** @param {{name:string,attribute?:string,value?:string,options:Array<[string,string]>,label?:string,placeholder?:string,id?:string}} spec */
export function selectHtml({name,attribute='data-field',value='',options=[],label='',placeholder='请选择',id=''}){
 const current=options.find(([optionValue])=>String(optionValue)===String(value??''));
 const text=current?current[1]:placeholder;
 const attr=attribute+'="'+escapeHtml(name)+'"';
 const listId=id?id+'-list':'viselect-'+name+'-list';
 const items=options.map(([optionValue,title])=>`<button type="button" role="option" class="viselect-option" data-viselect-option="${escapeHtml(optionValue)}" aria-selected="${String(optionValue)===String(value??'')}">${escapeHtml(title)}</button>`).join('');
 return `${label?`<span class="viselect-label">${escapeHtml(label)}</span>`:''}`
  +`<div class="viselect" data-viselect${id?` id="${escapeHtml(id)}"`:''}>`
  +`<button type="button" class="viselect-button" data-viselect-button aria-haspopup="listbox" aria-expanded="false"${listId?` aria-controls="${escapeHtml(listId)}"`:''}><span data-viselect-text>${escapeHtml(text)}</span><svg class="icon" style="width:16px;height:16px" aria-hidden="true"><use href="#i-arrow"></use></svg></button>`
  +`<div class="viselect-list" data-viselect-list id="${escapeHtml(listId)}" role="listbox" hidden>${items}</div>`
  +`<input type="hidden" ${attr} value="${escapeHtml(value??'')}">`
  +'</div>';
}

/** 给容器里所有 VI 选择控件接上交互（点击、键盘、点外部关闭）。 */
export function wireSelects(root,{document:doc=globalThis.document}={}){
 for(const wrapper of root.querySelectorAll('[data-viselect]')){
  if(wrapper.dataset.viselectWired==='1')continue;
  wrapper.dataset.viselectWired='1';
  const button=wrapper.querySelector('[data-viselect-button]');
  const list=wrapper.querySelector('[data-viselect-list]');
  const text=wrapper.querySelector('[data-viselect-text]');
  const input=wrapper.querySelector('input[type="hidden"]');
  const options=[...wrapper.querySelectorAll('[data-viselect-option]')];
  const close=()=>{list.hidden=true;button.setAttribute('aria-expanded','false')};
  const open=()=>{
   list.hidden=false;button.setAttribute('aria-expanded','true');
   const active=options.find(option=>option.getAttribute('aria-selected')==='true')??options[0];
   active?.focus();
  };
  const choose=option=>{
   input.value=option.dataset.viselectOption;
   text.textContent=option.textContent;
   for(const node of options)node.setAttribute('aria-selected',String(node===option));
   close();button.focus();
   input.dispatchEvent(new doc.defaultView.Event('change',{bubbles:true}));
  };
  button.onclick=()=>{if(list.hidden)open();else close()};
  button.onkeydown=event=>{if(event.key==='ArrowDown'||event.key==='Enter'||event.key===' '){event.preventDefault();open()}};
  list.onkeydown=event=>{
   const index=options.indexOf(doc.activeElement);
   if(event.key==='Escape'){event.preventDefault();close();button.focus()}
   else if(event.key==='ArrowDown'){event.preventDefault();(options[index+1]??options[0])?.focus()}
   else if(event.key==='ArrowUp'){event.preventDefault();(options[index-1]??options[options.length-1])?.focus()}
   else if(event.key==='Enter'||event.key===' '){event.preventDefault();if(index>=0)choose(options[index])}
  };
  for(const option of options)option.onclick=()=>choose(option);
  // 点控件外部就收起：与弹窗"点外部关闭"保持同一套直觉。
  wrapper.addEventListener('focusout',()=>{setTimeout(()=>{if(!wrapper.contains(doc.activeElement))close()},0)});
 }
}
