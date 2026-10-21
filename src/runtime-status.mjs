import {readFileSync, statSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {assetFingerprints} from './v7-assets.mjs';
// **我正在发的这份，还是磁盘上那一份吗**。
// 2026-10-16 用户报的四个 UI 问题里有两个，根因就是"装好的构建新于运行实例"：
// 他看到的是 5 天前的客户端资源，于是出现"筛选成了两页""不对齐"这类拼接怪象。
//
// 判据必须比"内容的指纹"，不能比 mtime：
// 插件是**进程启动时加载**的，所以"已加载模块的文件时间"永远早于进程启动时间 ——
// 原来的 `builtAt > processStartedAt` 结构上恒为 false，装了新的也报"与正在运行的一致"，
// 而且打 tar 包会保留源文件 mtime，时间戳本身也不可信。现在直接问：内存里这份 == 磁盘上这份？
const assets=assetFingerprints();
const builtAt=(()=>{try{return statSync(fileURLToPath(new URL('./v7-shell.html',import.meta.url))).mtime.toISOString()}catch{return null}})();
const processStartedAt=new Date(Date.now()-process.uptime()*1000).toISOString();
const manifest=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8'));
const loadedAt=new Date().toISOString();
// 语音能力要区分「服务已加载」与「本地模型是否已准备」：首次使用会下载模型，用户应当事先知道。
function speechDetail(service){
 if(!service)return {available:false,providers:[],selection:null};
 let snapshot=null;
 try{snapshot=service.snapshot?.()??null}catch{return {available:true,providers:[],selection:null,error:'当时的副本不可用'}}
 const providers=(snapshot?.providers??[]).map(provider=>({id:provider.id??null,name:provider.name??null,phase:provider.preparation?.phase??'unknown'}));
 return {available:true,providers,selection:snapshot?.selection??null};
}
export function runtimeStatus(files,workspace,knowledge,runner,extra={}){
 // needsRestart 直接取"内存里正在发的资源 ≠ 磁盘上那份"（见文件头的理由）。
 // 服务端代码也要能判"需重启"（2026-10-16 补）：静态资源是按请求从磁盘读的，
// 而**服务端模块（store/dsh-adapter/index）是进程启动时载入内存的** ——
// 装了新包但没重启时，静态资源是新的一版、服务端行为还是旧的，界面却可能显示"一致"。
// 所以这里把"进程启动时刻"也交出去，由验收脚本跟已装包的落盘时间比（见 prototype/live-acceptance.mjs）。
 const processStartedAtIso=new Date(Date.now()-Math.round(process.uptime()*1000)).toISOString();
 const needsRestart=assets.stale;const grants=files?.grants.filter(g=>g.workspace===workspace)??[];return {build:{builtAt,processStartedAt,serverStartedAt:processStartedAtIso,needsRestart,servedFingerprint:assets.served,diskFingerprint:assets.onDisk},package:manifest.name,version:manifest.version,loadedAt,capabilities:{business:true,canvas:true,calendarExport:true,textFiles:{provider:Boolean(files),readGrants:grants.filter(g=>g.read).length,writeGrants:grants.filter(g=>g.write).length,labels:grants.filter(g=>g.read).map(grant=>grant.label||grant.id)},knowledge:{provider:!!knowledge?.service,baseGrants:knowledge?.grants.filter(g=>g.workspace===workspace).length??0,mode:'lexical'},// 外部接入：区分「没配」「配了但还没接」——绝不把"填了凭证"说成"已连通"。
 integrations:Object.fromEntries(Object.entries(extra.config?.integrations??{}).map(([name,value])=>{
  const configured=Object.values(value??{}).some(field=>typeof field==='string'&&field.length>0);
  return [name,{configured,connected:false,reason:configured?'已配置凭证，但接入尚未实现（位置已经留好）':'未配置（在 DSH 的插件设置里填）'}];
 })),
 execution:!!(runner&&!runner.shutdown.signal.aborted&&runner.executor.status().toolFilter&&runner.executor.status().provider),executionDetails:runner?{...runner.executor.status(),closed:runner.shutdown.signal.aborted}:{enabled:false}, // 本机能力（macOS 苹果日历）：**能力在**不等于"每次都成功" ——
 // 真正的成败在用时由日历页如实报（首次需要系统授权）。写死 false 是反方向的不诚实：
 // 真实库里的日程带着 externalSource=apple-calendar 与同步时间戳，说明它确实同步成功过。
 calendarSync:Boolean(extra.apple),calendarSyncNote:extra.apple?'本机能力；首次使用需要在系统设置里允许自动化→日历':'没接上，日历同步不可用',deviceSync:false,
 // 常驻节点判活（宪章 v1.4 第七条 · 17 C8 v1.1）：与"定时开了没"是两件事 ——
 // 定时回答"它会不会自己醒"，心跳回答"它最近确实醒着吗"。缺后者时，停了 55 小时也看不出来。
 assistant:extra.assistant??null,
 // 定时状态只有**一个来源**：heartbeat_status（heartbeat-store.status）。
 // 这里不再输出 capabilities.heartbeat —— 46 审计实测它结构性恒 false，与设置页并排出现就是"同一页两种相反说法"。
 officePreview:Boolean(extra.office),speechToText:Boolean(extra.speech),
 // 让界面能如实显示"Agent 转写是否需要批准"，而不是让用户自己猜。
 speechApprovalRequired:Boolean(extra.speech)&&extra.transcribeWithoutApproval!==true,speech:speechDetail(extra.speech)}};}
