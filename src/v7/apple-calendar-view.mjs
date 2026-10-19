import {escapeHtml as esc} from './project-render.mjs';
import {sharedModal} from './modal.mjs';

/** 苹果日历同步界面：日程与事务页 →「苹果日历同步」（居中弹窗，不用右侧抽屉）。
 *  做三件事：① 显式选日历（默认排除噪音）② 拉取/推送/双向 ③ 从其它日历导入为草稿。
 *  写入只发生在目标日历；导入只生成草稿，交收件箱确认。 */
export function mountAppleCalendar(document,{send,openBatch,notify=()=>{}}){
 const tabs=document.querySelector('#personaltabs');
 if(!tabs||!tabs.parentElement)return {dispose(){}};
 const button=document.createElement('button');
 button.className='btn';button.id='applesync';button.type='button';button.textContent='苹果日历同步';
 tabs.parentElement.append(button);
 const modal=sharedModal(document);
 let disposed=false;
 const state={status:null,selected:new Set(),past:30,future:30,busy:false};

 const checkbox=(name,checked)=>`<label class="applecal"><input type="checkbox" data-cal="${esc(name)}"${checked?' checked':''}><span>${esc(name)}</span></label>`;
 const listHtml=()=>{
  if(!state.status)return '';
  const rows=state.status.calendars.map(item=>checkbox(item.name,state.selected.has(item.name))).join('');
  return `<div class="applegrid">${rows||'<p class="notice">没有读到任何日历。</p>'}</div>`;
 };
 const html=()=>{
  const status=state.status;
  if(!status)return '<p class="notice">正在读取苹果日历…</p>';
  if(!status.available)return `<p class="notice" data-apple-unavailable="1">读不到苹果日历：${esc(status.reason??'未知原因')}<br>苹果日历同步只在 macOS 本机可用；首次使用需要在「系统设置 → 隐私与安全性 → 自动化」里允许 DSH 控制「日历」。</p>`;
  const target=status.target;
  return `<div class="proof" data-apple-status="1"><b>目标日历</b>：${esc(target.name)}${target.exists?'（已存在）':'（首次同步会创建）'}<br><b>时间窗</b>：过去 <input id="applepast" type="number" min="0" max="365" value="${state.past}" style="width:64px"> 天 / 未来 <input id="applefuture" type="number" min="0" max="365" value="${state.future}" style="width:64px"> 天</div>`
   +`<h3>同步哪些日历</h3><p class="notice">只有<b>目标日历</b>会被写入；其它日历只作为读取来源。默认已排除节假日、生日、Siri 建议等噪音日历。</p>${listHtml()}`
   +'<p class="notice" data-apple-hint="1">「双向同步」＝把工作台的事务推到目标日历，并把目标日历里的新建/改动拉回工作台；外部删除<strong>不会</strong>自动删掉工作台记录，会列出来让你决定。</p>'
   +'<div id="appleresult" data-apple-result="1"></div>';
 };
 const actionsHtml=()=>state.status?.available
  ? '<button class="btn primary" id="appleboth">双向同步</button><button class="btn" id="applepush">仅推送</button><button class="btn" id="applepull">仅拉取</button><button class="btn" id="appleimport">从其它日历导入为待确认的改动</button><button class="btn" id="appleclose">关闭</button>'
  : '<button class="btn" id="appleclose">关闭</button>';

 function syncEnabledState(){
  const past=document.querySelector('#detailbody #applepast'),future=document.querySelector('#detailbody #applefuture');
  if(past)past.onchange=()=>{state.past=Math.max(0,Math.min(365,Number(past.value)||0))};
  if(future)future.onchange=()=>{state.future=Math.max(0,Math.min(365,Number(future.value)||0))};
  for(const box of document.querySelectorAll('#detailbody [data-cal]'))box.onchange=()=>{
   if(box.checked)state.selected.add(box.dataset.cal);else state.selected.delete(box.dataset.cal);
  };
 }
 const show=(label,text,bad=false)=>{
  const holder=document.querySelector('#detailbody #appleresult');
  if(holder)holder.innerHTML=`<div class="proof" data-apple-last="${bad?'fail':'ok'}"><b>${esc(label)}</b><br>${esc(text)}</div>`;
 };
 const summaryText=result=>{
  const plan=result.plan??{};
  const parts=[`推送新建 ${plan.pushCreate??0}`, `推送更新 ${plan.pushUpdate??0}`, `拉取新建 ${plan.pullCreate??0}`, `拉取更新 ${plan.pullUpdate??0}`];
  if(plan.conflicts)parts.push(`冲突 ${plan.conflicts}（已按工作台优先并留痕）`);
  if(plan.removedInApple)parts.push(`外部已删除 ${plan.removedInApple}（工作台保留）`);
  if(result.createdCalendar)parts.push('已创建目标日历');
  if(result.errors?.length)parts.push('失败 '+result.errors.length+'：'+result.errors.map(item=>item.reason).join('；'));
  return parts.join(' · ');
 };
 async function run(mode){
  if(state.busy)return;
  state.busy=true;
  show('正在同步…','读取日历并比对，请稍等。');
  try{
   const result=await send('apple_sync',{mode,pastDays:state.past,futureDays:state.future,includeCalendars:[...state.selected],targetCalendar:state.status?.target?.name});
   show(mode==='pull'?'拉取完成':mode==='push'?'推送完成':'双向同步完成',summaryText(result));
   notify('苹果日历同步完成');
   await refresh();
  }catch(error){show('同步失败',error.message,true);notify(error.message,true)}
  finally{state.busy=false}
 }
 async function importDraft(){
  if(state.busy)return;
  state.busy=true;
  show('正在读取其它日历…','');
  try{
   const result=await send('apple_import',{pastDays:state.past,futureDays:state.future,includeCalendars:[...state.selected],targetCalendar:state.status?.target?.name});
   if(!result.draft){show('没有可导入的日程',`扫描了 ${result.scanned??0} 条，都已导入过或不在时间窗内。`);return}
   show('已生成待确认的改动',`${result.imported} 条（${(result.calendars??[]).join('、')}）；去收件箱确认后才会写进工作台。`);
   notify('已生成待确认的导入：'+result.imported+' 条');
   openBatch?.(result.draft.id);
  }catch(error){show('导入失败',error.message,true);notify(error.message,true)}
  finally{state.busy=false}
 }
 async function refresh(){
  try{
   const status=await send('apple_status',{});
   if(disposed)return;
   state.status=status;
   if(!state.selected.size&&Array.isArray(status.calendars))for(const item of status.calendars)if(item.selected)state.selected.add(item.name);
   // 时间窗由配置决定（默认过去/未来各 30 天）；用 floor 显示，避免四舍五入成 31 天。
   state.past=status.window?Math.max(0,Math.floor((Date.now()-Date.parse(status.window.from))/86400000)):state.past;
   state.future=status.window?Math.max(0,Math.floor((Date.parse(status.window.to)-Date.now())/86400000)):state.future;
  }catch(error){state.status={available:false,reason:error.message,calendars:[]}}
 }
 function paint(){
  const request=modal.begin();if(request===null)return;
  const presented=modal.present(request,{title:'苹果日历同步',type:'苹果日历',html:html()+`<div class="modalactions">${actionsHtml()}</div>`});
  if(!presented)return;
  syncEnabledState();
  const wire=(selector,handler)=>{const node=document.querySelector('#detailbody '+selector);if(node)node.onclick=handler};
  wire('#appleclose',()=>modal.close());
  wire('#appleboth',()=>void run('both'));
  wire('#applepush',()=>void run('push'));
  wire('#applepull',()=>void run('pull'));
  wire('#appleimport',()=>void importDraft());
 }
 button.onclick=async()=>{
  if(!state.status)await refresh();
  paint();
 };
 return {
  async open(){if(!state.status)await refresh();paint()},
  dispose(){disposed=true;button.remove()},
 };
}
