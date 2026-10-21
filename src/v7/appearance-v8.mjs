/** 外观控制（Paper Glass）：配色 / 玻璃强度 / 降透明。
 *  只改根元素 data-* 与 localStorage；控件嵌在「设置」页里，不再单独占侧栏入口。 */
const STORE_KEY='ws-appearance-v1';
const read=()=>{try{return JSON.parse(localStorage.getItem(STORE_KEY)||'{}')}catch{return{}}};
const write=next=>{try{localStorage.setItem(STORE_KEY,JSON.stringify(next))}catch{}};
export function applyAppearance(root=document.documentElement,settings={}){
 if(settings.palette)root.dataset.palette=settings.palette;
 if(settings.glass)root.dataset.glass=settings.glass;
 if(settings.accent)root.dataset.accent=settings.accent;
 root.dataset.reducedTransparency=settings.reducedTransparency?'true':'false';
}
const markup=`<details class="settingsappearance" data-settings-appearance="1"><summary>外观 <small>配色 · 玻璃 · 降低透明度</small></summary>
<div class="settingsgrid" data-settings-group="appearance">
 <div class="settingsrow"><span class="name">配色</span><span class="value"><div class="seg" data-as="palette"><button type="button" data-v="vivid">缤纷</button><button type="button" data-v="calm">克制</button></div><em>缤纷更鲜活；克制降低极光与图标饱和度。</em></span></div>
 <div class="settingsrow"><span class="name">玻璃</span><span class="value"><div class="seg" data-as="glass"><button type="button" data-v="ultra">极薄</button><button type="button" data-v="thin">轻薄</button><button type="button" data-v="regular">标准</button><button type="button" data-v="thick">加厚</button><button type="button" data-v="clear">清透</button><button type="button" data-v="bold">强穿透</button></div><em>只影响导航、按钮与浮层；内容卡保持纸面。</em></span></div>
 <div class="settingsrow"><span class="name">强调渐变</span><span class="value"><div class="gradientgrid" data-as="gradient"><button type="button" data-v="aurora" title="aurora"></button><button type="button" data-v="cool" title="cool"></button><button type="button" data-v="warm" title="warm"></button><button type="button" data-v="mint" title="mint"></button><button type="button" data-v="violet" title="violet"></button><button type="button" data-v="sunset" title="sunset"></button><button type="button" data-v="sky" title="sky"></button><button type="button" data-v="gold" title="gold"></button><button type="button" data-v="pink" title="pink"></button><button type="button" data-v="sea" title="sea"></button><button type="button" data-v="glass" title="glass"></button><button type="button" data-v="sheen" title="sheen"></button></div><em>用于主按钮、卡顶线、当前阶段与生成视图顶线。</em></span></div>
 <div class="settingsrow"><span class="name">可读性</span><span class="value"><label class="settingscheck"><input type="checkbox" data-as="reduced"/>降低透明度（关闭玻璃与极光背景）</label><em>系统开启「降低透明度」时自动生效。</em></span></div>
</div></details>`;

export function bindAppearance(root,{notify=()=>{}}={}){
 const initial=read();const state={palette:initial.palette||'vivid',glass:initial.glass||'regular',accent:initial.accent||'cool',reducedTransparency:Boolean(initial.reducedTransparency)};
 applyAppearance(document.documentElement,state);
 const sync=()=>{
  root.querySelectorAll('[data-as="palette"] button').forEach(button=>button.classList.toggle('active',button.dataset.v===state.palette));
  root.querySelectorAll('[data-as="glass"] button').forEach(button=>button.classList.toggle('active',button.dataset.v===state.glass));
  root.querySelectorAll('[data-as="gradient"] button').forEach(button=>button.classList.toggle('active',button.dataset.v===state.accent));
  const reduced=root.querySelector('[data-as="reduced"]');if(reduced)reduced.checked=state.reducedTransparency;
 };
 const set=(patch,label)=>{Object.assign(state,patch);applyAppearance(document.documentElement,state);write(state);sync();notify(label)};
 root.addEventListener('click',event=>{
  const target=event.target.closest('button[data-v]');if(!target)return;
  const group=target.closest('[data-as]')?.dataset.as;
  if(group==='palette')set({palette:target.dataset.v},target.dataset.v==='vivid'?'配色：缤纷':'配色：克制');
  if(group==='glass')set({glass:target.dataset.v},'玻璃：'+target.textContent);
  if(group==='gradient')set({accent:target.dataset.v},'强调渐变：'+target.title);
 });
 const reduced=root.querySelector('[data-as="reduced"]');if(reduced)reduced.onchange=event=>set({reducedTransparency:event.target.checked},event.target.checked?'已降低透明度':'恢复玻璃透明');
 sync();
}
/** 设置弹窗打开时把外观区插到第一个分组之前；只插一次。 */
export function mountAppearanceInSettings(document,{notify=()=>{}}={}){
 applyAppearance(document.documentElement,{palette:read().palette||'vivid',glass:read().glass||'regular',accent:read().accent||'cool',reducedTransparency:Boolean(read().reducedTransparency)});
 const inject=body=>{
  if(!body||!body.querySelector('[data-settings-firstscreen]')||body.querySelector('[data-settings-appearance]'))return;
  const holder=document.createElement('div');holder.innerHTML=markup;
  body.prepend(...holder.children);
  bindAppearance(body,{notify});
 };
 const observer=new MutationObserver(()=>{
  const body=document.querySelector('#detailbody');
  if(body)inject(body);
 });
 observer.observe(document.body,{childList:true,subtree:true});
 return {dispose(){observer.disconnect()}};
}
