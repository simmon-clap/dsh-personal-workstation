/** 加载态（手册 §08「加载 / 尊重真实进度」）：
 *  · 首次加载用**静态骨架保留布局**，不要让页面先空后跳；
 *  · 超过 1 秒仍未读到资料，显示「正在读取资料」，而不是无限沉默；
 *  · 骨架用真实的卡片类名（.metric/.project/.column），因此网格与高度与真实内容一致。
 *  绝不显示假百分比：这里只表达"正在读"，不猜进度。 */

const SHAPES=[
 {selector:'#metrics',count:4,item:'metric',bars:[[26,10],[54,22],[70,10]]},
 {selector:'#projectstrip',count:4,item:'project surface',bars:[[40,12],[70,18],[90,10],[80,10]]},
 {selector:'#roadmap',count:1,item:'sk-block',bars:[[30,12],[100,10],[100,10],[100,10]]},
 {selector:'#taskmini',count:3,item:'sk-row',bars:[[70,12],[45,10]]},
 {selector:'#projectsbody',count:3,item:'sk-block',bars:[[40,14],[90,10],[70,10]]},
 {selector:'#tasksbody',count:3,item:'column',bars:[[50,12],[100,12],[100,12]]},
 {selector:'#knowbody',count:3,item:'sk-block',bars:[[36,14],[86,10],[64,10]]},
 {selector:'#personalbody',count:3,item:'sk-block',bars:[[36,14],[86,10],[64,10]]}
];
const SLOW_AFTER_MS=1000;

export function createLoading(document,{slowAfter=SLOW_AFTER_MS}={}){
 let timer=null,nodes=[],label=null;
 function clear(){
  if(timer){clearTimeout(timer);timer=null}
  for(const node of nodes)node.remove();
  nodes=[];
  if(label){label.remove();label=null}
 }
 function begin(){
  clear();
  for(const shape of SHAPES){
   const host=document.querySelector(shape.selector);
   if(!host)continue;
   for(let index=0;index<shape.count;index+=1){
    const item=document.createElement('div');
    item.dataset.skeleton='1';
    item.className=shape.item;
    item.setAttribute('aria-hidden','true');
    for(const [width,height]of shape.bars){
     const bar=document.createElement('span');
     bar.className='sk';
     bar.style.cssText=`display:block;width:${width}%;height:${height}px;margin:${height>14?'0 0 8px':'0 0 6px'}`;
     item.append(bar);
    }
    host.append(item);nodes.push(item);
   }
  }
  // 超过 1 秒才出现文案：正常加载不该闪一下「正在读取」。
  timer=setTimeout(()=>{
   if(!nodes.length)return;
   label=document.createElement('p');
   label.id='loadstate';label.className='chip';label.setAttribute('role','status');label.setAttribute('aria-live','polite');
   label.textContent='正在读取资料';
   label.style.cssText='position:fixed;right:18px;bottom:18px;z-index:60';
   document.body.append(label);
  },slowAfter);
 }
 return {begin,clear,get active(){return nodes.length>0}};
}
