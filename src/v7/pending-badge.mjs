/** 待处理提示（用户要求：工作台要能一眼看到有多少待办，且沿用同一套 VI）。
 *  规则：
 *  · 数字必须来自真实数据（收件箱里待确认的批次数），读不到就不显示，不写死、不猜；
 *  · 颜色只用一个（VI 行动色系），且**文字与数字始终在场**，不靠颜色单独承担含义；
 *  · 读屏软件通过 aria-label 听到完整句子，而不是孤零零一个数字。 */

// 收件箱从「知识」页签提到侧栏顶部后，待确认数量跟着挪到那个入口上：
// 徽标必须挂在用户真正处理队列的地方，否则数字会指向一个已经不承载它的页面。
const PLACEMENTS=[
 {scope:'.nav [data-view="inbox"]',label:'收件箱'}
];

export function mountPendingBadge(document,{count}={}){
 let current=count;
 const nodes=[];
 function clear(){
  for(const node of nodes)node.remove();
  nodes.length=0;
  for(const {scope} of PLACEMENTS){
   const host=document.querySelector(scope);
   if(host)host.removeAttribute('aria-label');
  }
 }
 function render(next){if(next!==undefined)current=next;
  clear();
  const total=Number.isFinite(current)&&current>0?Math.floor(current):0;
  if(!total)return {visible:false,count:0};
  for(const {scope,label} of PLACEMENTS){
   const host=document.querySelector(scope);
   if(!host)continue;
   const badge=document.createElement('span');
   badge.className='ws-badge';
   badge.dataset.pendingBadge='1';
   badge.textContent=String(total);
   badge.setAttribute('aria-hidden','true');
   host.append(badge);
   host.setAttribute('aria-label',`${label}，${total} 条待确认`);
   nodes.push(badge);
  }
  const first=document.querySelector('.nav [data-view="knowledge"] .ws-badge');
  if(first)first.title=`${total} 条待确认`;
  return {visible:true,count:total};
 }
 const result=render(current);
 return {render,clear,visible:result.visible,count:result.count};
}
