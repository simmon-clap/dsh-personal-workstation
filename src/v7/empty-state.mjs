// VI「空白也告诉你下一步」：空态用简笔画 + 一句说明 + 可执行的下一步，不用装饰性内容填满界面。
const base='/personal-workstation/v7/assets/illustrations/';
export const illustrations=['empty','projects','knowledge','waiting','offline','focus','complete','connections'];
/** 生成空态节点。illustration 必须是 VI 提供的简笔画名称。 */
export function emptyState(document,{illustration='empty',title,description='',action}={}){
 if(!illustrations.includes(illustration))throw Error('未知简笔画：'+illustration);
 const box=document.createElement('div');box.className='v7-empty';
 const image=document.createElement('img');image.src=base+illustration+'.svg';image.alt='';image.width=180;image.height=120;
 const heading=document.createElement('h3');heading.textContent=title;
 box.append(image,heading);
 if(description){const note=document.createElement('p');note.textContent=description;box.append(note)}
 if(action){const button=document.createElement('button');button.className='btn';button.textContent=action.label;button.onclick=action.run;box.append(button)}
 return box;
}
/** 把容器内容替换为空态（幂等：容器被外部改写后重新调用即可）。 */
export function showEmpty(container,options){
 container.replaceChildren(emptyState(container.ownerDocument,options));
 return container;
}
