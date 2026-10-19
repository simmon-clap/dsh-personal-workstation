const controllers=new WeakMap();

// One coordinator owns the V7 veil across every detail and editor.
export function sharedModal(document){
 if(controllers.has(document))return controllers.get(document);
 const veil=document.querySelector('#veil'),dialog=veil.querySelector('[role="dialog"]'),closeButton=veil.querySelector('.close');
 const dialogEl=node=>node?.querySelector?.('[role="dialog"]')??null;
 // 返回按钮属于弹窗契约，不只属于外壳：缺失时由弹窗自己补上，
 // 这样任何外壳（含测试用的原型夹具）都有一致的返回入口。
 if(!veil.querySelector('#detailback')){
  const type=veil.querySelector('#detailtype');
  const button=document.createElement('button');
  button.className='back';button.id='detailback';button.type='button';button.setAttribute('aria-label','返回');
  button.innerHTML='<svg class="icon" style="width:16px;height:16px" aria-hidden="true"><use href="#i-arrow"></use></svg><span>返回</span>';
  if(type)type.before(button);else dialog.prepend(button);
 }
 let revision=0,opener=null,guard=null,locked=[],backHandler=null;
 const focusables=()=>[...dialog.querySelectorAll('button,input,select,textarea,a[href],[tabindex]')].filter(e=>!e.disabled&&!e.hidden&&e.tabIndex>=0&&!e.closest('[hidden]'));
 function allowed(){return !guard||guard();}
 function unlock(){for(const [node,inert]of locked)node.inert=inert;locked=[];}
 function close(){if(!allowed())return false;revision++;guard=null;backHandler=null;veil.classList.remove('open');unlock();const target=opener;opener=null;if(target?.isConnected)target.focus();return true;}
 function begin(){if(!allowed())return null;return ++revision;}
 function present(token,{title,type,html,beforeClose,onBack}){
  if(token===null||token!==revision)return false;
  if(!veil.classList.contains('open')){opener=document.activeElement;locked=[...document.body.children].filter(e=>e!==veil&&!e.contains(veil)).map(e=>[e,e.inert]);for(const [e]of locked)e.inert=true;}
  document.querySelector('#detailtitle').textContent=title;document.querySelector('#detailtype').textContent=type;document.querySelector('#detailbody').innerHTML=html;
  // 每次打开都从顶部开始：设置页的门禁判的是"首屏"，不重置滚动位置会让首屏量到上一次的滚动位置。
  const dialog=dialogEl(veil);if(dialog)dialog.scrollTop=0;
  guard=beforeClose||null;backHandler=typeof onBack==='function'?onBack:null;
  const backButton=veil.querySelector('#detailback');
  if(backButton)backButton.hidden=false;
  veil.classList.add('open');closeButton.focus();return true;
 }
 function key(event){if(!veil.classList.contains('open'))return;if(event.key==='Escape'){event.preventDefault();close();}else if(event.key==='Tab'){const elements=focusables(),first=elements[0],last=elements.at(-1);if(!first){event.preventDefault();return;}if(event.shiftKey&&(document.activeElement===first||!dialog.contains(document.activeElement))){event.preventDefault();last.focus();}else if(!event.shiftKey&&(document.activeElement===last||!dialog.contains(document.activeElement))){event.preventDefault();first.focus();}}}
 function focus(event){if(veil.classList.contains('open')&&!dialog.contains(event.target))closeButton.focus();}
 // 返回：有上一级就去上一级（调用方通过 onBack 提供），没有上一级就等同于关闭。
 const backButton=veil.querySelector('#detailback');
 const back=()=>{if(!veil.classList.contains('open')||!allowed())return;const handler=backHandler;if(handler){revision++;guard=null;backHandler=null;veil.classList.remove('open');unlock();const target=opener;opener=null;handler();return}close()};
 if(backButton)backButton.addEventListener('click',back);
 closeButton.addEventListener('click',close);
 // 点弹窗外部（遮罩空白处）应当关闭——这是所有人的第一直觉。
 // 只认「按在遮罩上、且松开也在遮罩上」的点击：避免在弹窗内选中文字、把鼠标拖到外面松开时被误关。
 let pressedOnVeil=false;
 const pointerDown=event=>{pressedOnVeil=event.target===veil};
 const pointerUp=event=>{if(pressedOnVeil&&event.target===veil)close();pressedOnVeil=false};
 veil.addEventListener('pointerdown',pointerDown);
 veil.addEventListener('pointerup',pointerUp);
 document.addEventListener('keydown',key);document.addEventListener('focusin',focus);
 const controller={begin,present,close,current:token=>token!==null&&token===revision,invalidate(token){if(token===revision)revision++;},dispose(){revision++;guard=null;backHandler=null;veil.classList.remove('open');unlock();if(backButton)backButton.removeEventListener('click',back);closeButton.removeEventListener('click',close);veil.removeEventListener('pointerdown',pointerDown);veil.removeEventListener('pointerup',pointerUp);document.removeEventListener('keydown',key);document.removeEventListener('focusin',focus);controllers.delete(document);}};
 controllers.set(document,controller);return controller;
}
