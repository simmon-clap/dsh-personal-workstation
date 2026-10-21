/** ⌘K 命令面板（Paper Glass 浮层）：只做导航与已有动作，不新造业务。 */
export function mountCommandPalette(document,{notify=()=>{}}={}){
 const nav=[['总览','home','layout'],['收件箱','inbox','inbox'],['关联空间','space','share'],['项目','projects','folder'],['任务','tasks','kanban'],['知识','knowledge','database'],['日程与事务','personal','calendar-days'],['设置','','settings']];
 const veil=document.createElement('div');
 veil.className='cmdk-veil';veil.hidden=true;
 veil.innerHTML=`<div class="cmdk" role="dialog" aria-label="命令面板"><div class="cmdk-search"><svg class="icon" aria-hidden="true"><use href="#i-pg-command"/></svg><input type="search" placeholder="搜索页面或动作…" aria-label="搜索页面或动作"><kbd>Esc</kbd></div><div class="cmdk-list" role="listbox"></div><div class="cmdk-foot">↑↓ 选择 · Enter 打开 · Esc 关闭</div></div>`;
 document.body.append(veil);
 const input=veil.querySelector('input'),list=veil.querySelector('.cmdk-list');
 let commands=[],active=0;
 const build=()=>{
  commands=[...nav.map(([label,view,icon])=>({label,icon,run:()=>{if(view)document.querySelector(`[data-view="${view}"]`)?.click();else document.querySelector('#settings')?.click()}})),{label:'新建项目 / 任务 / 资料',icon:'plus',run:()=>document.querySelector('#create')?.click()},{label:'切换配色（缤纷 / 克制）',icon:'palette',run:()=>{const root=document.documentElement;root.dataset.palette=root.dataset.palette==='calm'?'vivid':'calm';notify(root.dataset.palette==='calm'?'配色：克制':'配色：缤纷')}}];
 };
 const render=()=>{
  const query=input.value.trim().toLowerCase();
  const shown=commands.filter(command=>!query||command.label.toLowerCase().includes(query));
  active=Math.min(active,Math.max(0,shown.length-1));
  list.replaceChildren(...shown.map((command,index)=>{
   const button=document.createElement('button');button.type='button';button.className='cmdk-item'+(index===active?' active':'');button.setAttribute('role','option');button.setAttribute('aria-selected',String(index===active));
   button.innerHTML=`<svg class="icon" aria-hidden="true"><use href="#i-pg-${command.icon}"/></svg><span>${command.label}</span>`;
   button.onclick=()=>run(command);list.append(button);return button;
  }));
  return shown;
 };
 const run=command=>{if(!command)return;close();command.run()};
 const open=()=>{build();veil.hidden=false;input.value='';active=0;render();input.focus()};
 const close=()=>{veil.hidden=true};
 veil.addEventListener('pointerdown',event=>{if(event.target===veil)close()});
 input.addEventListener('input',()=>{active=0;render()});
 input.addEventListener('keydown',event=>{
  const shown=commands.filter(command=>!input.value.trim()||command.label.toLowerCase().includes(input.value.trim().toLowerCase()));
  if(event.key==='ArrowDown'){event.preventDefault();active=Math.min(active+1,shown.length-1);render()}
  else if(event.key==='ArrowUp'){event.preventDefault();active=Math.max(active-1,0);render()}
  else if(event.key==='Enter'){event.preventDefault();run(shown[active])}
  else if(event.key==='Escape'){event.preventDefault();close()}
 });
 document.addEventListener('keydown',event=>{
  if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='k'){event.preventDefault();veil.hidden?open():close()}
  else if(event.key==='Escape'&&!veil.hidden)close();
 });
 return {open,close};
}
