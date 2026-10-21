import {browserLoginRoute} from './browser-login-route.mjs';
import {ExecutionRunner} from './execution-runner.mjs';
import {SubagentExecutor} from './subagent-executor.mjs';
import {ExecutionStore} from './execution-store.mjs';
import {HeartbeatStore} from './heartbeat-store.mjs';
import {BeatStore} from './beat-store.mjs';
import {IntakeStore} from './intake-store.mjs';
import {runHeartbeat} from './heartbeat.mjs';
import {SpeakStore} from './speak-store.mjs';
import {readFileSync,mkdirSync,chmodSync} from 'node:fs';
import {dirname,isAbsolute,join,resolve,parse} from 'node:path';
import {fileURLToPath} from 'node:url';
import {WorkstationStore} from './store.mjs';
import {DshAdapter,toolDefinition} from './dsh-adapter.mjs';
import {httpRoute} from './http-route.mjs';
import {KnowledgeAdapter} from './knowledge-adapter.mjs';
import {HostFiles} from './host-files.mjs';
import {createAppleCalendar} from './apple-calendar.mjs';
import {readImHealthFromDisk} from './im-health.mjs';
import {createAudioInput} from './audio-input.mjs';
import {createGrantStore} from './grant-store.mjs';
import {createWorkspaceStore} from './workspace-store.mjs';
import {Config} from './config-schema.mjs';
export {Config};
import {createWorkspaceFs} from './workspace-fs.mjs';
export const name='dsh-personal-workstation';

export const inject=['tools','skills','sessions','workspaceRegistry','approval'];

export function resolveConfig(config={}){
 if(!config||typeof config!=='object'||Array.isArray(config))throw new Error('工作台配置必须为对象');
 if(Object.keys(config).some(k=>!['dataDirectory','rootDirectory','allowedWorkspaces','fileGrants','knowledgeGrants','execution','transcribeWithoutApproval','mini','calendar','feishu','dingtalk','ticket','appleCalendar','heartbeat','assistant'].includes(k)))throw new Error('未知工作台配置项');
 // 语音转写的审批策略由用户决定，默认保守（每次都要批准一次）。
 // 说明：Agent 侧 transcribe 是唯一的文件内容读取路径，所以默认保留闸门；
 // 授权目录（fileGrants）本身才是数据边界，本项只影响"是否每次都要走一次审批"。
 const transcribeWithoutApproval=config.transcribeWithoutApproval??false;
 if(typeof transcribeWithoutApproval!=='boolean')throw new Error('transcribeWithoutApproval 必须为布尔值');
 if(typeof config.dataDirectory!=='string'||!isAbsolute(config.dataDirectory)||resolve(config.dataDirectory)===parse(resolve(config.dataDirectory)).root)throw new Error('需要专用绝对路径 dataDirectory');
 if(!Array.isArray(config.allowedWorkspaces)||config.allowedWorkspaces.some(w=>typeof w!=='string'||!w.trim()))throw new Error('allowedWorkspaces 必须为工作区 ID 数组');
 const fileGrants=config.fileGrants??[];const ids=new Set();if(!Array.isArray(fileGrants))throw new Error('fileGrants 必须为数组');
 for(const g of fileGrants){if(!g||typeof g!=='object'||Object.keys(g).some(k=>!['id','workspace','root','read','write','label'].includes(k))||typeof g.id!=='string'||!g.id.trim()||ids.has(g.id)||!config.allowedWorkspaces.includes(g.workspace)||typeof g.root!=='string'||!isAbsolute(g.root)||resolve(g.root)===parse(resolve(g.root)).root||typeof g.read!=='boolean'||typeof g.write!=='boolean'||(g.write&&!g.read)||(g.label!==undefined&&typeof g.label!=='string'))throw new Error('文件授权配置无效');ids.add(g.id);}
 const knowledgeGrants=config.knowledgeGrants??[];if(!Array.isArray(knowledgeGrants))throw new Error('knowledgeGrants 必须为数组');const pairs=new Set();for(const g of knowledgeGrants){if(!g||Array.isArray(g)||typeof g!=='object'||Object.keys(g).some(k=>!['workspace','baseId','label'].includes(k))||!config.allowedWorkspaces.includes(g.workspace)||typeof g.baseId!=='string'||!g.baseId.trim()||(g.label!==undefined&&typeof g.label!=='string'))throw new Error('知识授权配置无效');const key=JSON.stringify([g.workspace,g.baseId]);if(pairs.has(key))throw new Error('知识授权重复');pairs.add(key);}
 // 外部接入：只做归一化与"是否已配置"的判断，**不发起任何连接**（接口先留好，凭证后填）。
 const integrations={
  mini:{endpoint:'',token:''},calendar:{provider:'',endpoint:'',token:''},
  feishu:{appId:'',appSecret:''},dingtalk:{clientId:'',clientSecret:''},ticket:{endpoint:'',token:''},
 };
 // volatile 字段在 DSH 里是"可热改"的值容器（带 get()）；普通配置则是裸值。
 // 两种都要能读：不 unwrap 会在校验时报"必须为字符串"，插件又会激活失败（1.1.0 的教训）。
 const unwrap=value=>value&&typeof value.get==='function'?value.get():value;
 // 主动做事的**真定时**间隔（分钟）。0 = 不自动醒（默认）。
 // 缺省或非法值一律按 0 —— 宁可不醒，也不要有意料之外的打扰。
 // 注意嵌套 `.volatile()` 同样被物化成 {get(){}}：不 unwrap 就会"用户设了值也读不到"，静默退回默认。
 // 位置很关键：必须写在 unwrap 定义**之后**（写在前面会 `Cannot access 'unwrap' before initialization`，
 // 实测就是这么炸的 —— 而 activation-replay 当场抓住了它）。
 const heartbeatRaw=unwrap(config.heartbeat)??{};
 const heartbeatValue=unwrap(heartbeatRaw.intervalMinutes);
 const heartbeatMinutes=Number.isFinite(Number(heartbeatValue))&&Number(heartbeatValue)>0?Math.floor(Number(heartbeatValue)):0;
 // 助理后台：常驻节点判活（宪章 v1.4 第七条）。同样要 unwrap：嵌套 volatile 会被物化成 {get(){}}。
 // 缺省一律 false —— 宁可"这台不判活"，也不要在笔记本上凭空报"常驻节点停了"。
 const assistantRaw=unwrap(config.assistant)??{};
 const assistantResident=unwrap(assistantRaw.residentNode);
 const assistantBeatRaw=Number(unwrap(assistantRaw.beatMinutes));
 const assistant={
  residentNode:assistantResident===true,
  beatMinutes:Number.isFinite(assistantBeatRaw)&&assistantBeatRaw>0?Math.min(120,Math.floor(assistantBeatRaw)):15,
 };
 for(const key of Object.keys(integrations)){
  const value=unwrap(config[key]);
  if(value===undefined)continue;
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error(key+' 配置必须为对象');
  for(const field of Object.keys(integrations[key])){
   const raw=unwrap(value[field]);
   if(raw===undefined)continue;
   if(typeof raw!=='string')throw new Error(key+'.'+field+' 必须为字符串');
   integrations[key][field]=raw.trim();
  }
  if(Object.keys(value).some(k=>!(k in integrations[key])))throw new Error(key+' 含未知字段：'+Object.keys(value).find(k=>!(k in integrations[key])));
 }
 const execution=config.execution??{enabled:false};if(!execution||typeof execution!=='object'||Array.isArray(execution)||Object.keys(execution).some(k=>!['enabled','provider','tools'].includes(k))||typeof execution.enabled!=='boolean')throw new Error('执行配置无效');// 三种形态都要接受：① 完全没写 execution（provider/tools 为 undefined）；
 // ② DSH 按 Config schema **物化默认值**后的 {enabled:false, provider:'', tools:[]}——空值等于"没配置"，
 //    把它当非法值会把插件直接挡在激活之外（1.1.0 的回归正是这样发生的）；③ 真正启用。
 // 启用的规则保持原样（此前就有测试锁定：提供方必须非空、工具必须是数组，允许空数组）。
 if(execution.enabled&&(typeof execution.provider!=='string'||!execution.provider.trim()||!Array.isArray(execution.tools)))throw new Error('启用执行必须指定提供方和工具范围');
 if(execution.provider!==undefined&&typeof execution.provider!=='string')throw new Error('执行提供方无效');
 if(execution.tools!==undefined&&!Array.isArray(execution.tools))throw new Error('执行工具范围无效');
 if(Array.isArray(execution.tools)&&(execution.tools.some(t=>typeof t!=='string'||!t.trim()||t==='*')||new Set(execution.tools).size!==execution.tools.length))throw new Error('执行工具范围无效');
 // 苹果日历配置：逗号分隔的日历名转数组；天数夹在 0–365；目标日历默认「个人工作台」。
 const appleRaw=unwrap(config.appleCalendar)??{};
 const appleText=field=>{const value=unwrap(appleRaw[field]);return typeof value==='string'?value.trim():''};
 const appleList=field=>appleText(field).split(',').map(item=>item.trim()).filter(Boolean);
 const appleDays=(field,fallback)=>{const value=unwrap(appleRaw[field]);const number=typeof value==='number'?value:Number(value);return Number.isFinite(number)?Math.max(0,Math.min(365,Math.trunc(number))):fallback};
 const appleEnabled=unwrap(appleRaw.enabled);
 const appleCalendar={
  enabled:appleEnabled===undefined?true:appleEnabled!==false,
  targetCalendar:appleText('targetCalendar')||'个人工作台',
  includeCalendars:appleList('includeCalendars'),
  excludeCalendars:appleList('excludeCalendars'),
  pastDays:appleDays('pastDays',30),
  futureDays:appleDays('futureDays',30),
 };
 // rootDirectory 在 Config schema 里标了 volatile（可热改的值容器，读法是 .get()），
 // **不能**当裸字符串读：宿主物化 schema 后传进来的是 `{get(){…}}`，直接判 typeof 会拿到空值，
 // 于是静默回退成"第一个已授权工作区"——2026-10-16 实测就是这样把根指成了「微信工作区」，
 // 而门禁没抓到（测试喂的是普通字符串，不是物化后的值）。与 integrations 同一套做法。
 const rootDirectoryValue=unwrap(config.rootDirectory);
 const rootDirectory=typeof rootDirectoryValue==='string'?rootDirectoryValue.trim():'';
 return {rootDirectory,heartbeatMinutes,assistant,transcribeWithoutApproval,execution:{...execution,...(execution.tools?{tools:[...execution.tools]}:{})},integrations,appleCalendar,knowledgeGrants:knowledgeGrants.map(g=>({...g})),dataDirectory:config.dataDirectory,allowedWorkspaces:[...new Set(config.allowedWorkspaces)],fileGrants:fileGrants.map(g=>({...g}))};
}
export function apply(ctx,config){
 const resolved=resolveConfig(config);
 ctx.effect(()=>{
  mkdirSync(resolved.dataDirectory,{recursive:true,mode:0o700});
  const filename=join(resolved.dataDirectory,'workstation.sqlite');
  const store=new WorkstationStore(filename);chmodSync(filename,0o600);
  const disposers=[];let disposed=false,runner,closing;const cleanup=()=>{if(disposed)return closing;disposed=true;const errors=[];for(const dispose of [...disposers].reverse()){try{dispose()}catch(e){errors.push(e)}}const finish=()=>{try{store.close()}catch(e){errors.push(e)}if(errors.length)throw new AggregateError(errors,'工作台清理失败');};if(runner){closing=runner.close().catch(e=>{errors.push(e)}).then(finish);return closing}return finish();};
  try{
   const executions=new ExecutionStore(store);
   // 主动做事的记录表（F24）：系统运行记录，不是业务对象 —— 不进实体表、不参与批次治理。
   const heartbeat=new HeartbeatStore(store);
   // 常驻节点心跳（宪章 v1.4 第七条 · 13 §10）：判活靠记账，不靠 ssh 探活。
   const beat=new BeatStore(store);
   // 收件本（宪章 v1.4 第二条「事事有回应」· 03 §13）：每条输入都要有归属。
   const intake=new IntakeStore(store);
   // 出声反馈表（F23 双向计量）：你的回应，与它做了什么分开存。
   const speak=new SpeakStore(store);
   const fs=ctx.get?.('fs');
   // 配置里的授权 + 运行时授权（界面里点的）合并；用取函数让界面授权立刻生效，不必重启。
   const grantStore=createGrantStore({directory:resolved.dataDirectory,workspaceRoots:()=>Object.fromEntries((ctx.workspaceRegistry?.list?.()??[]).map(entry=>[entry.id,entry.path]))});
   // 工作区授权：配置里的 + 用户在「空间与设置 → 工作区授权」里点过的，合并成一个**取函数**交给所有
   // 授权闸门（Agent 工具、文件预览、浏览器 API），因此界面授权立刻生效，不必改配置文件、不必重启。
   const workspaceStore=createWorkspaceStore({directory:resolved.dataDirectory});
   const allowedWorkspaces=()=>[...new Set([...resolved.allowedWorkspaces,...workspaceStore.list()])];
   // 根目录：由配置声明（rootDirectory），没声明就取第一个授权工作区。
   // 工作台的所有业务数据都落在这个根下，工作区只用来定位项目文件的落盘位置。
   const matchRoot=(wanted,list)=>wanted?list.find(entry=>entry.path&&entry.path.replace(/\/+$/,'')===String(wanted).replace(/\/+$/,''))??null:null;
   const rootWorkspaceId=()=>{
    const wanted=resolved.rootDirectory;
    const list=ctx.workspaceRegistry?.list?.()??[];
    const hit=matchRoot(wanted,list);
    if(hit)return hit.id;
    return list.find(entry=>allowedWorkspaces().includes(entry.id))?.id??null;
   };
   // **不静默回退**：配置声明的根与"实际用的工作区"对不上时，把两者都报出来，界面如实说明。
   // 2026-10-16 实测过这条链路静默把根指到别的目录，用户只看到"数据根目录：微信工作区"而不知道为什么。
   const rootStatus=()=>{
    const list=ctx.workspaceRegistry?.list?.()??[];
    const wanted=resolved.rootDirectory||null;
    const hit=matchRoot(wanted,list);
    const used=list.find(entry=>entry.id===rootWorkspaceId())??null;
    return {configured:wanted,declared:Boolean(wanted),matched:Boolean(hit),fallback:Boolean(wanted)&&!hit&&Boolean(used),used:used?{id:used.id,title:used.title??null,path:used.path??null}:null};
   };
   const allGrants=()=>[...resolved.fileGrants,...grantStore.all().filter(runtime=>!resolved.fileGrants.some(configured=>configured.id===runtime.id))];
   const files=fs?new HostFiles(fs,allGrants):undefined;
   const knowledge=new KnowledgeAdapter(undefined,resolved.knowledgeGrants,()=>ctx.get?.('knowledge'));
    // 定时能力：**可选**（`ctx.get` 而非 `inject`）。
    // 它来自 @deepseek-ai/dsh-experimental-schedule-bundle —— 一个实验性包。
    // 写成硬依赖等于把工作台和实验包绑死：没装它工作台就起不来。
    // 取到就用，取不到这一节如实显示「未接入」（约束三·未接入不伪造）。
    const schedule=ctx.get?.('schedule');
    // 真定时（2026-10-16）：宿主 `timer` 服务（Cordis 混入的定时助手）。取不到就不装，设置页如实说未接入。
    // 只做一件事：按间隔跑一次心跳 —— 要不要出声仍由心跳自己按出声额度与免打扰判断，这里不额外打扰。
    // 本机 DSH 关掉就不会醒；真正的 24 小时常驻要靠常驻节点（设置页写明）。
    const timer=ctx.get?.('timer');
    // 注意：这里从 resolved 取，**不能**直接写 `heartbeatMinutes` ——
    // 它在 resolveConfig 的作用域里，写在这里是跨作用域引用（ReferenceError）。
    // 而它的触发条件很阴：只有宿主**真的有 timer** 时才会求值到 —— 假 ctx 没有 timer 就短路跳过，
    // 于是 activation-replay 照样报"通过"（2026-10-16 就是这么让用户启动失败的）。
    const heartbeatMinutes=resolved.heartbeatMinutes;
    const autoHeartbeat=Boolean(timer)&&heartbeatMinutes>0;
    // 唯一事实源（W1 P0-1）：设置页/浏览器/Agent 三条通道都只读这一份。
    const heartbeatTiming={scheduled:autoHeartbeat,intervalMinutes:heartbeatMinutes};
    if(autoHeartbeat){
     const timerCtx=()=>({workspace:rootWorkspaceId??store.batchScopes()[0],actor:'heartbeat',canWrite:true});
     disposers.push(timer.interval(()=>{
      try{
       const ctxNow=timerCtx();
       const record=runHeartbeat({store,ctx:ctxNow,now:new Date(),since:heartbeat.status(ctxNow).lastSuccessAt,
        scheduled:true,intervalMinutes:resolved.heartbeatMinutes,
        speak:null,   // 定时唤醒**不直接出声**：先留痕，要不要找你仍按出声规则与人来定（避免"自己醒了就打扰你"）
       });
       heartbeat.record(ctxNow,{...record});
      }catch{/* 定时这一跑失败不该影响插件本身；下一次还会醒，失败也会留在心跳留痕的"连续失败"里 */}
     },heartbeatMinutes*60*1000));
    }
   // 助理后台 · 常驻节点心跳（宪章 v1.4 第七条 · 13 §10）：
   // **只有被标成常驻的机器才记**。笔记本若也记，会在常驻节点真故障时掩盖问题；
   // 笔记本若去判别人的心跳，会把"我看不到它"误报成"它停了"（2026-10-21 的原始事故）。
   // 这里不碰网络、不调模型，只是"我还在按时醒"这一个事实，0 token。
   if(resolved.assistant.residentNode&&timer){
    const beatCtx=()=>({workspace:rootWorkspaceId??store.batchScopes()[0],actor:'beat',canWrite:true});
    const beatOnce=source=>{try{beat.append(beatCtx(),{side:'resident',source})}catch{/* 记不上一笔不该影响插件本身 */}};
    beatOnce('load');
    disposers.push(timer.interval(()=>beatOnce('timer'),resolved.assistant.beatMinutes*60*1000));
   }
   disposers.push(()=>knowledge.close());
   if(resolved.execution.enabled)runner=new ExecutionRunner(executions,new SubagentExecutor(ctx.get?.('subagents'),resolved.execution));
   // 语音转写复用宿主能力；未加载时适配层会如实报告未接入，不伪造。
    const audio=createAudioInput();
    const workspaceFs=createWorkspaceFs();
    // 苹果日历桥接：只在本机 macOS 上可用，失败时如实报告（不阻塞其它能力）。
    const appleCalendar=createAppleCalendar();
    // IM 助理·飞书四层健康（只读）：插件清单/加载相位来自宿主 pluginManager；
    // 渠道记录与 gateway 日志来自本机文件。读不到就返回 unknown，绝不推断「未加载/未配置」。
    const imHealth=async()=>{
     let bundles=null,plugins=null;
     try{bundles=(await ctx.get?.('pluginManager')?.listBundles?.())??null}catch{/* 宿主没这个服务或读失败：交给 readImHealth 报 unknown */}
     try{plugins=(await ctx.get?.('pluginManager')?.listPlugins?.())??null}catch{/* 同上 */}
     let workspacePath=null,workspaceTitle=null;
     try{const workspace=rootWorkspaceId?ctx.workspaceRegistry?.get?.(rootWorkspaceId):null;workspacePath=workspace?.path??null;workspaceTitle=workspace?.title??null}catch{/* 读不到工作区就只报 cwd unknown */}
     return readImHealthFromDisk({bundles,plugins,workspacePath,workspaceTitle,home:process.env.HOME??''});
    };
    const adapter=new DshAdapter({integrations:resolved.integrations,appleCalendar,appleConfig:resolved.appleCalendar,store,files,knowledge,executions,heartbeat,speak,intake,runner,speech:ctx.get?.('speechToText'),office:ctx.get?.('officeToPdf'),audio,executionConfig:resolved.execution,transcribeWithoutApproval:resolved.transcribeWithoutApproval,sessions:ctx.sessions,workspaceRegistry:ctx.workspaceRegistry,approval:ctx.approval,allowedWorkspaces,heartbeatTiming,imHealth});
   disposers.push(ctx.tools.register(toolDefinition(adapter)));
   const skillPath=fileURLToPath(new URL('../skills/personal-workstation/SKILL.md',import.meta.url));
   disposers.push(ctx.skills.register({name:'personal-workstation',description:'在 DSH 对话中管理工作台项目、任务、资料、日程及变更收件箱。',source:'runtime',resourceBase:{kind:'directory',path:dirname(skillPath)},path:skillPath,content:readFileSync(skillPath,'utf8'),invocation:{modelInvocable:true,userInvocable:true}}));
   const connection=ctx.get?.('connection');
   const webServer=ctx.get?.('webServer');
   if(connection&&webServer)disposers.push(webServer.register(browserLoginRoute(connection)));
   if(connection&&webServer)disposers.push(webServer.register(httpRoute({schedule,heartbeatTiming,rootWorkspaceId,rootStatus,config:resolved,apple:appleCalendar,store,connection,files,knowledge,executions,heartbeat,speak,beat,intake,runner,office:ctx.get?.('officeToPdf'),speech:ctx.get?.('speechToText'),sessionQuery:ctx.get?.('sessionQuery'),audio,grants:grantStore,workspaceFs,transcribeWithoutApproval:resolved.transcribeWithoutApproval,workspaceRegistry:ctx.workspaceRegistry,allowedWorkspaces,workspaces:workspaceStore,configuredWorkspaces:resolved.allowedWorkspaces,executionEnabled:Boolean(resolved.execution?.enabled),imHealth})));
  }catch(e){try{const pending=cleanup();if(pending)return pending.then(()=>{throw e},cleanupError=>{throw new AggregateError([e,cleanupError],'工作台注册及清理失败')})}catch(cleanupError){throw new AggregateError([e,cleanupError],'工作台注册及清理失败')}throw e;}
  return cleanup;
 },'personal workstation: store, tools and skill');
}
