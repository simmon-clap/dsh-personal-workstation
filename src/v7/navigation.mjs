const labels={home:'总览',inbox:'收件箱',space:'关联空间',projects:'项目',tasks:'任务',knowledge:'知识',personal:'日程与事务'};
// W2-3 页面身份：每页一句只属于这一页的提示（页头 = 面包屑 + 一行小字）。
// 不用内部说法；主语是用户能看到的内容，不是实现方式。
export const pageHints={
 home:'项目、任务、日程的关键变化，按真实记录汇总',
 inbox:'AI 提议和你自己录入的改动，先在这里等你决定',
 space:'项目、任务、知识与事务之间的关联视图',
 projects:'按交付项跟踪进度，点项目看细节',
 tasks:'按状态分组，点任务看步骤与截止',
 knowledge:'判断和资料分开存，判断都带依据',
 personal:'日程、待办与事务，来自你的录入与 IM 记录'
};
export function mountNavigation(document,onShow=()=>{}){
 function show(view){if(!Object.hasOwn(labels,view))throw Error('未知工作台页面');
 for(const section of document.querySelectorAll('.view'))section.classList.toggle('active',section.id===view);
 for(const button of document.querySelectorAll('.nav [data-view]')){const active=button.dataset.view===view;button.classList.toggle('active',active);if(active)button.setAttribute('aria-current','page');else button.removeAttribute('aria-current');}
 document.querySelector('#crumb').textContent=labels[view];document.querySelector('#title').textContent=labels[view];
 const hint=document.querySelector('#subtitle');if(hint)hint.textContent=pageHints[view];
 onShow(view);
 }
 const click=event=>{const button=event.target.closest('[data-view],[data-goto]');if(button)show(button.dataset.view||button.dataset.goto);};document.addEventListener('click',click);show('home');return {show,dispose(){document.removeEventListener('click',click)}};
}
