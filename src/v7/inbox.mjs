import {sharedModal} from './modal.mjs';
import {humanTitle} from './human-title.mjs';
import {escapeHtml as esc} from './project-render.mjs';
import {selectHtml,wireSelects} from './vi-select.mjs';
import {filterBarHtml,wireFilterBar} from './project-view.mjs';
import {mountDirectoryBrowser,humanFolderError} from './directory-browser.mjs';

const statusNames={draft:'待确认',committed:'已处理',cancelled:'已取消'};
const opNames={create:'新建',update:'修改',archive:'归档',restore:'恢复',delete:'删除'};
// PRD v1.3 CH-04：收件箱筛选分为待确认、需补充/冲突、已处理、已取消。
const filters=[['pending','待确认'],['blocked','需补充/冲突'],['done','已处理'],['cancelled','已取消'],['','全部']];
// 状态片上的色点用卡片状态点 .statusdot 那一套词（draft/conflict/committed/cancelled）：
// 两处共用同一张 data-state → 变量表，色点颜色来自同一组变量（VI §2 颜色只做辅助）。
// 「全部」不给色点 —— 它不是一个状态，给点就是拿颜色当装饰。
const statusDotStates={pending:'draft',blocked:'conflict',done:'committed',cancelled:'cancelled','':''};
const queryStatus=filter=>filter==='pending'||filter==='blocked'?'draft':filter==='done'?'committed':filter==='cancelled'?'cancelled':undefined;
const previewCap=20;
export const speechPhaseLabels={ready:'本地模型已就绪',standby:'本地模型未准备（首次使用会下载，约 1GB）',preparing:'本地模型下载中',downloading:'本地模型下载中',failed:'本地模型准备失败'};
/** 语音能力：区分「服务已加载」与「模型是否已准备」，避免用户点开麦克风才发现要下载。 */
export function speechLine(c){
 if(!c?.speechToText)return '未接入（需要 DSH 语音输入能力；工作台只做受权读取与调用）';
 const detail=c.speech??{},providers=detail.providers??[];
 if(!providers.length)return '服务已加载，但没有登记任何识别提供方';
 const worst=providers.some(item=>['standby','preparing','downloading','failed'].includes(item.phase))?providers.find(item=>item.phase!=='ready'):providers[0];
 const label=speechPhaseLabels[worst?.phase]??('状态 '+String(worst?.phase??'未知'));
 // 如实说明 Agent 转写是否需要批准：用户不该靠猜，也不该以为"接入了就能随便读音频"。
 const approval=c.speechApprovalRequired===false?'Agent 转写：授权目录内免审批（可在配置中改回）':'Agent 转写：每次需批准一次';
 return '服务已加载 · '+providers.map(item=>item.name??item.id??'未命名').join('、')+' · '+label+' · '+approval;
}
/** 只写实测得到的结论：未知（status 为 null）时不能显示成已接入。 */
/** 工作台观测不到、只能由用户或别的插件确认的事。收进折叠条目：默认不占版面，要追细节时再展开。 */
const unobservable=[
 ['飞书 / Slack 里的助理','账号、白名单与它绑定的对话目录由 IM 助理插件管理；工作台在「接上了什么 → IM 助理 · 飞书」里只读它写在本机的渠道记录与宿主插件清单，读不到就写读不到，不猜。工作台能保证的是：来自 IM 会话的写入会进同一个收件箱。'],
 ['Mini、日历、钉钉这些外部接入','需要你提供地址与身份授权；凭证在 DSH 的插件设置里填（插件管理 → dsh-personal-workstation）。这一页只如实显示"没配置 / 配了但还没接上"，既不假装已连上，也不需要你在这里再填一遍。'],
 ['票据识别','没有可用的识别服务，保持未接入；票据页如实标注，不做假结果。'],
 ['记忆（Mnemon）怎么同步','工作台不直连记忆库：记忆的检索与写入由 DSH 对话里的 Agent 用 Mnemon 工具完成，Agent 再把"这条记忆核对到了什么"记回工作台的「记忆引用」。所以同步与否取决于 Agent 有没有去核对来源，可以在「知识 → 长期记忆」看到还没核对的条数。'],
 ['录音转写怎么用','已接入本机模型。① 在 DSH 对话里直接发录音；② 工作台「文件与资料 → 语音转写」，路径填已授权文件夹里的相对路径（如 inbox/note.m4a）。手机录音的 m4a/opus 会在本机自动转成识别器要的 16 kHz 单声道 WAV。飞书语音消息目前进不来：渠道只处理文字/图片/文件/富文本，请把录音当文件发送。'],
];
/** IM 助理 · 飞书 四层健康面（W1 P0-5）：只显示 IM 插件写在本机的事实 + 宿主插件清单；
 *  读不到就写"读不到"，绝不把"没加载"说成"未配置"，也不报"已连接"（工作台不做实时探测）。 */
const IM_LAYERS={L0:'插件加载',L1:'渠道连接',L2:'会话目录',L3:'发送代码'};
const imRow=(layer,state,value,detail)=>`<div class="settingsrow" data-imlayer="${layer}" data-state="${state}"><span class="name">${IM_LAYERS[layer]}</span><span class="value"><b>${esc(value)}</b>${detail?`<em>${esc(detail)}</em>`:''}</span></div>`;
export function imHealthHtml(health,{heading=true}={}){
 const direct=`<div class="settingsrow" data-directfeishu="1" data-state="off"><span class="name">工作台直连飞书</span><span class="value"><b>未实现发送</b><em>工作台不会往飞书发消息；不需要在这里填凭据</em></span></div>`;
 const head=heading?`<div class="sectionhead"><h2>IM 助理 · 飞书</h2><small>由 IM 助理插件管理；状态只读本机记录</small></div>`:'';
 if(!health||typeof health!=='object'){
  const reason='宿主没有提供 IM 状态；这不等于未加载或未配置';
  return head
   +`<div class="settingsgrid" data-settings-group="im" data-imhealth="1">`
   +['L0','L1','L2','L3'].map(layer=>imRow(layer,'unknown','读不到',reason+'。下一步：在 DSH 设置 → IM 助理 里确认账号还在')).join('')
   +direct+'</div>';
 }
 const plugin=health.plugin??{},channel=health.channel??{},cwd=health.cwd??{},send=health.send??{};
 let L0;
 if(plugin.state==='loaded')L0={state:'ok',value:'已加载',detail:'插件 '+String(plugin.version??'版本未记录')+' 由宿主加载'};
 else if(plugin.state==='incompatible')L0={state:'off',value:'未加载',detail:'与 DSH '+String(plugin.runtimeVersion??'版本未知')+' 不兼容：插件 '+String(plugin.version??'')+' 要求宿主 '+String(plugin.requirementsSummary??'更低的版本')+'。下一步：在 DSH 的插件管理里处理这个插件包（升级 / 停用 / 版本豁免）'};
 else if(plugin.state==='disabled')L0={state:'off',value:'已停用',detail:'下一步：在 DSH 的插件管理里重新启用它'};
 else if(plugin.state==='loading')L0={state:'off',value:'加载中',detail:'稍后再看'};
 else if(plugin.state==='failed')L0={state:'off',value:'加载失败',detail:(plugin.reason?String(plugin.reason)+'。':'')+'下一步：看 DSH 的插件管理里的错误，或重启 DSH 后再看'};
 else if(plugin.state==='not-loaded')L0={state:'off',value:'未加载',detail:'插件已安装但宿主没有把它加载起来。下一步：在 DSH 的插件管理里启用或处理兼容性'};
 else L0={state:'unknown',value:'读不到',detail:String(plugin.reason??'宿主没有提供插件状态')};
 let L1;
 if(channel.state==='no-failure-recorded')L1={state:'ok',value:'最近没有失败记录',detail:'工作台不实时探测连接；真正收消息时才能确认（二级提醒仍按未实现发送降级）'};
 else if(channel.state==='last-failure')L1={state:'off',value:'上次连接失败',detail:(channel.lastError?String(channel.lastError):'原因未记录')+(channel.log?.at?(' · 最近记录 '+String(channel.log.at).slice(0,16).replace('T',' ')):'')+(channel.log?.summary?(' · '+String(channel.log.summary)):'')+'。下一步：'+(channel.log?.code==='21001'||/21001/.test(String(channel.lastError))?'需要飞书管理员在开放平台检查应用状态与安全策略':'在 DSH 设置 → IM 助理 里检查账号与网络')};
 else if(channel.state==='not-attempted')L1={state:'off',value:'未开始',detail:'插件没加载，本轮没有连接尝试。先处理上面「插件加载」这一层'};
 else if(channel.state==='disabled')L1={state:'off',value:'已停用',detail:'下一步：在 DSH 设置 → IM 助理 里重新启用这个账号'};
 else if(channel.state==='no-account')L1={state:'off',value:'没有飞书账号',detail:'下一步：在 DSH 设置 → IM 助理 里添加飞书账号'};
 else L1={state:'unknown',value:'读不到',detail:String(channel.reason??'读不到本机渠道记录')+'。下一步：在 DSH 设置 → IM 助理 里确认账号还在'};
 let L2;
 if(cwd.state==='ok')L2={state:'ok',value:'指向「'+(cwd.expectedTitle??'当前工作区')+'」',detail:'新会话会落到这个工作区'};
 else if(cwd.state==='wrong')L2={state:'off',value:'指向 '+String(cwd.value??'未知目录'),detail:'不是「'+(cwd.expectedTitle??'工作区')+'」。下一步：在 DSH 设置 → IM 助理 → 飞书账号 → 设置里把工作区改为「'+(cwd.expectedTitle??'当前工作区')+'」'};
 else L2={state:'unknown',value:'读不到',detail:String(cwd.reason??'读不到会话目录')};
 const L3={state:'off',value:send.implemented?'已实现':'未实现',detail:send.implemented?'':(String(send.note??'工作台没有往飞书发消息的代码'))+'；不需要你处理'};
 const rows=[L0,L1,L2,L3];
 const firstBad=rows.find(row=>row.state!=='ok');
 const summary=firstBad?('现在坏在「'+IM_LAYERS[['L0','L1','L2','L3'][rows.indexOf(firstBad)]]+'」层：'+firstBad.value):'插件已加载、会话目录正确；工作台不实时探测连接';
 return head
  +`<div class="settingsgrid" data-settings-group="im" data-imhealth="1">`
  +`<div class="settingsrow" data-imsummary="1"><span class="name">现在怎么样</span><span class="value"><b>${esc(summary)}</b></span></div>`
  +rows.map((row,index)=>imRow(['L0','L1','L2','L3'][index],row.state,row.value,row.detail)).join('')
  +direct+'</div>';
}

/** 定时状态的唯一话术（W1 P0-1）：有定时 / 没定时 / 读不到，三态且互斥。 */
export function timerLine(status){
 if(!status||typeof status!=='object')return {main:'读不到定时状态',note:'点「重试」再读一次',state:'unknown'};
 if(status.scheduled===true){
  const minutes=Number(status.intervalMinutes);
  const every=Number.isFinite(minutes)&&minutes>0?('每 '+minutes+' 分钟'):'按设定间隔';
  const last=status.lastSuccessAt?('上次跑成 '+whenText(status.lastSuccessAt)):'还没有跑成过一次';
  const total=Number(status.totalRuns)||0;
  return {main:'已开启 · '+every+'自己醒一次',note:last+' · 一共跑过 '+total+' 次',state:'ok'};
 }
 return {main:'没有开启 · 要你点一下它才会看一眼',note:'在 DSH 设置里把「主动做事」的间隔改成大于 0 的分钟数，它就会自己醒',state:'off'};
}
/** 定时说法矛盾扫描（G-SET-3 的纯函数部分，可被测试/门禁复用）。 */
export function scanTimerContradiction(text){
 const source=String(text??'');
 const negatives=['还没有接入定时','定时与提醒 未接入','定时服务未接入','手动触发；还没有','现在只能手动触发'];
 const positives=['已在定时运行','已在定时运行','定时已接上','已开启定时'];
 const neg=negatives.filter(word=>source.includes(word));
 const pos=positives.filter(word=>source.includes(word));
 return {negatives:neg,positives:pos,pairs:neg.length*pos.length};
}
const whenText=value=>{if(!value)return '时间未记录';const date=new Date(value);return Number.isNaN(date.getTime())?'时间读不出来':date.toLocaleString('zh-CN',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false})};

/** 能力事实：已接上 / 未接上（每项带一句人话与下一步）。界面只用这一份。 */
export function capabilityFacts(c={}){
 const facts=[];
 const fileOk=(c.textFiles?.readGrants??0)>0;
 facts.push({name:'读文件',ok:fileOk,text:fileOk?'可读 '+c.textFiles.readGrants+' 个文件夹、可写 '+c.textFiles.writeGrants+' 个文件夹':'还没有给工作台任何文件夹',next:fileOk?'':'点「管理」选一个文件夹'});
 const kbOk=(c.knowledge?.baseGrants??0)>0;
 facts.push({name:'查知识库',ok:kbOk,text:kbOk?(c.knowledge.baseGrants+' 个知识库'):'还没有给工作台任何知识库',next:kbOk?'':'在 DSH 设置里给工作台加知识库'});
 facts.push({name:'看图片 / PDF',ok:true,text:'浏览器直接渲染，工作台不解析文件内容'});
 facts.push({name:'看 Office 文件',ok:Boolean(c.officePreview),text:c.officePreview?'用宿主自带的转换服务':'宿主没有提供 Office 转换服务',next:c.officePreview?'':'在 DSH 里启用 Office 转换'});
 facts.push({name:'录音转写',ok:Boolean(c.speechToText),text:speechLine(c),next:c.speechToText?'':'在 DSH 里启用语音输入'});
 facts.push({name:'让机器执行任务',ok:Boolean(c.execution),text:c.execution?'可以派任务给执行器':'执行器没接上，只能记录不能执行',next:c.execution?'':'在 DSH 里启用执行器'});
 facts.push({name:'写进苹果日历',ok:Boolean(c.calendarSync),text:c.calendarSync?(c.calendarSyncNote??'本机能力'):'没接上，日历同步不可用',next:c.calendarSync?'':'在系统设置里允许自动化→日历'});
 return facts;
}
/** 设置页骨架：结构先出来（有反应），值由 apply 系列填充。 */
export function settingsHtml(){
 return `<div data-settings-firstscreen="1">`
  +`<div class="sectionhead"><h2>能读写哪些文件夹</h2><small>授权立即生效，不用重启</small></div>`
  +`<div class="settingsgrid" data-settings-group="access">`
  +`<div class="settingsrow" data-settings-row="folders"><span class="name">文件夹</span><span class="value"><b data-settings-cell="folders">正在读取…</b><em data-settings-folders-note></em><button class="btn" type="button" data-settings-manage="grants">管理</button></span></div>`
  +`<div class="settingsrow" data-settings-row="knowledge"><span class="name">知识库</span><span class="value"><b data-settings-cell="knowledge">正在读取…</b><em data-settings-knowledge-note></em></span></div>`
  +`</div>`
  +`<div class="sectionhead"><h2>助理状态</h2></div>`
  +`<div class="settingsgrid" data-settings-group="assistant">`
  +`<div class="settingsrow" data-settings-row="timing" data-timer-fact="1"><span class="name">定时</span><span class="value"><b data-settings-cell="timing">正在读取…</b><em data-settings-timing-note></em></span></div>`
  +`<div class="settingsrow" data-settings-row="caps"><span class="name">已接上</span><span class="value"><b data-settings-cell="caps">正在读取…</b></span></div>`
  +`<details class="settingshelp" data-settings-off="1" hidden><summary>还有 <span data-settings-off-count>0</span> 项没接上</summary><div data-settings-off-list></div></details>`
  +`<div data-settings-slot="integrations"></div>`
  +`<div class="settingsactions"><button class="btn primary" id="settingsheartbeat" data-settings-primary="heartbeat" type="button">让助理现在看一眼</button></div>`
  +`</div></div>`
  +`<div id="grantsbody" hidden></div>`
  +`<div class="settingsmore" data-settings-more="1">`
  +`<details class="settingshelp" data-settings-details="history"><summary>助理替你做过的 <small data-settings-history-count></small></summary><div id="heartbeatbody"><p class="notice">展开时读取…</p></div></details>`
  +`<details class="settingshelp" data-settings-details="about"><summary>关于</summary><div id="aboutbody"><p class="notice">展开时读取…</p></div></details>`
  +`<details class="settingshelp" data-settings-details="help"><summary>要追细节</summary><div id="helpbody">${helpHtml()}</div></details>`
  +`</div>`;
}
const helpHtml=()=>unobservable.map(([name,value])=>`<details class="settingshelp"><summary>${esc(name)}</summary><p>${esc(value)}</p></details>`).join('');

/** 用真实状态填授权/能力区；status 为 null 时写失败态 + 一个重试按钮（不是空白）。 */
export function applySettingsStatus(root,status){
 if(!root)return;
 const doc=root.ownerDocument??root;
 const cell=name=>root.querySelector('[data-settings-cell="'+name+'"]');
 const facts=status?capabilityFacts(status.capabilities??{}):null;
 // 文件夹
 const folders=cell('folders');
 if(folders){
  if(!status){folders.textContent='读不到';}
  else{
   const textFiles=status.capabilities?.textFiles??{};
   const total=(textFiles.readGrants??0);
   folders.textContent=total?(total+' 个（可读写 '+(textFiles.writeGrants??0)+' · 只读 '+Math.max(0,total-(textFiles.writeGrants??0))+'）'):'还没有';
  }
 }
 const foldersNote=root.querySelector('[data-settings-folders-note]');
 if(foldersNote)foldersNote.textContent=status?'':'先确认 DSH 还在运行，再点重试';
 // 知识库
 const knowledge=cell('knowledge'),knowledgeNote=root.querySelector('[data-settings-knowledge-note]');
 if(knowledge){
  if(!status)knowledge.textContent='读不到';
  else knowledge.textContent=(status.capabilities?.knowledge?.baseGrants??0)>0?('已接上 '+status.capabilities.knowledge.baseGrants+' 个'):'还没有';
 }
 if(knowledgeNote)knowledgeNote.textContent=status&&(status.capabilities?.knowledge?.baseGrants??0)>0?'':'还不能查资料——在 DSH 设置里给工作台加知识库';
 // 已接上（只列接上的）
 const caps=cell('caps');
 if(caps){
  if(!status)caps.textContent='读不到';
  else{
   const ok=facts.filter(item=>item.ok).map(item=>item.name);
   caps.textContent=ok.length?ok.join('、'):'暂时没有接上的能力';
  }
 }
 // 未接上折叠
 const off=root.querySelector('[data-settings-off="1"]'),offCount=root.querySelector('[data-settings-off-count]'),offList=root.querySelector('[data-settings-off-list]');
 if(off&&offList){
  const missing=facts?facts.filter(item=>!item.ok):[];
  off.hidden=!status||missing.length===0;
  if(offCount)offCount.textContent=String(missing.length);
  offList.replaceChildren();
  for(const item of missing){
   const row=doc.createElement('div');row.className='settingsrow';row.dataset.settingsOffItem='1';
   const name=doc.createElement('span');name.className='name';name.textContent=item.name;
   const value=doc.createElement('span');value.className='value';
   const state=doc.createElement('b');state.textContent='未接上';
   const detail=doc.createElement('em');detail.textContent=item.text+(item.next?('。下一步：'+item.next):'');
   value.append(state,detail);row.append(name,value);offList.append(row);
  }
 }
 // 失败态重试按钮（每块一个，不重开整页）
 for(const row of root.querySelectorAll('[data-settings-row="folders"],[data-settings-row="knowledge"],[data-settings-row="caps"]')){
  row.querySelectorAll('[data-settings-retry="status"]').forEach(button=>button.remove());
  if(status)continue;
  const retry=doc.createElement('button');retry.type='button';retry.className='btn';retry.dataset.settingsRetry='status';retry.textContent='重试';
  row.querySelector('.value')?.append(retry);
 }
 // 外部接入（飞书由 IM 健康面负责；其余没接上的收进"还有 N 项没接上"）
 if(status){
  const integrations=Object.entries(status.capabilities?.integrations??{}).filter(([name])=>name!=='feishu');
  const off2=root.querySelector('[data-settings-off-list]');
  for(const [name,state] of integrations){
   if(state?.connected)continue;
   const label=({mini:'Mini 私人服务器',calendar:'外部日历',dingtalk:'钉钉',ticket:'票据识别'})[name]??name;
   const row=doc.createElement('div');row.className='settingsrow';row.dataset.settingsOffItem='1';
   const nameNode=doc.createElement('span');nameNode.className='name';nameNode.textContent=label;
   const value=doc.createElement('span');value.className='value';
   const stateNode=doc.createElement('b');stateNode.textContent='未接上';
   const detail=doc.createElement('em');detail.textContent=String(state?.reason??'没配置')+'。下一步：在 DSH 的插件设置里填凭证';
   value.append(stateNode,detail);row.append(nameNode,value);off2?.append(row);
  }
  const offCountNode=root.querySelector('[data-settings-off-count]');
  if(offCountNode&&off2)offCountNode.textContent=String(off2.querySelectorAll('[data-settings-off-item]').length);
  const offNode=root.querySelector('[data-settings-off="1"]');
  if(offNode)offNode.hidden=off2?off2.querySelectorAll('[data-settings-off-item]').length===0:true;
 }
 return root;
}

/** 用 heartbeat_status 的唯一来源填"定时"行；读不到写读不到 + 重试。 */
export function applySettingsTiming(root,payload){
 if(!root)return;
 const doc=root.ownerDocument??root;
 const cell=root.querySelector('[data-settings-cell="timing"]');
 const note=root.querySelector('[data-settings-timing-note]');
 if(!cell)return;
 cell.parentElement?.querySelectorAll('[data-settings-retry="timing"]').forEach(button=>button.remove());
 const line=timerLine(payload?.status??null);
 cell.textContent=line.main;
 if(note)note.textContent=line.note;
 const token=root.querySelector('[data-timer-fact]');
 if(token)token.setAttribute('data-timer-state',line.state);
 if(payload?.status){
  const count=root.querySelector('[data-settings-history-count]');
  if(count)count.textContent='（'+String(payload.status.totalRuns??0)+' 次）';
 }else{
  const retry=doc.createElement('button');retry.type='button';retry.className='btn';retry.dataset.settingsRetry='timing';retry.textContent='重试';
  cell.parentElement?.append(retry);
 }
 return root;
}

/** 关于（版本/数据根/写入审批/设计基线/登录）——展开时才读，不占首屏。 */
export function aboutHtml(status){
 const version=status?`${esc(status.package??'')} ${esc(status.version??'版本未记录')}`:'读不到版本与设计信息';
 const built=status?.build?.builtAt?('界面资源 '+esc(String(status.build.builtAt).slice(0,16).replace('T',' '))):'';
 const restart=status?.build?.needsRestart===true?' · 你正在看的不是最新的一份：已经装了更新的版本，重启 DSH 之后生效':(status?.build?.needsRestart===false?' · 就是你正在用的这一份':'');
 return `<div class="proof" data-about-version>${version}${built?' · '+built:''}${restart}</div>`
  +`<h3>数据放在哪</h3><div class="proof" data-about-root>正在读取…</div>`
  +`<h3>写入审批</h3><div class="proof">AI 提的改动、画布位置：要你点同意才生效。你自己新建、编辑：立刻生效，可以撤销。</div>`
  +`<h3>外观</h3><div class="proof">浅色与深色用同一套颜色和字号；详情都从中间弹出。</div>`
  +`<div class="settingsactions"><button class="btn" type="button" id="settingslogin">在浏览器中登录 DSH</button></div>`;
}

export const sourceName=batch=>{const source=batch.source??{};if(source.undoReceipt)return '来源：撤销上一次改动';if(source.sessionId)return '来源：会话 '+source.sessionId;if(source.operator)return '来源：工作台录入';return '来源：未记录'};
export const isBlocked=preview=>Boolean(preview?.conflicts?.length||preview?.validationErrors?.length);
const kindLabels={project:'项目',task:'任务',artifact:'资料',topic:'研究议题',event:'事务',organization:'组织',person:'联系人',memoryRef:'记忆引用',relation:'关系',brief:'简报',judgment:'判断'};
const audioExtensions=['m4a','mp3','wav','aac','flac','ogg','opus','aiff','aif','caf','amr'];
/** 一次会议往往同时产生录音、纪要、议题与任务——它们本来就是**同一批**（同一来源、同一意图）。
 *  卡片按记录类型把这一批聚合成一行"这次归档都产出了什么"，而不是散成互不相关的条目。
 *  类型判断只用真实数据：kind 是数据，音频按扩展名认（扩展名也是数据），不猜内容。 */
export function batchComposition(item){
 const order=[],counts=new Map(),titles=new Map();
 for(const change of item?.changes??[]){
  const kind=change?.kind??'artifact';
  const label=kind==='artifact'&&audioExtensions.includes(String(change.data?.path??'').toLowerCase().split('.').pop())?'录音':(kindLabels[kind]??kind);
  if(!counts.has(label)){counts.set(label,0);titles.set(label,[]);order.push(label)}
  counts.set(label,counts.get(label)+1);
  const title=change.data?.title;if(title)titles.get(label).push(title);
 }
 return order.map(label=>({label,count:counts.get(label),titles:titles.get(label)}));
}

// 「材料」按体检报告的用法 = 资料记录（会议纪要、录音原件这类 artifact）；
// 研究议题/任务/日程的归属由 Agent 或界面显式写 projectId，不在卡片上自动判归属。
const materialKinds=new Set(['artifact']);
/** 卡片上的归属（体检 A2）：未归属就如实写「未归属」，不假装已归属。
 *  返回 null 表示这批没有材料类变更，不该显示归属行。 */
export function batchLink(item,projects=[]){
 // 同批新建的项目还没进项目清单（要等这批确认后才存在），但标题就在这批变更里：先认它，
 // 否则卡片把新建项目的 id 当名字显示——那正是体检报告里"看起来没挂上"的观感来源之一。
 const created=new Map((item?.changes??[]).filter(change=>change?.op==='create'&&change.kind==='project'&&change.id).map(change=>[change.id,change.data?.title??change.id]));
 const title=id=>created.has(id)?created.get(id)+'（本批新建）':(projects.find(entry=>entry.id===id)?.title||('项目 '+id));
 const rows=(item?.changes??[]).filter(change=>change&&materialKinds.has(change.kind)&&['create','update','restore'].includes(change.op)&&change.data&&typeof change.data==='object');
 if(!rows.length)return null;
 const assigned=rows.filter(change=>typeof change.data.projectId==='string'&&change.data.projectId.trim());
 const ids=[...new Set(assigned.map(change=>change.data.projectId))];
 const parts=[];
 if(ids.length)parts.push(ids.map(title).join('、'));
 if(assigned.length<rows.length)parts.push('未归属');
 return {text:'归属：'+parts.join(' · '),unassigned:rows.length-assigned.length,total:rows.length};
}

/** 共享变更收件箱：人工录入与 DSH 对话写入的是同一批批次与回执。
 *  PRD v1.1 §3 / v1.3 CH-04 要求它作为「知识」页的二级视图，不新增一级导航，因此列表渲染与容器无关。 */
/** W3-C：待核对项进收件箱（来源是判断里的待核对/不确定性，不新造数据）。 */
 export function pendingChecksHtml(checks=[]){
  if(!Array.isArray(checks)||!checks.length)return '';
  return '<section class="surface pad pendingchecks" data-pending-checks="1">'
   +'<div class="sectionhead"><h2>待核对</h2><small>这些判断还欠你一句核对</small></div>'
   +checks.map(check=>`<div class="pendingcheck" role="button" tabindex="0" data-check="${esc(check.judgmentId)}"><h3>${esc(check.title)}</h3>`
    +`<p class="inboxmeta">${esc(check.askWhoLabel||'还没记录找谁核')} · ${esc(check.whyNow||'')}</p>`
    +`<p>问什么：${esc(check.askWhat||'这条判断的依据是否仍然成立？')}</p>`
    +`<p class="formhint">算完成：${esc(check.whatCountsAsDone||'找到一条能确认或推翻它的原始出处')}</p>`
    +`<span class="checkhint">查看这条判断 →</span></div>`).join('')
   +'</section>';
 }
export function createInbox(document,send,batch,{notify=()=>{},openLogin,projects=[],onCommitted=null}={}){
 const modal=sharedModal(document);let token=null,status='pending',project='',source='',op='',openRecord=null;
 let rendered=[];
 // 面板展开态：列表每次重绘都会重建控件，展开态由这里保管，否则选一次状态面板就自己收起来了。
 let panelOpen=false;
 // 共用控件只负责算条数与画选中态，值仍然从这里读（值本身是各页自己的业务）。
 const filterState={get status(){return status},get project(){return project},get kind(){return op},get source(){return source}};
 const projectTitle=id=>projects.find(item=>item.id===id)?.title||id;
 const matches=(item)=>{
  if(op&&!(item.changes??[]).some(change=>change.op===op))return false;
  if(source&&sourceName(item)!==source)return false;
  if(project&&!(item.changes??[]).some(change=>change.id===project||change.data?.projectId===project))return false;
  return true;
 };
 async function decorate(items){
  const drafts=items.filter(item=>item.status==='draft').slice(0,previewCap);
  const previews=new Map(await Promise.all(drafts.map(async item=>{
   try{return [item.id,await send('preview',{id:item.id})]}catch{return [item.id,null]}
  })));
  return items.map(item=>({item,blocked:isBlocked(previews.get(item.id))}));
 }
 /** 空态（VI §6：简笔画 + 一句状态 + 一个下一步）。
  *  真入口复验抓到的：侧栏角标显示 1 条，但「待确认」这一栏是空的 —— 那条其实卡在「需补充/冲突」里。
  *  只写一句"没有待你决定的改动"，用户会以为坏了。这里如实说清楚，并给一个能直接过去的动作。 */
 function emptyMarkup(blockedCount){
  const waiting=blockedCount;
  return `<div class="v7-empty"><img src="/personal-workstation/v7/assets/illustrations/${waiting?'waiting':'empty'}.svg" alt="" width="180" height="120">`
   +`<h3>${waiting?'这一栏没有要你确认的改动':'暂时没有新的改动'}</h3>`
   +`<p>${waiting?`还有 ${waiting} 条卡在「需补充/冲突」——它们缺信息，补齐后才会回到这里。`:'你自己录入或 Agent 整理出来的改动，都会先落到这里等你决定。'}</p>`
   +`<button class="btn" data-inbox="${waiting?'blocked':'all'}">${waiting?'去看那 '+waiting+' 条':'看收件箱全部记录'}</button></div>`;
 }
  function listHtml(rows,total,blockedCount=0,checks=[]){
  const cards=rows.map(({item,blocked})=>{const counts=new Map();for(const change of item.changes??[])counts.set(change.op,(counts.get(change.op)??0)+1);
   const names=(item.changes??[]).slice(0,3).map(change=>change.data?.title||change.id).join('、');
   const state=blocked?'需补充/冲突':(statusNames[item.status]||item.status);
   // 卡片重做：状态点 + 操作图标与计数 + 差异条 + 来源与时间。原来只有一行文字，
   // 用户看不出"这批在等什么、改了什么、从哪来"。
   const stateKey=blocked?'conflict':(item.status==='draft'?'draft':item.status);
   // 徽章原来写成「＋2 新建」：符号与紧随其后的文字标签**说的是同一件事**（VI §2 颜色/符号不单独承担判断）。
   const opOrder=['create','update','archive','restore','delete'].map(op=>[op,'']);
   const ops=opOrder.filter(([op])=>counts.get(op)).map(([op,glyph])=>`<span class="opcount" data-opcount="${op}">${glyph}${counts.get(op)} ${esc(opNames[op])}</span>`).join('');
   const totalChanges=(item.changes??[]).length||1;
   const segments=opOrder.filter(([op])=>counts.get(op)).map(([op])=>`<i data-seg="${op}" style="width:${Math.round(counts.get(op)/totalChanges*100)}%"></i>`).join('');
   const when=item.updatedAt?String(item.updatedAt).slice(5,16).replace('T',' '):'';
   const origin=sourceName(item).replace(/^来源：/,'');
   // 未知的来源不是信息：你没法据此做任何决定，只会让卡上多一行字（用户 2026-10-14：
   // 「信息密，但不是无关信息的多」）。只有真的知道来源时才写这一行。
   const originKnown=Boolean(origin)&&!/^(未记录|未知|无)$/.test(origin.trim());
   // 归属行与一键指定（体检 A2）：材料未归属时明写「未归属」，并给出口。
   // 卡片本身仍是 <button>（点开批次），所以指定控件放在卡片外面的包裹层里——嵌套按钮会被浏览器拆开。
   // 建议（宪章第四条 / VI V3）：四个回应 + 依据 + 不确定性 + 可展开的「为什么这么建议」。
   // 有建议的批次不再显示通用的"同意/不同意"——两种模式并存会让同一件事有两个说法。
   const proposal=item.proposal;
   const decisionLabel={undecided:'还没决定',accepted:'已采纳',rewritten:'已改写',rejected:'已否决'}[proposal?.decision]||'还没决定';
   // VI §8 V3「建议的四种状态」：待你决定 = 左侧工作蓝细线 + **文字**「AI 提议 · 等你决定」。
   // 实测原来**两样都没有**（只有四个按钮），颜色与文字都没承担"这是谁提的、等你做什么"。
   const adviceState=proposal?({undecided:'AI 提议 · 等你决定',accepted:'已采纳',rewritten:'已改写',rejected:'已否决'}[proposal.decision??'undecided']):null;
   const proposalBlock=proposal?`<div class="inboxproposal" data-proposal="1">`
     +`<p class="advicestate" data-advisestate="${esc(proposal.decision??'undecided')}">${esc(adviceState)}</p>`
     +(proposal.evidence?.length
      ?`<div class="inevidence" data-evidence="1"><p class="inboxmeta">依据（${proposal.evidence.length} 条${proposal.evidence.length>3?'，先列 3 条':''}）</p>`
        +proposal.evidence.slice(0,3).map(row=>`<p class="ineitem">· ${esc(row.quote||row.ref||'')}</p>`).join('')
        +`</div>`
      :'<p class="inboxmeta">依据：缺</p>')
     +(proposal.uncertainty?`<p class="uncertainty">不确定性：${esc(proposal.uncertainty)}</p>`:'<p class="inboxmeta">未标不确定性</p>')
     +(proposal.decision&&proposal.decision!=='undecided'?`<p class="inboxmeta" data-decided="1">你的回应：${esc(decisionLabel)}${proposal.reason?' · '+esc(proposal.reason):''}</p>`:'')
     +`<details class="why" data-why="${esc(item.id)}"><summary>为什么这么建议</summary><div class="whychain" data-whychain="${esc(item.id)}">展开后先生成</div></details>`
     +`</div>`:'';
   const adviceActions=proposal?`<div class="inboxadvice" data-advice="${esc(item.id)}">`
     +`<button class="btn primary" data-advice-accept="${esc(item.id)}" type="button">采纳</button>`
     +`<button class="btn" data-advice-rewrite="${esc(item.id)}" type="button">改写</button>`
     +`<button class="btn" data-advice-reject="${esc(item.id)}" type="button">否决</button>`
     +`<button class="btn txt" data-advice-later="${esc(item.id)}" type="button">稍后</button>`
     +`<div class="advisereason" data-advice-row="${esc(item.id)}" hidden><input data-advice-input="${esc(item.id)}" placeholder="一句话就行，比如：优先级不对"><button class="btn" data-advice-send="${esc(item.id)}" type="button">记下</button><button class="btn txt" data-advice-cancel="${esc(item.id)}" type="button">取消</button></div>`
     +`</div>`:'';
   const composition=batchComposition(item);
   // 卡内每一行都用同一种「标签：值」写法（原来 compositionLine 是"资料 2"、linkLine 是"归属：未归属"，
   // 同一张卡里两种写法并存，扫读时对不齐）。
   const compositionLine=composition.length?`<p class="inboxmeta" data-composition="1">包含：${esc(composition.map(part=>part.label+' '+part.count).join(' · '))}</p>`:'';
   const link=batchLink(item,projects);
   const linkLine=link?`<p class="inboxmeta" data-linktext="1">${esc(link.text)}</p>`:'';
   const assign=link&&link.unassigned>0&&item.status==='draft'
    ?`<div class="inboxassign" data-assignrow="1">${projects.length?`<span>指定项目：</span>${selectHtml({name:item.id,attribute:'data-linkpick',value:'',options:[['','选择项目'],...projects.map(entry=>[entry.id,entry.title])],placeholder:'选择项目',id:'inboxpick-'+item.id})}<button class="btn" data-linkassign="${esc(item.id)}">指定</button>`:`<span>${esc(link.text)}（还没有可指定的项目，请先建项目）</span>`}</div>`
    :'';
   // 卡片用 div[role=button]：里面还要放「同意/不同意」两个按钮，<button> 套 <button> 是非法结构
   // （浏览器/jsdom 的解析会把内部按钮挪出去，点击行为随之错乱）。
   return `<div class="inboxitem" data-inboxitem="${esc(item.id)}"><div class="surface resource inboxcard" role="button" tabindex="0" data-batch="${esc(item.id)}"${item.proposal?` data-advice="1" data-decision="${esc(item.proposal.decision??'undecided')}"`:''}><div class="inboxhead"><span class="statusdot" data-state="${esc(stateKey)}" aria-hidden="true"></span><h2>${esc(humanTitle(item.title))}</h2><time>${esc(when)}</time></div><div class="inboxops">${ops}</div>${item.status==='draft'?(item.proposal?adviceActions:`<div class="inboxdecide"><button class="btn primary" data-inboxapprove="${esc(item.id)}" type="button">同意</button><button class="btn" data-inboxreject="${esc(item.id)}" type="button">不同意</button></div>`):''}<div class="diffbar" role="img" aria-label="${esc([...counts].map(([name,count])=>name+' '+count).join('、'))}">${segments}</div><p class="inboxmeta"><span class="stateText">${esc(state)}</span> · 这次要做 ${item.changes?.length??0} 件事</p>${originKnown?`<p class="inboxmeta">来自：${esc(origin)}</p>`:''}${compositionLine}${linkLine}<p class="inboxnames">涉及：${esc(names)}${(item.changes?.length??0)>3?' 等':''}</p>${item.proposal?proposalBlock:''}</div>${assign}</div>`}).join('');
  const note=total>previewCap?`<p class="notice">冲突状态只对最近 ${previewCap} 个待你决定的改动逐一核对，其余仍可打开查看。</p>`:'';
  const options=(list,current)=>list.map(([value,label])=>`<option value="${esc(value)}"${value===current?' selected':''}>${esc(label)}</option>`).join('');
  // PRD v1.3 CH-04：可按项目、来源会话、变更类型筛选。筛选作用于本页已加载批次。
  // 状态片与三个下拉都收进全站唯一的「筛选」面板（VI §6：同一控件全站唯一实现）。
  // 5 个状态片一个都没少，只是不再常驻：手机上正是这一排把页面撑出视口（审计 P2 #23）。
  const filterBar=filterBarHtml({id:'inboxfilters',toggleId:'inboxfiltertoggle',open:panelOpen,chipAttribute:'data-inbox',chipValue:status,
   chips:filters.map(([value,label])=>({value,label,state:statusDotStates[value]})),
   fields:[
    selectHtml({name:'project',attribute:'data-facet',value:project,options:[['','全部项目'],...projects.map(item=>[item.id,item.title])],placeholder:'全部项目',id:'inboxproject'}),
    selectHtml({name:'kind',attribute:'data-facet',value:op,options:[['','全部变更类型'],...Object.entries(opNames)],placeholder:'全部变更类型',id:'inboxkind'}),
    selectHtml({name:'source',attribute:'data-facet',value:source,options:[['','全部来源'],['来源：工作台录入','工作台录入'],['来源：撤销记录编号','撤销记录编号']],placeholder:'全部来源',id:'inboxsource'}),
   ]});
  // 收件箱是**工作队列**，不是知识：在这里把这一点说明白（标签与位置沿用原型与 PRD）。
  const heading=`<div class="sectionhead"><h2>待你决定的改动</h2><small>同意后才写进工作台；不同意就一点都不改</small></div>`;
  const statsBlock=`<details class="proposalstats" data-proposalstats="1"><summary>最近的建议你采纳了多少</summary><div data-statsbody="1">展开后先生成</div></details>`;
  return heading+statsBlock+filterBar+`<p class="notice">材料入库和项目修改都会汇总成一条改动，等你同意；来源与项目筛选只影响当前列表。</p>${pendingChecksHtml(checks)}${note}<div class="resourcegrid" data-inboxgrid="1">${cards||emptyMarkup(blockedCount)}</div>`;
 }
 function wireList(root){
  wireSelects(root,{document});
  // 整张待核对卡就是入口：里面的数字/状态因此都能「点回原因」（charter-ux C7/D8），
  // 也不再出现同屏三个同名按钮（C7 重复动作）。
  for(const node of root.querySelectorAll('[data-check]')){
   const open=()=>{if(openRecord)openRecord(node.dataset.check);else notify('这条判断的详情还没接上，请刷新后再试')};
   node.onclick=open;
   node.onkeydown=event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();open()}};
  }
  // 「为什么这么建议」：用 basedOn 取数；取不到就自曝是通用建议（宪章第四条硬约束 2）。
  for(const node of root.querySelectorAll('[data-why]')){
   node.addEventListener('toggle',async()=>{
    if(!node.open)return;
    const id=node.dataset.why,target=root.querySelector('[data-whychain="'+id+'"]');
    if(!target||target.dataset.filled==='1')return;
    const row=rendered.find(entry=>entry.item.id===id);
    const basedOn=row?.item?.proposal?.basedOn??[];
    if(!basedOn.length){target.textContent='这条没有你既有判断作支撑，是通用建议 —— 不代表你过去的判断。';target.dataset.filled='1';return}
    const lines=[];
    for(const judgmentId of basedOn.slice(0,5)){
     try{const result=await send('get',{id:judgmentId});lines.push({id:judgmentId,title:result?.item?.data?.title||judgmentId})}catch{lines.push({id:judgmentId,title:'（这条判断读取不到）'})}
    }
    target.innerHTML='参考了你的这几条判断：<br>'+lines.map(line=>`<button class="btn txt" type="button" data-why-open="${esc(line.id)}">${esc(String(line.title))}</button>`).join('<br>')+'<br><span class="inboxmeta">这些都是你自己的判断，点开可以改；改了它，这条建议的推理也会跟着变。</span>';
    for(const button of target.querySelectorAll('[data-why-open]'))button.onclick=event=>{event.stopPropagation();if(openRecord)openRecord(button.dataset.whyOpen)};
    target.dataset.filled='1';
   });
  }
  // 采纳情况：只在展开时取一次（不常驻、不推送）
  const stats=root.querySelector('[data-proposalstats]');
  if(stats)stats.addEventListener('toggle',async()=>{
   if(!stats.open)return;
   const body=root.querySelector('[data-statsbody="1"]');
   if(!body||body.dataset.filled==='1')return;
   try{
    const {items,stats}=await send('proposal_history',{limit:20});
    const tally=stats?.current??null;
    if(!items.length||!tally||!tally.total){body.textContent='还没有回应过的建议。'}
    else{
     const trend=stats.deltaPoints===null?'':`；采纳率 ${tally.rate}%（比之前 ${stats.deltaPoints>=0?'+':''}${stats.deltaPoints} 个百分点）`;
     body.textContent=`最近 ${tally.total} 条建议：采纳 ${tally.accepted} · 改写 ${tally.rewritten} · 否决 ${tally.rejected}${trend}`;
    }
   }catch(error){body.textContent=error.message}
   body.dataset.filled='1';
  });
  // 四个回应：采纳 / 改写 / 否决 / 稍后
  const reveal=(id,show)=>{
   const row=root.querySelector('[data-advice-row="'+id+'"]');
   if(row)row.hidden=!show;
   const input=root.querySelector('[data-advice-input="'+id+'"]');
   if(show&&input)input.focus();
  };
  const record=async(id,decision,reason)=>{
   const current=await send('preview',{id});
   return send('draft',{id,revision:current.revision,title:current.title,changes:current.changes,proposal:{...(current.proposal??{}),decision,reason,decidedAt:new Date().toISOString()}});
  };
  for(const node of root.querySelectorAll('[data-advice-reject],[data-advice-rewrite]'))node.onclick=event=>{
   event?.stopPropagation?.();
   // 改写与否决共用同一行输入，必须记住这次是哪种，否则会把改写记成否决
   const id=node.dataset.adviceReject??node.dataset.adviceRewrite;
   const kind=node.dataset.adviceReject?'rejected':'rewritten';
   const row=root.querySelector('[data-advice-row="'+id+'"]');
   if(row)row.dataset.decisionKind=kind;
   const input=root.querySelector('[data-advice-input="'+id+'"]');
   if(input)input.placeholder=kind==='rejected'?'一句话就行，比如：优先级不对':'写清你要改什么';
   reveal(id,true);
  };
  for(const node of root.querySelectorAll('[data-advice-cancel]'))node.onclick=event=>{event?.stopPropagation?.();reveal(node.dataset.adviceCancel,false)};
  for(const node of root.querySelectorAll('[data-advice-later]'))node.onclick=event=>{
   event?.stopPropagation?.();
   notify('留在这里，稍后再看 —— 什么都没改');
  };
  for(const node of root.querySelectorAll('[data-advice-accept]'))node.onclick=async event=>{
   event?.stopPropagation?.();
   const id=node.dataset.adviceAccept;
   node.disabled=true;
   try{
    const updated=await record(id,'accepted','');
    await send('commit',{id,revision:updated.revision,key:'advice:'+id+':'+updated.revision});
    notify('已采纳，写进工作台；左下可撤销');
    await render(root);
   }catch(error){notify(error.message,true);if(node.isConnected)node.disabled=false}
  };
  for(const node of root.querySelectorAll('[data-advice-send]'))node.onclick=async event=>{
   event?.stopPropagation?.();
   const id=node.dataset.adviceSend;
   const row=root.querySelector('[data-advice-row="'+id+'"]');
   const decision=row?.dataset.decisionKind??'rejected';
   const input=root.querySelector('[data-advice-input="'+id+'"]');
   const reason=(input?.value??'').trim();
   if(!reason){notify(decision==='rejected'?'否决要留一句理由：写清为什么不同意':'改写要留一句理由：写清改了什么',true);return}
   node.disabled=true;
   try{
    const updated=await record(id,decision,reason);
    if(decision==='rejected'){
     await send('cancel_draft',{id,revision:updated.revision});
     // 留在原位：卡片转灰、显示你的理由，不刷新、不消失（VI V3）
     const card=node.closest('[data-inboxitem]');
     if(card){
      card.classList.add('rejected');
      const actions=card.querySelector('[data-advice]');
      if(actions)actions.outerHTML=`<p class="inboxmeta" data-rejected="1">已否决 · 你的理由：${esc(reason)} · 不再推荐（除非有新证据）</p>`;
     }
     notify('已否决：数据一点没改，理由已记下');
    }else{
     notify('已记下你要改的地方，接下来在详情里改内容');
     if(typeof batch?.open==='function')await batch.open(id);else await render(root);
    }
   }catch(error){notify(error.message,true)}finally{if(node.isConnected)node.disabled=false}
  };
  for(const node of root.querySelectorAll('[data-inbox]'))node.onclick=()=>render(root,node.dataset.inbox).catch(error=>notify(error.message,true));
  // 「筛选」控件接线（全站唯一实现）：展开 / 收起、按钮上写出生效条数、状态片的选中态。
  // 状态、项目、变更类型、来源各算一条；「全部」（空值）是默认，不算。默认筛的就是「待确认」，
  // 所以一进来按钮上写着「筛选 · 1」—— 这份列表本来就是被筛过的，不许装作没筛。
  wireFilterBar(root,{id:'inboxfilters',toggleId:'inboxfiltertoggle',state:filterState,counted:['status','project','kind','source'],defaults:{status:'',project:'',kind:'',source:''},chips:{attribute:'data-inbox',key:'status'},onToggle:open=>{panelOpen=open}});
  for(const node of root.querySelectorAll('[data-face]'))node.onclick=()=>{op=node.dataset.face;render(root).catch(error=>notify(error.message,true))};
  for(const node of root.querySelectorAll('[data-op]'))node.onclick=()=>{op=node.dataset.op;render(root).catch(error=>notify(error.message,true))};
  for(const select of root.querySelectorAll('[data-facet]'))select.onchange=()=>{if(select.dataset.facet==='project')project=select.value;if(select.dataset.facet==='kind')op=select.value;if(select.dataset.facet==='source')source=select.value;render(root).catch(error=>notify(error.message,true))};
  for(const node of root.querySelectorAll('[data-batch]')){
   node.onclick=()=>inspect(node.dataset.batch).catch(error=>notify(error.message,true));
   node.onkeydown=event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();node.click()}};
  }
  // 列表上直接决定：同意（整批提交，有回执、可撤销）/ 不同意（取消，数据一点没改）。
  // 想看细节再点卡片——两条路都通，不用先打开再找按钮。
  for(const node of root.querySelectorAll('[data-inboxapprove]'))node.onclick=async event=>{
   event?.stopPropagation?.();
   const id=node.dataset.inboxapprove;
   try{
    const batch=await send('preview',{id});
    const receipt=await send('commit',{id,revision:batch.revision,key:'ui:'+id+':'+batch.revision});
    notify('已同意 '+batch.changes.length+' 项改动，已写进工作台');
    onCommitted?.(receipt);
    await render(root);
   }catch(error){notify(error.message,true)}
  };
  for(const node of root.querySelectorAll('[data-inboxreject]'))node.onclick=async event=>{
   event?.stopPropagation?.();
   const id=node.dataset.inboxreject;
   try{
    const batch=await send('preview',{id});
    await send('cancel_draft',{id,revision:batch.revision});
    notify('已全部不同意：数据一点没改');
    await render(root);
   }catch(error){notify(error.message,true)}
  };
  // 一键指定归属：把本批仍未归属的材料挂到选定项目上（走同一批草稿的修订，不绕过批次）。
  for(const node of root.querySelectorAll('[data-linkassign]'))node.onclick=event=>{
   if(event?.stopPropagation)event.stopPropagation();
   const id=node.dataset.linkassign,picked=root.querySelector('[data-linkpick="'+id+'"]'),projectId=picked?.value??'';
   if(!projectId)return notify('请先选择要归属的项目，再点「指定」',true);
   assign(root,id,projectId).catch(error=>notify(error.message,true));
  };
 }
 /** 一键指定：修订同一批草稿（revision+1），把未归属的材料指向该项目；提交前仍可再改或改回未归属。 */
 async function assign(root,id,projectId){
  const row=rendered.find(entry=>entry.item.id===id);
  if(!row)throw Error('收件箱已刷新，请重新打开后再指定');
  const item=row.item;
  if(item.status!=='draft')throw Error('只有待确认的改动能改归属');
  const changes=item.changes.map(change=>{
   if(!change||!materialKinds.has(change.kind)||!['create','update','restore'].includes(change.op))return change;
   if(!change.data||typeof change.data!=='object')return change;
   if(typeof change.data.projectId==='string'&&change.data.projectId.trim())return change;
   return {...change,data:{...change.data,projectId},sources:{...(change.sources??{}),projectId:'用户在收件箱指定'}};
  });
  await send('draft',{id:item.id,revision:item.revision,title:item.title,changes});
  notify('已把未归属的材料指定到该项目；同意前仍可在预览里改回未归属');
  if(root?.isConnected)await render(root);
 }
 /** 渲染到任意容器：知识页的「材料与变更」二级视图与设置入口共用同一份实现。 */
 async function render(root,next=status){
  status=next;
  const {items}=await send('inbox',{status:queryStatus(status),limit:50});
  let checks=[];
  try{const result=await send('pending_checks',{limit:3});checks=Array.isArray(result?.items)?result.items:[]}catch{checks=[]}
  const decorated=(await decorate(items)).filter(row=>matches(row.item));
  const rows=status==='pending'?decorated.filter(row=>!row.blocked):status==='blocked'?decorated.filter(row=>row.blocked):decorated;
  rendered=rows;
  if(!root?.isConnected)return rows;
  root.innerHTML=listHtml(rows,items.length,decorated.filter(row=>row.blocked).length,checks);wireList(root);
  return rows;
 }
 // 接入状态：只呈现工作台自己观测得到的结论；观测不到的一律交给用户确认，不猜。
 async function openSettings(){
  const request=token=modal.begin();if(request===null)return null;
  if(!modal.present(request,{title:'设置',type:'工作台',html:settingsHtml()}))return null;
  const body=document.querySelector('#detailbody');
  const dialog=document.querySelector('#veil [role="dialog"]');
  if(dialog)dialog.scrollTop=0;   // 每次打开都从顶部开始（"首屏"判定才成立）
  let status=null,timingPayload=null;
  const loadStatus=async()=>{
   try{status=await send('runtime_status')}catch{status=null}
   if(!modal.current(request))return;
   applySettingsStatus(body,status);
  };
  const loadTiming=async()=>{
   try{timingPayload=await send('heartbeat_status')}catch{timingPayload=null}
   if(!modal.current(request))return;
   applySettingsTiming(body,timingPayload);
  };
  // 失败只重拉这一块，不是整页重开（G-SET-7）。
  body.addEventListener('click',event=>{
   const target=event.target?.closest?.('[data-settings-retry]');
   if(!target)return;
   if(target.dataset.settingsRetry==='status')void loadStatus();
   else if(target.dataset.settingsRetry==='timing')void loadTiming();
  });

  // 授权管理：点「管理」就地展开，不换页；展开时才读目录（首屏不为它付高度）。
  const grantsBody=body.querySelector('#grantsbody');
  let grantsMounted=false;
  let mountGrants=null;
  const manageButton=body.querySelector('[data-settings-manage="grants"]');
  if(manageButton&&grantsBody)manageButton.onclick=async()=>{
   grantsBody.hidden=!grantsBody.hidden;
   manageButton.setAttribute('aria-expanded',String(!grantsBody.hidden));
   if(grantsBody.hidden)return;
   if(!grantsMounted){grantsMounted=true;await mountGrants?.()}
  };

  // 「助理替你做过的」：留痕、额度、四个回应都在这里；展开时才渲染，且不重复定时状态。
  const history=body.querySelector('[data-settings-details="history"]');
  const heartbeatBody=body.querySelector('#heartbeatbody');
  const when=whenText;
  const renderHeartbeat=async()=>{
   if(!heartbeatBody)return;
   if(!timingPayload)await loadTiming();
   const data=timingPayload;
   let speak=null;
   try{speak=await send('speak_status')}catch{/* 出声状态读不到不影响看留痕 */}
   if(!modal.current(request))return;
   heartbeatBody.replaceChildren();
   const line=text=>heartbeatBody.append(Object.assign(document.createElement('p'),{className:'noticeline',textContent:text}));
   const statusData=data?.status??null;
   const timer=timerLine(statusData);
   line('定时：'+timer.main+(statusData?.note?'（'+statusData.note+'）':''));
   if(statusData){
    line('上次跑成：'+when(statusData.lastSuccessAt)+' · 一共跑过 '+(statusData.totalRuns??0)+' 次');
    if(statusData.scheduled&&typeof statusData.silentHours==='number')line('距上次跑成已经 '+statusData.silentHours+' 小时。');
    if(statusData.alert){
     const alert=document.createElement('p');alert.className='notice';alert.dataset.heartbeatAlert='1';
     alert.textContent='要看一下：'+statusData.alert.reason+'（从 '+when(statusData.alert.since)+' 起）'+(statusData.alert.detail?.length?'：'+statusData.alert.detail.join('；'):'');
     heartbeatBody.append(alert);
    }
   }else line('读不到主动做事的记录：稍后展开重试。');
   const latest=data?.latest;
   if(!latest){line('还没有跑过。点上面的「让助理现在看一眼」就跑一次，跑完这里会写清它看到什么、为什么没打扰你。');return}
   const list=(label,items,key)=>line(label+'（'+items.length+'）：'+(items.length?items.slice(0,6).map(item=>item.title?item.title+(item[key]?' → '+item[key]:''):(item.what??'')).join('；'):'没有'));
   if(latest.looked?.length)list('这次看了',latest.looked,'count');
   const speakState=speak?.state??null;
   if(speakState){
    line('出声额度 '+speakState.budget+'（'+speakState.stage+'）· 这周最多打断 '+speakState.weeklySecondaryLimit+' 次 · 免打扰 '+speakState.quietWindow.note+(speakState.quietWindow.active?'（现在是免打扰时段）':''));
    const shifts=Object.keys(speakState.thresholdShifts);
    line('说多了 '+speakState.metering.tooMuchRate+'% · 该说没说 '+speakState.metering.missed+' 次'+(shifts.length?'（'+shifts.join('、')+' 的门槛已放宽一档）':''));
   }
   if(latest.candidates?.length){
    line('值得找你的（'+latest.candidates.length+'）');
    const spoken=latest.spoken??[];
    for(const candidate of latest.candidates.slice(0,6)){
     const said=spoken.find(item=>item.subjectId===candidate.subjectId&&item.rule===candidate.rule);
     const levelLabel=said?.delivery==='feishu'?'会打断你':(said?.degraded?'排在最前（本该打断，但发送方式还没核实）':'排在最前');
     const row=document.createElement('div');row.className='noticeline';
     // 主动提醒必须能「点回」到那条判断（C7 ④）：标题做成按钮，点开就是判断详情。
     if(candidate.subjectId){
      const open=document.createElement('button');open.type='button';open.className='btn txt';open.textContent=candidate.title??candidate.what??'打开';
      open.onclick=()=>{if(openRecord)openRecord(candidate.subjectId)};
      row.append(open);
     }else row.append(document.createTextNode(candidate.title??candidate.what??''));
     row.append(document.createTextNode(' → '+(said?.why??candidate.why??'')+'（'+levelLabel+'）'));
     const actions=document.createElement('div');actions.className='modalactions';
     for(const [kind,label] of [['followed','照做了'],['noted','知道了'],['unnecessary','没必要'],['ignored','忽略']]){
      const button=document.createElement('button');button.className='btn';button.dataset.speakFeedback=kind;
      button.textContent=label;
      button.onclick=()=>send('speak_feedback',{feedback:kind,subjectId:candidate.subjectId,condition:candidate.rule})
       .then(()=>{notify('记下了：'+label);return renderHeartbeat()}).catch(error=>notify(error.message,true));
      actions.append(button);
     }
     heartbeatBody.append(row,actions);
    }
   }
   if(latest.silenced?.length)list('没打扰你的原因',latest.silenced,'why');
   if(latest.errors?.length)line('这次没跑成的部分：'+latest.errors.map(item=>item.rule+'：'+item.message).join('；'));
   const missedRow=document.createElement('div');missedRow.className='modalactions';missedRow.dataset.missedRow='1';
   for(const rule of ['守承诺','盯依赖','做简报','复核旧判断']){
    const button=document.createElement('button');button.className='btn';button.dataset.speakMissed=rule;
    button.textContent=rule+'：该说没说';
    button.onclick=()=>send('speak_feedback',{feedback:'missed',condition:rule})
     .then(()=>{notify('记下了：'+rule+' 的门槛放宽一档');return renderHeartbeat()}).catch(error=>notify(error.message,true));
    missedRow.append(button);
   }
   heartbeatBody.append(Object.assign(document.createElement('p'),{className:'noticeline',textContent:'它没说到、但你觉得该说的，点下面让它放松这一类的门槛：'}),missedRow);
  };
  if(history){
   let rendered=false;
   history.addEventListener('toggle',()=>{if(!history.open)return;rendered=true;void renderHeartbeat()});
   if(history.open&&!rendered)void renderHeartbeat();
  }
  const heartbeatButton=body.querySelector('#settingsheartbeat');
  if(heartbeatButton)heartbeatButton.onclick=async()=>{
   heartbeatButton.disabled=true;
   try{
    const result=await send('heartbeat_run');
    notify('做完了：值得找你的 '+(result?.record?.counts?.candidates??0)+' 条，其余都写了没打扰你的原因');
    await Promise.all([loadStatus(),loadTiming()]);
    if(history?.open)await renderHeartbeat();
   }catch(error){notify(error.message,true)}
   finally{heartbeatButton.disabled=false}
  };

  // 关于：展开时才读版本/数据根（首屏不为它付高度）。
  const about=body.querySelector('[data-settings-details="about"]');
  const aboutBody=body.querySelector('#aboutbody');
  const renderAbout=async()=>{
   if(!aboutBody)return;
   aboutBody.innerHTML=aboutHtml(status);
   const rootCell=aboutBody.querySelector('[data-about-root]');
   const login=aboutBody.querySelector('#settingslogin');
   if(login)login.onclick=()=>openLogin?.();
   if(!rootCell)return;
   let data=null;
   try{data=await send('workspaces')}catch{}
   if(!modal.current(request))return;
   const root=(data?.items??[]).find(item=>item.id===data?.root);
   const rootState=data?.rootStatus??null;
   const paragraph=document.createElement('p');paragraph.className='formhint';
   if(root){
    paragraph.textContent='现在用的是「'+(root.title||root.id)+'」（'+(root.path||'路径未记录')+'）。';
    if(rootState?.fallback)paragraph.textContent+='配置里写的是「'+(rootState.configured||'')+'」，但 DSH 里没有这个文件夹，所以现在用的是上面这个。想改的话，在 DSH 里把「'+(rootState.configured||'')+'」加成工作区。';
   }else paragraph.textContent='还没有声明根目录；请在插件配置里指定 rootDirectory（数据与文件授权都跟着它走）。';
   rootCell.replaceChildren(paragraph);
  };
  if(about)about.addEventListener('toggle',()=>{if(about.open)void renderAbout()});

  // 授权面板：点「管理」后才挂载（首屏高度不被它占）。
  mountGrants=async()=>{
   if(!grantsBody)return;
   let stage='list';
   let pending=null;
   let browser=null;
   const stopBrowser=()=>{browser?.dispose();browser=null};
   const renderGrants=async()=>{
    if(!modal.current(request))return;
    if(stage==='browse'){
     grantsBody.replaceChildren();
     const lead=document.createElement('p');lead.className='formhint';lead.textContent='选一个文件夹，下一步再决定只读还是可读写。';grantsBody.append(lead);
     const box=document.createElement('div');box.className='folderpanel grantbrowser';box.dataset.grantBrowser='1';grantsBody.append(box);
     const back=document.createElement('button');back.type='button';back.className='btn';back.dataset.grantBack='1';back.textContent='返回已授权清单';
     back.onclick=()=>{stopBrowser();stage='list';renderGrants()};grantsBody.append(back);
     browser=mountDirectoryBrowser(box,{document,send,notify,initialPath:pending?.path??'',allowCreate:true,selectLabel:'选这个文件夹',
      onSelect:(path,item)=>{stopBrowser();pending={path,label:item?.name??(String(path).split('/').filter(Boolean).pop()??path)};stage='permission';renderGrants()}});
     return;
    }
    if(stage==='permission'&&pending){
     grantsBody.replaceChildren();
     const lead=document.createElement('p');lead.className='grantsentence';lead.dataset.grantStep='2';
     lead.textContent='把「'+(pending.label||pending.path)+'」交给工作台：';
     grantsBody.append(lead);
     const row=document.createElement('div');row.className='folderactions';
     const read=document.createElement('button');read.type='button';read.className='btn';read.dataset.grantPermission='read';read.textContent='只读（能看，不能改）';
     const write=document.createElement('button');write.type='button';write.className='btn';write.dataset.grantPermission='write';write.textContent='可读写（能改文件）';
     const save=async writable=>{
      read.disabled=true;write.disabled=true;
      try{
       await send('grant_add',{path:pending.path,read:true,write:writable,label:pending.label});
       notify('已授权（'+(writable?'可读写':'只读')+'）：'+pending.path);
       pending=null;stage='list';await renderGrants();
      }catch(error){read.disabled=false;write.disabled=false;notify(error.message,true)}
     };
     read.onclick=()=>save(false);write.onclick=()=>save(true);
     const back=document.createElement('button');back.type='button';back.className='btn';back.dataset.grantBack='1';back.textContent='返回重选';
     back.onclick=()=>{stage='browse';renderGrants()};
     row.append(read,write,back);grantsBody.append(row);
     const hint=document.createElement('p');hint.className='formhint';hint.textContent='可读写表示工作台能改这个文件夹里的文件；只读表示只读不改。';grantsBody.append(hint);
     return;
    }
    let data=null;
    try{data=await send('directory_list',{path:''})}catch(error){grantsBody.textContent='读不到文件夹清单：'+humanFolderError(error,'')+'。';return}
    if(!modal.current(request))return;
    grantsBody.replaceChildren();
    const authorized=data.authorized??[];
    if(!authorized.length)grantsBody.append(Object.assign(document.createElement('p'),{className:'notice',textContent:'还没有授权任何文件夹，工作台读不到你的文件。'}));
    for(const grant of authorized){
     const row=document.createElement('div');row.className='grantrow';
     const name=document.createElement('span');name.className='grantname';name.textContent=grant.label||grant.root;
     const perm=document.createElement('span');perm.className='grantsource';perm.dataset.grantPermissionText=grant.write?'write':'read';
     perm.textContent=grant.write?'可读写':'只读';
     row.append(name,perm);
     if(String(grant.id).startsWith('dir-')){
      const revoke=document.createElement('button');revoke.type='button';revoke.className='btn';revoke.dataset.revoke=grant.id;revoke.textContent='取消授权';
      let armed=false;
      revoke.onclick=()=>{
       if(!armed){armed=true;revoke.textContent='确认取消？';revoke.dataset.confirm='1';return}
       revoke.disabled=true;
       send('grant_remove',{id:grant.id}).then(()=>{notify('已取消授权：'+(grant.label||grant.id));renderGrants()}).catch(error=>{revoke.disabled=false;notify(error.message,true)});
      };
      row.append(revoke);
     }else{
      const fixed=document.createElement('span');fixed.className='grantsource';fixed.dataset.grantFixed='1';fixed.textContent='由 DSH 设置固定 · 界面不能改';
      row.append(fixed);
     }
     grantsBody.append(row);
    }
    const knowledge=status?.capabilities?.knowledge;
    const kbRow=document.createElement('div');kbRow.className='grantrow';kbRow.dataset.grantKnowledge='1';
    const kbName=document.createElement('span');kbName.className='grantname';kbName.textContent='知识库';
    const kbValue=document.createElement('span');kbValue.className='grantsource';
    kbValue.textContent=(knowledge?.baseGrants??0)>0?('已接上 '+knowledge.baseGrants+' 个'):'还没有；在 DSH 设置里给工作台加知识库';
    kbRow.append(kbName,kbValue);grantsBody.append(kbRow);
    const add=document.createElement('button');add.type='button';add.className='btn primary';add.dataset.grantAdd='1';add.textContent='添加文件夹';
    add.onclick=()=>{stage='browse';renderGrants()};
    grantsBody.append(add);
    const hint=document.createElement('p');hint.className='formhint';hint.textContent='授权立即生效，不用重启；没授权的文件夹读不到内容。';grantsBody.append(hint);
   };
   await renderGrants();
  };

  // IM 助理·飞书：首屏只占一行折叠（不平铺四层），展开看细节。
  const imSlot=body.querySelector('[data-settings-slot="integrations"]');
  const renderIm=()=>{
   if(!imSlot)return;
   const health=status?.imHealth??null;
   const summary=!health?'IM 助理 · 飞书：读不到状态'
    :health.plugin?.state==='loaded'&&health.cwd?.state==='ok'?'IM 助理 · 飞书：已加载'
    :health.plugin?.state==='incompatible'?'IM 助理 · 飞书：插件未加载（与 DSH 版本不兼容）'
    :health.plugin?.state==='loaded'?'IM 助理 · 飞书：渠道最近没有成功记录'
    :'IM 助理 · 飞书：插件未加载';
   imSlot.innerHTML=`<details class="settingshelp" data-settings-im="1"><summary>${esc(summary)}</summary>${imHealthHtml(health,{heading:false})}</details>`;
  };
  await Promise.all([loadStatus(),loadTiming()]);
  renderIm();
  return true;
 }
 async function inspect(id){
  const preview=await send('preview',{id});
  if(preview.status==='draft'){await batch.open(id);return}
  const request=token=modal.begin();if(request===null)return;
  const receipt=preview.receipt;
  // 已处理的改动：用几行说清楚"什么时候、编号多少、能不能撤销"，不再打印 JSON。
  const html=`<p class="noticeline">这批改动已经生效。</p><div class="proof"><div>生效时间：${esc(String(receipt?.at??'').slice(0,19).replace('T',' ')||'未记录')}</div><div>记录编号：${esc(receipt?.id??'未记录')}（撤销时用得到）</div></div><p class="notice">撤销前会让你再确认一次，确认后才生效。</p><div class="modalactions">${receipt?.key?'<button class="btn" id="inboxundo">撤销这次修改</button>':''}<button class="btn" id="inboxback">关闭</button></div>`;
  if(!modal.present(request,{title:humanTitle(preview.title)||'待确认的改动',type:'已处理',html}))return;
  const body=document.querySelector('#detailbody');
  const undo=body.querySelector('#inboxundo');if(undo)undo.onclick=()=>send('undo_draft',{key:receipt.key}).then(draft=>batch.open(draft.id)).catch(error=>notify(error.message,true));
  const back=body.querySelector('#inboxback');if(back)back.onclick=()=>modal.close();
 }
 let openInbox=null;
 return {render,openSettings,open:openSettings,setOpenInbox(handler){openInbox=handler},setOpenRecord(handler){openRecord=handler},setProjects(list){projects=list},dispose(){modal.invalidate(token)}};
}
