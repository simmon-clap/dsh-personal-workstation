import {buildBriefing} from './briefing.mjs';
import {exportViewMarkdown,updateViewAnalysis} from './view-spec.mjs';
import {buildAdvice} from './advice.mjs';
import {REQUEST_MAX_BYTES} from './limits.mjs';
import {appleStatus,runAppleSync,appleImportDraft} from './apple-sync.mjs';
import {createAudioInput} from './audio-input.mjs';
import {resolve as resolvePath} from 'node:path';
import {apiError} from './api-error.mjs';
import {DomainError} from './store.mjs';
import {runHeartbeat} from './heartbeat.mjs';
import {decideLevel,spokenThisWeek} from './speak.mjs';
import {graph,searchNodes} from './graph.mjs';
import {overview} from './overview.mjs';
import {buildPendingChecks} from './pending-checks.mjs';
import {exportCalendar} from './calendar.mjs';
import {runtimeStatus} from './runtime-status.mjs';
import {recordCommittedIntake} from './intake-record.mjs';
import {readBatchOrigin} from './session-origin.mjs';
import {artifactState} from './artifact-state.mjs';
import {ingestFile,knowledgeState} from './knowledge-ingest.mjs';
import {readLayout,saveLayout} from './layout.mjs';
import {buildViewPreview,saveViewDraft} from './view-spec.mjs';
const output=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'}});
/** Installed on the authenticated DSH connection; no standalone server. */
export function browserRoute({store,connection,workspaceRegistry,allowedWorkspaces,rootWorkspaceId,rootStatus,files,knowledge,schedule,heartbeatTiming={scheduled:false,intervalMinutes:0},executions,heartbeat,speak,beat=null,intake=null,runner,office,speech,sessionQuery,grants,workspaceFs,workspaces,configuredWorkspaces=[],integrations={},apple=null,appleConfig={},audio:audio_input=createAudioInput(),transcribeWithoutApproval=false,executionEnabled=false,imHealth=null}){
 // 允许列表可能是配置数组，也可能是"配置 ∪ 界面运行时授权"的取函数；不缓存，界面刚授权的要立刻生效。
 const allowedSet=()=>new Set(typeof allowedWorkspaces==='function'?allowedWorkspaces():allowedWorkspaces??[]);
 // 工作区清单来自 DSH 工作区注册表（不允许手填 id）。configured 表示来自配置文件、界面不能撤销。
 const workspaceCatalog=()=>workspaceRegistry.list().map(w=>({id:w.id,title:w.title??w.id,path:w.path??null,authorized:allowedSet().has(w.id),runtime:Boolean(workspaces?.has(w.id)),configured:configuredWorkspaces.includes(w.id)}));
 return {path:'/personal-workstation/api',methods:['POST'],requestBody:'buffered',async fetch(request){
  try{
   const admission=connection.admit({headers:request.headers});
   if('rejection' in admission)return output({error:'UNAUTHORIZED'},admission.rejection);
   if(request.method!=='POST')return output({error:'METHOD'},405);
   // A non-simple header forces cross-origin callers through preflight in addition to Host/Origin admission.
   if(request.headers.get('x-workstation-client')!=='1')return output({error:'FORBIDDEN'},403);
   const raw=await request.text();if(Buffer.byteLength(raw,'utf8')>REQUEST_MAX_BYTES)return output({error:'TOO_LARGE'},413);
   const body=JSON.parse(raw);
   if(!body||Array.isArray(body)||typeof body!=='object')throw new DomainError('INVALID','请求格式无效');
   // 工作区清单与授权本身：这是"授权哪些工作区"这个设置的入口，必须在"当前工作区已授权"检查之前处理，
   // 否则用户永远没法把别的工作区加进白名单。它同样受宿主连接身份与专用请求头保护（上面已经校验过）。
   // 工作台只认一个根：这里把配置里声明的根目录工作区标出来（root），前端不再让用户选工作区。
   if(body.action==='workspaces')return output({
    root:typeof rootWorkspaceId==='function'?rootWorkspaceId():null,
    items:workspaceRegistry.list().filter(w=>allowedSet().has(w.id)).map(w=>({id:w.id,title:w.title??w.id,path:w.path??null})),
    // 配置声明的根 vs 实际用的工作区：对不上时界面要如实说明，不能让用户自己猜
    // （2026-10-16 实测过静默回退把根指到别的目录）。
    rootStatus:typeof rootStatus==='function'?rootStatus():null,
   });
   if(body.action==='workspace_catalog')return output({items:workspaceCatalog()});
   if(body.action==='workspace_allow'||body.action==='workspace_disallow'){
    if(!workspaces)throw new DomainError('UNAVAILABLE','工作区授权未接入');
    const id=typeof body.id==='string'?body.id.trim():'';
    if(!id)throw new DomainError('INVALID','需要工作区 id');
    if(!workspaceRegistry.get(id))throw new DomainError('INVALID','没有这个已注册的工作区：'+id+'（清单来自 DSH 工作区注册表，不能手填 id）');
    const result=body.action==='workspace_allow'?workspaces.add(id):workspaces.remove(id);
    return output({...result,items:workspaceCatalog(),allowed:[...allowedSet()]});
   }
   if(!allowedSet().has(body.workspace)||!workspaceRegistry.get(body.workspace))throw new DomainError('FORBIDDEN','工作区未授权');
   const ctx={workspace:body.workspace,actor:'operator:'+admission.peer.id,canWrite:true};
   // Browser actions represent an authenticated human operator, not an Agent permission claim.
   switch(body.action){
     case 'knowledge_bases':return output({items:knowledge?.grants.filter(g=>g.workspace===ctx.workspace).map(g=>({id:g.baseId,title:g.label||g.baseId}))??[]});
     case 'knowledge_search':if(!knowledge)throw new DomainError('UNAVAILABLE','知识服务未接入');return output(await knowledge.search(ctx,{baseId:body.baseId,query:body.query,topK:body.topK},request.signal));
     // 收录状态只读查询：界面据此区分索引中/已完成/失败，不自动修复。
     case 'knowledge_status':{if(!knowledge?.service)throw new DomainError('UNAVAILABLE','知识服务未接入');const item=store.get(ctx,body.id);if(!item||item.archived)throw new DomainError('NOT_FOUND','记录已归档或不可用');return output(await knowledgeState(knowledge.service,{baseId:item.data.knowledgeBaseId,documentId:item.data.knowledgeDocId}))}
     // 人工入口收录：点击本身就是操作者的授权，因此与 Agent 侧不同，这里不再要求审批；
     // 仍然写入宿主知识库 + 生成可确认的草稿，两步结果都如实返回。
     case 'knowledge_ingest':{
      if(!knowledge?.service)throw new DomainError('UNAVAILABLE','知识服务未接入');
      if(!files)throw new DomainError('UNAVAILABLE','文件服务未接入');
      if(!knowledge.grants.some(grant=>grant.workspace===ctx.workspace&&grant.baseId===body.baseId))throw new DomainError('FORBIDDEN','该知识库未授权给当前工作区');
      const item=store.get(ctx,body.id);
      if(!item||item.archived||item.kind!=='artifact')throw new DomainError('INVALID','只能把资料类型的记录存进知识库');
      const result=await ingestFile({service:knowledge.service,files,ctx,grantId:item.data.fileGrantId,path:item.data.path,baseId:body.baseId});
      const staged=[{stage:'ingest',ok:true,...result}];
      try{
       const draft=store.draft({...ctx,canWrite:true},{title:'存进知识库 · '+(item.data.title??item.id),changes:[{op:'update',id:item.id,expectedRevision:item.revision,data:{...item.data,knowledgeBaseId:result.baseId,knowledgeDocId:result.documentId??'',knowledgeUpdatedAt:new Date().toISOString()}}],source:{operator:admission.peer?.id??'operator'}});
       staged.push({stage:'record',ok:true,batchId:draft.id,note:'已生成待确认的改动，同意后写进工作台'});
      }catch(error){staged.push({stage:'record',ok:false,reason:error?.message??'没能写进工作台'})}
      return output({staged,available:staged.every(step=>step.ok)});
     }
     case 'execution_history':if(!executions)throw new DomainError('UNAVAILABLE','执行历史未接入');return output(executions.list(ctx,{taskId:body.taskId,limit:body.limit,offset:body.offset}));
     // 主动做事：与宿主工具同源（同一引擎、同一张记录表），页面侧也能手动跑一次并看到留痕。
     // 出声反馈：界面上自己点的回应，直接生效（自己的操作不必先问）。
     case 'speak_status':{
      if(!speak)throw new DomainError('UNAVAILABLE','出声反馈尚未接入');
      return output({state:speak.state(ctx),items:speak.list(ctx,{limit:body.limit??20,offset:body.offset??0}).items});
     }
     case 'speak_feedback':{
      if(!speak)throw new DomainError('UNAVAILABLE','出声反馈尚未接入');
      return output({item:speak.record(ctx,{kind:body.feedback,subjectId:body.subjectId??null,condition:body.condition??null}),state:speak.state(ctx)});
     }
     case 'heartbeat_run':{
      if(!heartbeat)throw new DomainError('UNAVAILABLE','主动做事的记录尚未接入');
      // 宪章四「建议闭环」：主动做事分两层 —— 先是**做事**（看一眼有没有已经成立的结论），
      // 再是**出声**（心跳按规则决定要不要现在告诉你）。建议属于前者：它直接落到收件箱
      // 等你决定，不占用"每周出声预算"，也不会替你改任何东西。
      const advice=buildAdvice({store,ctx,now:new Date()});
      const previous=heartbeat.status(ctx,heartbeatTiming);
      const record=runHeartbeat({store,ctx,now:new Date(),since:previous.lastSuccessAt,
        // 手动触发：这一次不是定时唤醒；intervalMinutes 让留痕能写明"定时开着，每 N 分钟也会醒"。
        scheduled:false,intervalMinutes:heartbeatTiming.intervalMinutes,
       speak:candidate=>decideLevel(candidate,{budget:speak?speak.state(ctx).budget:40,now:new Date(),
        spokenThisWeek:spokenThisWeek(heartbeat.list(ctx,{limit:50}).items),channelReady:false})});
      heartbeat.record(ctx,{...record,advice:{drafted:advice.drafted,suggestions:advice.suggestions.map(item=>item.title)}});
      return output({record,status:heartbeat.status(ctx,heartbeatTiming)});
     }
     case 'heartbeat_status':{
      if(!heartbeat)throw new DomainError('UNAVAILABLE','主动做事的记录尚未接入');
      return output({status:heartbeat.status(ctx,heartbeatTiming),latest:heartbeat.latest(ctx),items:heartbeat.list(ctx,{limit:body.limit??20,offset:body.offset??0}).items});
     }
     // 与 Agent 工具同源：浏览器设置面板也必须看到真实加载情况，否则会误报未接入。
    case 'runtime_status':return output({...runtimeStatus(files,ctx.workspace,knowledge,runner,{office:Boolean(office),apple:Boolean(apple),speech,transcribeWithoutApproval:transcribeWithoutApproval===true,assistant:beat?beat.state(ctx,{residentSide:'resident'}):null,config:{integrations}}),imHealth:typeof imHealth==='function'?await imHealth():null,workspace:{id:ctx.workspace,title:workspaceRegistry.get?.(ctx.workspace)?.title??null},writeRequiresApproval:true});
     case 'calendar_export':return output(exportCalendar(store,ctx,{ids:body.ids}));
     // 收件本（spec/03 §13 · spec/55 P1）：给界面看「今天收了多少、多少还悬着、多少等你一句话」。
     // 没接入时如实说没接入，不返回一个"0"让界面看起来像"今天什么都没发生"（17 C8）。
     case 'intake_summary':return output(intake?intake.summary(ctx):{available:false,reason:'收件本未接入'});
     case 'intake_list':return output(intake?{items:intake.list(ctx,{state:body.state,source:body.source,unassigned:body.unassigned,limit:body.limit})}:{available:false,items:[]});
     case 'intake_open':return output(intake?{items:intake.open(ctx,{waitingHours:body.waitingHours})}:{available:false,items:[]});
     case 'intake_assign':{if(!intake)throw new DomainError('UNAVAILABLE','收件本未接入');return output(intake.assign(ctx,body.id,{subjectKind:body.kind,subjectId:body.subjectId}));}
     case 'node_search':return output(searchNodes(store,ctx,{query:body.query,limit:body.limit}));
     case 'file_grants':return output({items:files?.grants.filter(g=>g.workspace===ctx.workspace).map(({id,label,read,write})=>({id,label,read,write}))??[]});
     // 目录浏览 / 新建 / 授权：让用户在工作台里完成，不必改配置文件再重启。
     // 预览与转写仍然只读**已授权**的目录；这里只列出目录名，不读文件内容。
     case 'schedule_list':{
      // 定时任务列表。**没接入就如实说没接入**（约束三），不返回空数组冒充"你一个都没排"——
      // 那会让人以为"我没排过"，而实际是"读不到"。
      if(!schedule?.list)return output({available:false,reason:'这台机器上没有接入定时服务（需要启用「自动化任务」）'});
      try{
       const items=await schedule.list({workspace:ctx.workspace});
       return output({available:true,items:(items??[]).map(row=>({id:String(row?.id??''),title:String(row?.title??''),at:String(row?.at??row?.nextAt??''),every:row?.every??null,enabled:row?.enabled!==false}))});
      }catch(error){return output({available:false,reason:String(error?.message??error).slice(0,200)})}
     }
     case 'briefing':{
      // 只读：算一份简报给界面/心跳用。不写库、不改任何东西 —— 要不要采纳由人决定。
      return output(buildBriefing({store, ctx, now: new Date(), since: typeof body.since === 'string' ? body.since : null}));
     }
     case 'directory_list':{
      const workspacePath=workspaceRegistry.get?.(ctx.workspace)?.path;
      return output({...workspaceFs.list(workspacePath,typeof body.path==='string'?body.path:''),
       authorized:(files?.grants.filter(g=>g.workspace===ctx.workspace)??[]).map(g=>({id:g.id,label:g.label,read:g.read,write:g.write,root:g.root}))});
     }
     case 'directory_create':{
      const workspacePath=workspaceRegistry.get?.(ctx.workspace)?.path;
      return output(workspaceFs.create(workspacePath,typeof body.path==='string'?body.path:'',body.name));
     }
     case 'grant_add':{
      const workspacePath=workspaceRegistry.get?.(ctx.workspace)?.path;
      const created=grants.add({id:typeof body.id==='string'&&body.id.trim()?body.id.trim():'dir-'+Buffer.from(String(body.path)).toString('hex').slice(0,12),workspace:ctx.workspace,root:typeof body.root==='string'&&body.root.trim()?body.root:resolvePath(workspacePath,body.path),read:body.read!==false,write:body.write===true,label:body.label});
      files?.refresh?.();
      return output({grant:created,grants:files?.grants.filter(g=>g.workspace===ctx.workspace).map(({id,label,read,write,root})=>({id,label,read,write,root}))??[]});
     }
     case 'grant_remove':{
      if(typeof body.id!=='string'||!body.id.trim())throw new DomainError('INVALID','需要授权标识');
      const removed=grants.remove(body.id.trim());
      files?.refresh?.();
      return output({...removed,grants:files?.grants.filter(g=>g.workspace===ctx.workspace).map(({id,label,read,write})=>({id,label,read,write}))??[]});
     }
     case 'file_list':if(!files)throw new DomainError('UNAVAILABLE','文件服务未接入');return output(await files.list(ctx,body));
      case 'file_read':if(!files)throw new DomainError('UNAVAILABLE','文件服务未接入');return output(await files.read(ctx,body));
     // 语音转写：操作者在界面上的点击**就是**授权（与文件预览、收录同一套语义）。
     // 只读取授权目录内的音频、只返回文字，不写任何业务数据；要成为记录必须再走草稿与确认。
     case 'transcribe':{
      if(!speech)throw new DomainError('UNAVAILABLE','语音转写未接入：未加载 DSH speechToText 服务');
      if(!files)throw new DomainError('UNAVAILABLE','文件服务未接入');
      const audio=await files.readBinary(ctx,{grantId:body.grantId,path:body.path});
      // 与 Agent 侧同一套规范化：手机录音多为 m4a/opus，先在本机转成严格形态再识别。
      const normalized=await audio_input.normalize(audio.bytes,String(body.path).split('.').pop()??'');
      const spec=speech.resolve({...(typeof body.language==='string'&&body.language.trim()?{language:body.language.trim()}:{}),audio:normalized.bytes});
      const result=await speech.transcribe(spec);
      // 与 Agent 侧同一口径（含 language 兜底）：本机宿主保证该字段，这里只防契约变化，
      // 让界面拿到的转写结果字段形状稳定（HTTP 侧走 JSON.stringify，缺字段会被静默丢掉）。
      return output({text:result.text,audioSeconds:result.audioSeconds,inferenceSeconds:result.inferenceSeconds,provider:spec.provider?.info?.id??null,language:spec.language??null,grantId:body.grantId,path:body.path,bytes:audio.size,converted:normalized.converted===true,converter:normalized.converter??null});
     }
     case 'file_save':if(!files)throw new DomainError('UNAVAILABLE','文件服务未接入');return output(await files.save(ctx,body));
     case 'layout_get':return output({item:readLayout(store,ctx,body.view)});
     // 苹果日历：status 只读；sync 会写用户的日历（操作者点击即授权，与文件预览同一套语义）；import 只生成草稿。
     case 'apple_status':return output(await appleStatus({apple,config:appleConfig}));
     case 'apple_sync':return output(await runAppleSync({store,ctx,apple,config:appleConfig,mode:['push','pull','both'].includes(body.mode)?body.mode:'both'}));
     case 'apple_import':return output(await appleImportDraft({store,ctx,apple,config:appleConfig}));
     case 'layout_save':return output(saveLayout(store,ctx,body));
     // 生成视图 v1（18 号 §3）：预览只读、不落库；保存只生成 draft，由既有 batch 审核，不直接 commit。
     // 输入/输出与 Agent 侧同一套（src/view-spec.mjs），不在这里另写一份模板逻辑。
     case 'view_preview':return output({view:buildViewPreview({store,ctx,template:body.template,subjectId:body.subjectId,params:body.params,viewId:body.viewId,now:new Date()})});
     case 'view_save':return output(saveViewDraft({store,ctx,view:body.view,as:body.as,analysis:body.analysis,source:{operator:admission.peer?.id??'operator'}}));
     case 'view_export':return output(exportViewMarkdown(body.view));
     case 'view_analysis_update':return output(updateViewAnalysis({store,ctx,viewId:body.viewId,revision:body.revision,analysis:body.analysis,source:{operator:admission.peer?.id??'operator'}}));
     case 'overview':return output(overview(store,ctx,{execution:{connected:Boolean(executionEnabled),reason:executionEnabled?'执行器已启用':'执行器未启用'}}));
     case 'pending_checks':return output({items:buildPendingChecks({store,ctx,limit:body.limit??5})});
     case 'graph':return output(graph(store,ctx,{focus:body.focus,limit:body.limit,offset:body.offset}));
    case 'list':return output({items:store.list(ctx,{kind:body.kind,projectId:body.projectId,executionTarget:body.executionTarget,status:body.status,query:body.query,includeArchived:body.includeArchived,limit:body.limit,offset:body.offset})});
    case 'get':return output({item:store.get(ctx,body.id)});
    case 'inbox':return output({items:store.inbox(ctx,{status:body.status,limit:body.limit,offset:body.offset})});
    // 记录与文件是两套状态：只读比较并如实报告哪一边变了（PRD CH-05 分阶段结果）。
    case 'artifact_state':{const item=store.get(ctx,body.id);if(item.archived)throw new DomainError('NOT_FOUND','记录已归档或不可用，请刷新');return output(await artifactState(files,ctx,item))}
    // 只认服务端保存的来源会话；不接受调用方传入的 sessionId（PRD CH-06-8 可追溯且不可伪造）。
    case 'batch_origin':{const batch=store.batch(ctx,body.id);if(!batch)throw new DomainError('NOT_FOUND','这次改动不存在');return output(await readBatchOrigin(sessionQuery,batch.source?.sessionId,{signal:request.signal}))}
    case 'preview':return output(store.preview(ctx,body.id));
    case 'draft':return output(store.draft(ctx,{title:body.title,changes:body.changes,proposal:body.proposal,source:body.id?(store.batch(ctx,body.id)?.source??{operator:admission.peer.id}):{operator:admission.peer.id}},body.id,body.revision));
    case 'cancel_draft':return output(store.cancelDraft(ctx,body.id,body.revision));
     case 'commit':{
      const committed=store.commit(ctx,{batchId:body.id,revision:body.revision,key:body.key});
      // 五个口之一「页面」：提交成功 = 这条输入接住了（spec/03 §13）。
      // 记账失败不影响这次提交本身（账本是附产品，不能反噬业务）。
      recordCommittedIntake({intake,store,ctx,source:'page',batchId:body.id,receipt:committed});
      return output(committed);
     }
    case 'proposal_history':return output({items:store.proposalHistory(ctx,{limit:body.limit??20}),stats:store.proposalStats(ctx,{limit:body.limit??20})});
    case 'undo_draft':return output(store.undoDraft(ctx,body.key));
    case 'receipt':return output({receipt:store.receipt(ctx,body.key)});
    default:throw new DomainError('INVALID','未知动作');
   }
  }catch(e){const {status,body}=apiError(e);return output(body,status);}
 }};
}
