import {DomainError} from './store.mjs';
import {recordCommittedIntake} from './intake-record.mjs';
import {exportViewMarkdown} from './view-spec.mjs';
import {appleStatus,runAppleSync} from './apple-sync.mjs';
import {createAudioInput} from './audio-input.mjs';
import {runtimeStatus} from './runtime-status.mjs';
import {overview} from './overview.mjs';
import {graph,searchNodes} from './graph.mjs';
import {relationCandidates} from './relation-candidates.mjs';
import {readLayout,saveLayout} from './layout.mjs';
import {ingestFile,knowledgeState} from './knowledge-ingest.mjs';
import {runHeartbeat} from './heartbeat.mjs';
import {assembleContext} from './context-assembler.mjs';
import {judgmentChecks} from './judgment-synthesis.mjs';
import {buildPendingChecks} from './pending-checks.mjs';
import {decideLevel,spokenThisWeek} from './speak.mjs';
import {buildViewPreview,previewAndSaveView} from './view-spec.mjs';

/** Only host-owned dependencies and configuration are accepted here. */
export class DshAdapter {
  constructor({store,sessions,workspaceRegistry,approval,files,knowledge,executions,heartbeat=null,speak=null,intake=null,runner,executionConfig,speech,office,audio=createAudioInput(),transcribeWithoutApproval=false,allowedWorkspaces=[],integrations={},appleCalendar=null,appleConfig={},heartbeatTiming={scheduled:false,intervalMinutes:0},imHealth=null}){
    Object.assign(this,{store,sessions,workspaceRegistry,approval,files,knowledge,executions,heartbeat,speak,intake,runner,executionConfig,speech,office,audio,transcribeWithoutApproval,integrations,appleCalendar,appleConfig,heartbeatTiming,imHealth});
    // 允许列表可能来自配置文件，也可能来自界面里的运行时授权；不缓存集合，界面刚授权的要立刻可用。
    this.allowedSource=allowedWorkspaces;
  }
  allowedSet(){
    const source=this.allowedSource;
    return new Set(typeof source==='function'?source():source??[]);
  }
  async context(exec){
    exec.signal?.throwIfAborted();
    if(!exec.agent?.id)throw new DomainError('UNAUTHORIZED','需要真实 Agent 会话');
    const session=this.sessions.get(exec.agent.id);
    if(!session?.header.cwd)throw new DomainError('UNAUTHORIZED','会话无工作区');
    const workspace=await this.workspaceRegistry.resolveByPath(session.header.cwd);
    // 入口链路（DSH 普通对话 / IM 助理）最常见的断点就在这里，错误必须让用户能直接修。
    if(!workspace)throw new DomainError('FORBIDDEN','当前对话所在的文件夹没有被工作台登记，所以定位不到数据：'+session.header.cwd+'（请在 DSH 中把该目录添加为工作区）');
    if(!this.allowedSet().has(workspace.id))throw new DomainError('FORBIDDEN','个人工作台还没有接上「'+(workspace.title??workspace.id)+'」这个文件夹。'
      +'做法：在工作台里打开「设置 → 能读写哪些文件夹」，给需要的文件夹点「授权只读」或「授权读写」，立即生效、不用重启，也不用改配置文件。');
    return {workspace:workspace.id,actor:exec.agent.id,canWrite:false};
  }
  async run(args,exec){
    if(!args||typeof args!=='object'||Array.isArray(args))throw new DomainError('INVALID','参数格式无效');
    const permitted=new Set(['action','id','kind','status','limit','offset','title','changes','proposal','candidates','revision','key','view','positions','viewport','focus','query','baseId','topK','includeArchived','taskId','projectId','executionTarget','grantId','path','language','mode','feedback','condition','subjectId','template','params','viewId','viewData','analysis','roleColors','roleShapes','order']);
    if(Object.keys(args).some(k=>!permitted.has(k)))throw new DomainError('INVALID','不接受工作区、权限或未知参数');
    try{args=structuredClone(args)}catch{throw new DomainError('INVALID','参数必须为可复制的数据')}
    const ctx=await this.context(exec);
    if(args.action==='execution_start'){
      if(!this.runner||!this.executionConfig?.enabled)throw new DomainError('UNAVAILABLE','执行器未启用');
      if(typeof args.taskId!=='string'||!Number.isSafeInteger(args.revision)||args.revision<1||typeof args.key!=='string'||!args.key.trim()||args.key.length>500)throw new DomainError('INVALID','需要任务ID、版本和执行请求标识');
      const task=this.store.get(ctx,args.taskId);if(!task||task.archived||task.kind!=='task')throw new DomainError('NOT_FOUND','执行任务不可用');if(task.revision!==args.revision)throw new DomainError('CONFLICT','任务版本已变化');
      if(task.data.executionTarget&&task.data.executionTarget!=='local')throw new DomainError('UNAVAILABLE','指定执行端尚未接入，未启动本机执行');
      this.runner.assertAvailable?.();
      const outcome=await this.approval.request({agent:exec.agent,toolName:'workstation',callId:exec.callId,signal:exec.signal,reason:JSON.stringify({workspace:ctx.workspace,action:'execution_start',task,provider:this.executionConfig.provider,tools:this.executionConfig.tools,key:args.key})});
      if(outcome!=='allowed-once')throw new DomainError('FORBIDDEN','任务执行未获许可：'+outcome);
      const fresh=await this.context(exec);if(fresh.workspace!==ctx.workspace)throw new DomainError('CONFLICT','数据已经变化');fresh.canWrite=true;
      this.runner.assertAvailable?.();
      const result=await this.runner.run(fresh,{taskId:args.taskId,taskRevision:args.revision,key:args.key},{parent:exec.agent,signal:exec.signal});
      const current=await this.context(exec);if(current.workspace!==ctx.workspace)throw new DomainError('CONFLICT','执行期间会话工作区已变化，结果保存在原工作区');return result;
    }
    switch(args.action){
      case 'knowledge_bases':return {items:this.knowledge?.grants.filter(g=>g.workspace===ctx.workspace).map(g=>({id:g.baseId,title:g.label||g.baseId}))??[]};
      case 'knowledge_status':{
       if(!this.knowledge?.service)throw new DomainError('UNAVAILABLE','知识服务未接入');
       const item=this.store.get(ctx,args.id);
       if(!item||item.archived)throw new DomainError('NOT_FOUND','记录已归档或不可用');
       return knowledgeState(this.knowledge.service,{baseId:item.data.knowledgeBaseId,documentId:item.data.knowledgeDocId});
      }
      case 'knowledge_search':{if(!this.knowledge)throw new DomainError('UNAVAILABLE','知识服务未接入');const result=await this.knowledge.search(ctx,{baseId:args.baseId,query:args.query,topK:args.topK},exec.signal);const fresh=await this.context(exec);if(fresh.workspace!==ctx.workspace)throw new DomainError('CONFLICT','检索期间会话工作区已变化');return result;}
      case 'speak_status':{
       if(!this.speak)throw new DomainError('UNAVAILABLE','出声反馈尚未接入');
       return {state:this.speak.state(ctx),items:this.speak.list(ctx,{limit:args.limit??20,offset:args.offset??0}).items};
      }
      case 'heartbeat_status':{
       if(!this.heartbeat)throw new DomainError('UNAVAILABLE','主动做事的记录尚未接入');
       return {status:this.heartbeat.status(ctx,this.heartbeatTiming),latest:this.heartbeat.latest(ctx),items:this.heartbeat.list(ctx,{limit:args.limit??20,offset:args.offset??0}).items};
      }
      // 关联候选：**只找候选，不下结论**。返回"看起来有关联、但还没连上"的对象对，
      // 每条带一句"凭什么提它"。智能体逐条判断后，用 draft 写 kind:'relation' + status:'suggested' + evidence，
      // 用户在画布上看到虚线并可点否决（用户 2026-10-16：关联推断是核心功能）。
      case 'relation_candidates':{
        const all=this.store.list(ctx,{kind:undefined,limit:1000});
        return {candidates:relationCandidates(all),note:'候选来自数据里已有的共同信号，不是推断结论；请逐条判断后再写 relation，每条必须带 evidence'};
      }
      case 'list':return {items:this.store.list(ctx,{kind:args.kind,projectId:args.projectId,executionTarget:args.executionTarget,status:args.status,query:args.query,includeArchived:args.includeArchived,limit:args.limit,offset:args.offset})};
      case 'get':return {item:this.store.get(ctx,args.id)};
      case 'inbox':return {items:this.store.inbox(ctx,{status:args.status,limit:args.limit,offset:args.offset})};
      // 已回应的建议：Agent 提新建议前先查一遍，避免把被否决过的再提一次（第四条：不复活）。
      case 'proposal_history':return {items:this.store.proposalHistory(ctx,{limit:args.limit}),stats:this.store.proposalStats(ctx,{limit:args.limit??20})};
      case 'preview':return this.store.preview(ctx,args.id);
      case 'receipt':return {receipt:this.store.receipt(ctx,args.key)};
      case 'execution_history':if(!this.executions)throw new DomainError('UNAVAILABLE','执行历史未接入');return this.executions.list(ctx,{taskId:args.taskId,limit:args.limit,offset:args.offset});
      // 入口链路自检：报告当前会话绑定到哪个工作区、写入是否需要审批，避免用户猜为什么没写进去。
      // 语音转写：把授权目录内的录音转成文本，交给模型整理成项目/任务；服务未加载时如实报告未接入。
      case 'transcribe':{
       if(!this.speech)throw new DomainError('UNAVAILABLE','语音转写未接入：未加载 DSH speechToText 服务');
       if(!this.files)throw new DomainError('UNAVAILABLE','文件服务未接入');
       // 默认每次都要批准一次；用户若在配置里显式选择 transcribeWithoutApproval，
      // 则授权目录内的读取直接进行——数据边界仍是 fileGrants，变的只是审批仪式。
      const outcome=this.transcribeWithoutApproval?'allowed-once':await this.approval.request({agent:exec.agent,toolName:'workstation',callId:exec.callId,signal:exec.signal,reason:JSON.stringify({workspace:ctx.workspace,action:'transcribe',grantId:args.grantId,path:args.path})});
       if(outcome!=='allowed-once')throw new DomainError('FORBIDDEN','语音转写未获许可：'+outcome);
       exec.signal?.throwIfAborted();
       const audio=await this.files.readBinary(ctx,{grantId:args.grantId,path:args.path});
       exec.signal?.throwIfAborted();
       // 宿主识别器只接受严格规范的 16k 单声道 PCM16 WAV；手机录音多为 m4a/opus，
       // 因此在本机先转码（afconvert / ffmpeg），绝不把不合规字节直接丢给识别器。
       const normalized=await this.audio.normalize(audio.bytes,String(args.path).split('.').pop()??'');
       exec.signal?.throwIfAborted();
       const spec=this.speech.resolve({...(typeof args.language==='string'&&args.language.trim()?{language:args.language.trim()}:{}),audio:normalized.bytes});
       const result=await this.speech.transcribe(spec,exec.signal);
       // 边界防御，不是已复现的线上缺陷：本机这一版宿主的 resolve() 是
       // `request.language ?? config.language.get()`，而 config.language 为
       // z.string().min(1).default('auto')（见 @deepseek-ai/dsh-experimental-speech-to-text 的
       // SpeechToText.Config / resolve），因此 spec.language 正常保证是非空字符串。
       // 这里仍显式兜底成 null：宿主契约一旦变化（或缺 language 的更旧构建），undefined 会让
       // 整次工具调用被无损 JSON 快照拒收（value is not lossless JSON）。工具返回值只放 JSON 值。
       return {text:result.text,audioSeconds:result.audioSeconds,inferenceSeconds:result.inferenceSeconds,provider:spec.provider?.info?.id??null,language:spec.language??null,grantId:args.grantId,path:args.path,bytes:audio.size,converted:normalized.converted===true,converter:normalized.converter??null};
      }
      // 苹果日历：状态只读；同步会写用户的日历，所以和语音转写一样，Agent 触发需要一次批准。
      case 'apple_status':return {apple:await appleStatus({apple:this.appleCalendar,config:this.appleConfig??{}})};
      case 'apple_sync':{
       if(!this.appleCalendar)throw new DomainError('UNAVAILABLE','未加载苹果日历桥接（仅本机 macOS 可用）');
       const outcome=await this.approval.request({agent:exec.agent,toolName:'workstation',callId:exec.callId,signal:exec.signal,reason:JSON.stringify({action:'apple_sync',workspace:ctx.workspace,mode:args.mode??'both'})});
       if(outcome!=='allowed-once')throw new DomainError('FORBIDDEN','苹果日历同步未获许可：'+outcome);
       exec.signal?.throwIfAborted();
       return {sync:await runAppleSync({store:this.store,ctx,apple:this.appleCalendar,config:this.appleConfig??{},mode:args.mode??'both'})};
      }
      case 'runtime_status':return {...runtimeStatus(this.files,ctx.workspace,this.knowledge,this.runner,{office:Boolean(this.office),apple:Boolean(this.appleCalendar),speech:this.speech,transcribeWithoutApproval:this.transcribeWithoutApproval,config:{integrations:this.integrations??{}}}),imHealth:typeof this.imHealth==='function'?await this.imHealth():null,workspace:{id:ctx.workspace,title:this.workspaceRegistry.get?.(ctx.workspace)?.title??null},writeRequiresApproval:true,approvalScope:['layout_save','commit']};
      case 'assistant_context':return assembleContext({store:this.store,ctx,query:args.query,projectId:args.projectId,taskId:args.taskId,limit:args.limit??5,knowledge:this.knowledge,sessions:this.sessions,agentId:exec.agent?.id});
      case 'judgment_checks':return judgmentChecks({store:this.store,ctx,projectId:args.projectId,candidates:args.candidates??[],limit:args.limit??10});
      case 'pending_checks':return {items:buildPendingChecks({store:this.store,ctx,limit:args.limit??5})};
      case 'overview':return overview(this.store,ctx,{execution:{connected:Boolean(this.runner&&this.executionConfig?.enabled),reason:this.executionConfig?.enabled?'执行器已启用':'执行器未启用'}});
      case 'node_search':return searchNodes(this.store,ctx,{query:args.query,limit:args.limit});
      case 'graph':return graph(this.store,ctx,{focus:args.focus,limit:args.limit,offset:args.offset});
      case 'layout_get':return {item:readLayout(this.store,ctx,args.view)};
      // 生成视图 v1（18 号 §3）：预览只读，不落库；模板/参数/引用校验都在 view-spec.mjs。
      case 'view_export':return exportViewMarkdown(args.viewData);
      case 'view_preview':return {view:buildViewPreview({store:this.store,ctx,template:args.template,subjectId:args.subjectId,params:args.params,viewId:args.viewId,now:new Date()})};
    }
    if(!['layout_save','draft','commit','undo_draft','cancel_draft','knowledge_ingest','heartbeat_run','speak_feedback','view_save'].includes(args.action))throw new DomainError('INVALID','未知工作台动作');
    // PRD v1.3 CH-06-2「建议、歧义和草稿留待处理」：草稿只是待处理的建议，落进收件箱等待取舍，
    // 不改变任何业务数据，因此不要求审批；真正改变业务数据的 commit 与画布布局 layout_save 仍然必须审批。
    // 收录会写入宿主知识库（另一个系统），与提交一样需要审批；审批后才有可写上下文。
    if(['layout_save','commit','knowledge_ingest','speak_feedback'].includes(args.action)){
     // 审批人必须看到自己批准的内容：提交给完整预览，布局给视口与位置。
     const detail=args.action==='commit'?this.store.preview(ctx,args.id):['layout_save','knowledge_ingest'].includes(args.action)?{action:args.action,view:args.view,revision:args.revision,viewport:args.viewport,positions:args.positions,id:args.id,baseId:args.baseId}:{action:args.action};
     const outcome=await this.approval.request({agent:exec.agent,toolName:'workstation',callId:exec.callId,signal:exec.signal,reason:JSON.stringify({workspace:ctx.workspace,operation:detail})});
     if(outcome!=='allowed-once')throw new DomainError('FORBIDDEN','工作台写入未获许可：'+outcome);
    }
    exec.signal?.throwIfAborted();
    // Resolve again after asynchronous approval: workspace may have been revoked.
    const fresh=await this.context(exec);fresh.canWrite=true;
    if(fresh.workspace!==ctx.workspace)throw new DomainError('CONFLICT','数据已经变化');
    // 主动做事（F19–F22 判定 + F24 留痕）：**不改业务数据**，只往自己的记录表写一条"这次看到了什么、
    // 为什么没打扰你"，所以按交互律 11「做事不需要理由」**不要求审批**；出声才是需要额度的那件事（批次 8）。
    // 你的回应：Agent 替你说"没必要/照做了"等于替你表态，所以走审批；界面上自己点则直接生效。
    // 保存视图：Agent 侧用同一套参数重新生成（模板+参数+引用），只落 draft、不直接 commit；
    // 是否真的进业务数据由用户在收件箱确认（18 号 §3.3）。
    if(args.action==='view_save')return previewAndSaveView({store:this.store,ctx:fresh,template:args.template,subjectId:args.subjectId,params:args.params,analysis:args.analysis,now:new Date(),source:{sessionId:exec.agent.id,callId:exec.callId}});
    if(args.action==='speak_feedback'){
     if(!this.speak)throw new DomainError('UNAVAILABLE','出声反馈尚未接入');
     return {item:this.speak.record(fresh,{kind:args.feedback,subjectId:args.subjectId??null,condition:args.condition??null}),state:this.speak.state(fresh)};
    }
    if(args.action==='heartbeat_run'){
     if(!this.heartbeat)throw new DomainError('UNAVAILABLE','主动做事的记录尚未接入');
     const previous=this.heartbeat.status(fresh,this.heartbeatTiming);
     const record=runHeartbeat({store:this.store,ctx:fresh,now:new Date(),since:previous.lastSuccessAt,
      scheduled:false,intervalMinutes:this.heartbeatTiming.intervalMinutes,
      speak:candidate=>decideLevel(candidate,{budget:this.speak?this.speak.state(fresh).budget:40,now:new Date(),
       spokenThisWeek:spokenThisWeek(this.heartbeat.list(fresh,{limit:50}).items),channelReady:false})});
     this.heartbeat.record(fresh,record);
     return {record,status:this.heartbeat.status(fresh,this.heartbeatTiming)};
    }
    if(args.action==='knowledge_ingest'){
     if(!this.knowledge?.service)throw new DomainError('UNAVAILABLE','知识服务未接入');
     if(!this.files)throw new DomainError('UNAVAILABLE','文件服务未接入');
     if(!this.knowledge.grants.some(grant=>grant.workspace===ctx.workspace&&grant.baseId===args.baseId))throw new DomainError('FORBIDDEN','该知识库未授权给当前工作区');
     const item=this.store.get(fresh,args.id);
     if(!item||item.archived||item.kind!=='artifact')throw new DomainError('INVALID','只能把资料类型的记录存进知识库');
     // 收录与写回记录是两步：先如实报告收录结果，再单独报告写回结果，不承诺原子。
     const result=await ingestFile({service:this.knowledge.service,files:this.files,ctx:fresh,grantId:item.data.fileGrantId,path:item.data.path,baseId:args.baseId});
     const staged=[{stage:'ingest',ok:true,...result}];
     try{
      const draft=this.store.draft(fresh,{title:'存进知识库 · '+(item.data.title??item.id),changes:[{op:'update',id:item.id,expectedRevision:item.revision,data:{...item.data,knowledgeBaseId:result.baseId,knowledgeDocId:result.documentId??'',knowledgeUpdatedAt:new Date().toISOString()}}],source:{sessionId:exec.agent?.id,callId:exec.callId}});
      staged.push({stage:'record',ok:true,batchId:draft.id,note:'已生成待确认的改动，同意后写进工作台'});
     }catch(error){staged.push({stage:'record',ok:false,reason:error?.message??'没能写进工作台'})}
     return {staged,available:staged.every(step=>step.ok)};
    }
    if(args.action==='layout_save')return saveLayout(this.store,fresh,args);
     if(args.action==='draft'){
     // 来源标注（用户 2026-10-17：「可以把来源记下来，最好只是 TAG」）：
     // 走 Agent 通道新建的判断，来源就是「AI 起草」；用户在界面里写的由编辑器标成「你说的」。
     // 只补 create 且没自己声明过的，绝不覆盖调用方明确给出的值。
     const changes=(args.changes??[]).map(change=>change?.op==='create'&&change?.kind==='judgment'&&change?.data&&change.data.origin===undefined
       ?{...change,data:{...change.data,origin:'ai'}}:change);
     const created=this.store.draft(fresh,{title:args.title,changes,proposal:args.proposal,source:args.id?(this.store.batch(fresh,args.id)?.source??{sessionId:exec.agent.id,callId:exec.callId}):{sessionId:exec.agent.id,callId:exec.callId}},args.id,args.revision);
     // **Agent 这条路上，非法改动就地退回**（2026-10-16 修）：
     // 实测发生过——脚本建的关系对象漏了 `title`，批次照建，落到收件箱被判「需补充/冲突」，
     // 而**用户自己改不了它**（只有创建方能补），于是他的收件箱里堆着点不动的东西。
     // 界面/其它路径保持原设计（允许"先建、由预览标出需补充"），但**Agent 不该把这种垃圾留给用户**。
     const check=this.store.preview(fresh,created.id);
     if(check.validationErrors?.length){
      const first=check.validationErrors[0];
      this.store.cancelDraft(fresh,created.id,created.revision);
      throw new DomainError('INVALID','这次改动里有不合法的内容（'+(first?.message??'格式不对')+'），已就地退回、没有留在收件箱。请补齐内容后重新生成这次改动。');
     }
     return created;
    }
    if(args.action==='cancel_draft')return this.store.cancelDraft(fresh,args.id,args.revision);
    if(args.action==='undo_draft')return this.store.undoDraft(fresh,args.key);
    // 五个口之一「对话」：对话里提交成功 = 这条输入接住了（spec/03 §13）。
    const committed=this.store.commit(fresh,{batchId:args.id,revision:args.revision,key:args.key});
    recordCommittedIntake({intake:this.intake,store:this.store,ctx:fresh,source:'chat',batchId:args.id,receipt:committed});
    return committed;
  }
}

export function toolDefinition(adapter){return {
 name:'workstation',
 description:'查询和维护当前授权工作区的项目、任务、材料、日程和变更收件箱。先读取对象版本，再生成这次改动和预览；同意只会处理用户授权的范围，并返回真实记录编号。可按模板生成只读视图：预览不写进工作台，保存只生成一条还没确认的改动。数据字段请先阅读 personal-workstation Skill。',
 parameters:{type:'object',additionalProperties:false,required:['action'],properties:{action:{type:'string',enum:['relation_candidates','assistant_context','judgment_checks','pending_checks','list','get','inbox','execution_start','execution_history','runtime_status','knowledge_bases','knowledge_search','knowledge_status','knowledge_ingest','overview','graph','node_search','layout_get','layout_save','view_preview','view_export','view_save','preview','receipt','draft','commit','undo_draft','cancel_draft','transcribe','proposal_history','heartbeat_run','heartbeat_status','speak_status','speak_feedback']},id:{type:'string'},kind:{type:'string'},status:{type:'string'},limit:{type:'integer'},offset:{type:'integer'},candidates:{type:'array',items:{type:'object',additionalProperties:true},description:'可选：还没写进工作台的候选判断（字段同判断记录：title/evidence/uncertainty/validFrom/status），用它们和既有判断先对一遍矛盾。'},
title:{type:'string'},proposal:{type:'object',additionalProperties:false,properties:{evidence:{type:'array',items:{type:'object',additionalProperties:false,required:['kind','ref','quote'],properties:{kind:{type:'string',enum:['message','file','audio','web','note']},ref:{type:'string'},quote:{type:'string'},verified:{type:'boolean'}}}},uncertainty:{type:'string'},basedOn:{type:'array',items:{type:'string'}},decision:{type:'string',enum:['undecided','accepted','rewritten','rejected']},reason:{type:'string'},decidedAt:{type:'string'}}},changes:{type:'array',items:{type:'object',additionalProperties:false,required:['op'],properties:{op:{type:'string',enum:['create','update','archive','restore','delete']},id:{type:'string'},kind:{type:'string'},expectedRevision:{type:'integer'},data:{type:'object',additionalProperties:true},fields:{type:'array',items:{type:'string'},description:'只改动这些字段（合并进旧数据，其余字段原样保留）；不传=整条替换。'},sources:{type:'object',additionalProperties:{type:'string'},description:'可选：逐字段来源说明（字段名 → 证据出处，例如 会议纪要第3段 / 用户口述 / 文件路径）。只标注本次改动且确有出处的字段；不确定就留空，不要编造。'}}}},revision:{type:'integer'},key:{type:'string'},view:{type:'string'},focus:{type:'string'},query:{type:'string'},baseId:{type:'string'},taskId:{type:'string'},projectId:{type:'string'},feedback:{type:'string',enum:['followed','noted','unnecessary','ignored','missed']},condition:{type:'string'},viewData:{type:'object',additionalProperties:true,description:'view_export 用：要导出的预览视图对象（含 content），仅生成 Markdown，不落库。'},analysis:{type:'object',additionalProperties:false,description:'view_save 用：AI 解读。只能引用 view_preview 返回的 dataRefs；summary≤600字，findings 1–8 条（每条 ref/text），uncertainty≤300字。',properties:{summary:{type:'string'},findings:{type:'array',maxItems:8,items:{type:'object',additionalProperties:false,required:['ref','text'],properties:{ref:{type:'string'},text:{type:'string'}}}},uncertainty:{type:'string'}}},subjectId:{type:'string'},template:{type:'string',enum:['risk-matrix','timeline','compare-table','blocker'],description:'生成视图的模板：risk-matrix / timeline 用于项目（subjectId=项目），blocker 用于任务（subjectId=任务），compare-table 用 params.subjectIds 传 2–3 个判断/议题。'},params:{type:'object',additionalProperties:true,description:'模板参数：risk-matrix 可给 horizonDays（1–3650，默认 90）；compare-table 必须给 subjectIds（2–3 个），可选 dimensions；timeline / blocker 不接受参数。'},viewId:{type:'string',description:'view_preview 时可选：打开保存过的视图并按当前数据重算，引用变化会标为 stale。'},executionTarget:{type:'string'},topK:{type:'integer'},grantId:{type:'string'},path:{type:'string'},language:{type:'string'},includeArchived:{type:'boolean'},positions:{type:'object'},viewport:{type:'object'},roleColors:{type:'object'},roleShapes:{type:'object'},order:{type:'array',items:{type:'string'}}}},
 output:{schema:{type:'object',additionalProperties:true},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},
 // knowledge_ingest 会导入文件并生成草稿，与会话内其它写操作共享同一对象，不算并发安全。
  isConcurrencySafe:args=>['relation_candidates','assistant_context','judgment_checks','pending_checks','list','get','inbox','proposal_history','execution_history','runtime_status','knowledge_bases','knowledge_search','knowledge_status','overview','graph','node_search','layout_get','view_preview','preview','receipt','heartbeat_status','speak_status'].includes(args?.action),
 execute:(args,exec)=>adapter.run(args,exec),
};}
