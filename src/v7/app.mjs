import {mountV7} from './v7-controller-v6.mjs';
import {mountAppearanceInSettings} from './appearance-v8.mjs';
import {mountCommandPalette} from './command-palette.mjs';

const post=async(action,data={})=>{
 const response=await fetch('/personal-workstation/api',{method:'POST',headers:{'content-type':'application/json','x-workstation-client':'1'},body:JSON.stringify({...data,action})});
 const value=await response.json().catch(()=>({}));
 if(!response.ok)throw Error(value.message||value.error||'工作台请求失败');
 return value;
};

function notify(text,error=false){
 const toast=document.querySelector('#toast');if(!toast)return;
 toast.textContent=text;toast.classList.toggle('show',Boolean(text));toast.style.background=error?'var(--ws-danger)':'';   // VI §2.3：唯一色值来源是 token，不写字面 rgba
}

// 深色跟随 Host 主题：首屏用 ?theme= 渲染，之后由宿主客户端 postMessage 更新，不重载页面。
function applyTheme(scheme){
 document.documentElement.dataset.theme=scheme==='dark'?'dark':'light';
}
applyTheme(new URLSearchParams(location.search).get('theme')||'light');
globalThis.addEventListener('message',event=>{
 if(event.origin!==location.origin)return;
 const data=event.data;
 if(!data||data.type!=='workstation:theme')return;
 if(data.scheme==='dark'||data.scheme==='light')applyTheme(data.scheme);
});

async function main(){
 const document=globalThis.document;
 let controller=null;
 const show=async workspace=>{
  controller?.dispose();controller=null;
  controller=await mountV7(document,{workspace,fetch:globalThis.fetch,onError:error=>notify(error.message,true),notify:(text,error)=>notify(text,error)});
  notify('');
 };
 try{
  // 工作台不再让用户"选工作区"（用户 2026-10-12）：项目只有一个根目录，业务数据全库一份，
  // 文件按项目文件夹放在根目录下。这里只解析出**根**（取配置里的根目录工作区），不再渲染下拉框。
  const {items=[],root}=await post('workspaces');
  if(!items.length){notify('尚未配置根目录，请先在插件配置里指定。',true);return;}
  const rootWorkspace=(root&&items.find(item=>item.id===root)?.id)??items[0].id;
  window.__dshWorkbenchRoot={id:rootWorkspace,title:(items.find(item=>item.id===rootWorkspace)?.title)??rootWorkspace,path:(items.find(item=>item.id===rootWorkspace)?.path)??''};
  await show(rootWorkspace);
  mountAppearanceInSettings(document,{notify});
  mountCommandPalette(document,{notify});
 }catch(error){notify(error.message,true);}
}
main();
