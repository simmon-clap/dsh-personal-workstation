/**
 * 激活重放：用**用户 profile 里的真实配置** + **已安装的包**跑一遍 `apply()`。
 *
 * 为什么需要它：这个项目被"激活失败"咬过两次（1.1.0 的 execution、1.6.1 的 appleCalendar），
 * 根因都是"Config schema 声明了新键、resolveConfig 白名单没跟上"——而当时所有测试都是绿的，
 * 因为它们只测源码树，**没有一条测试用真实配置去加载真实装好的那个包**。
 *
 * 这条检查补上这个缺口：
 *   1. 从 profile 读真实配置（dataDirectory / allowedWorkspaces / fileGrants / transcribeWithoutApproval）；
 *   2. 用宿主真 schemastery 物化 Config 默认值，再与真实配置合并（DSH 的加载顺序）；
 *   3. 从 `node_modules/` 里 import **已安装的那份**（不是源码树）；
 *   4. 用最小宿主桩调用 `apply()`，断言：不抛错、工具注册成功、且工具真能跑通一次只读动作。
 *
 * 用法：node prototype/activation-replay.mjs
 * 环境变量：DSH_PROFILE_DIR 覆盖 profile 目录（默认 ~/.dsh/profiles/desktop）
 */
import {createRequire} from 'node:module';
import {existsSync,readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {homedir,tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

const profile=process.env.DSH_PROFILE_DIR??join(homedir(),'.dsh','profiles','desktop');
const installed=join(profile,'node_modules','dsh-personal-workstation');
const patch=join(profile,'cordis.patch.yml');

/** 从 profile 的 patch 层取出这个插件的真实配置（只解析我们需要的那几行，不引 YAML 依赖）。 */
function readProfileConfig(text){
 const lines=text.split('\n');
 const start=lines.findIndex(line=>/^\s*-\s*id:\s*personal-workstation\s*$/.test(line));
 if(start<0)throw Error('profile 的 patch 层里没有 personal-workstation 段');
 const config=[];
 let inside=false;
 for(let i=start+1;i<lines.length;i+=1){
  const line=lines[i];
  if(/^\s*-\s*(id|name|disabled):/.test(line))break;         // 下一个插件条目
  if(/^\s*config:\s*$/.test(line)){inside=true;continue}
  if(!inside)continue;
  if(/^\s*disabled:/.test(line))break;
  config.push(line);
 }
 return config.join('\n');
}
/** 去掉整块配置的公共缩进：解析器按"缩进 0 即顶层键"工作，块本身是从 YAML 里切出来的。 */
function dedent(text){
 const lines=text.split('\n').filter(line=>line.trim());
 const indents=lines.map(line=>line.match(/^\s*/)[0].length);
 const common=Math.min(...indents);
 return lines.map(line=>line.slice(common)).join('\n');
}
/** 极简 YAML 子集解析：够读标量、字符串数组与"对象数组"（fileGrants 那种）。 */
function parseSubset(raw){
 const text=dedent(raw);
 const root={};let current=null,listKey=null;
 for(const raw of text.split('\n')){
  if(!raw.trim()||raw.trim().startsWith('#'))continue;
  const indent=raw.match(/^\s*/)[0].length;
  const line=raw.trim();
  if(indent===0){
   const [key,...rest]=line.split(':');
   const value=rest.join(':').trim();
   current=null;
   if(value===''){root[key]=undefined;listKey=key;root[key]=[]}
   else{root[key]=value;listKey=null}
   continue;
  }
  if(listKey&&/^-\s/.test(line)){
   const item=line.replace(/^-\s*/,'');
   if(item.includes(':')){const [k,...r]=item.split(':');current={[k.trim()]:r.join(':').trim()};root[listKey].push(current)}
   else root[listKey].push(item);
   continue;
  }
  if(current&&indent>=6){
   const [key,...rest]=line.split(':');
   const value=rest.join(':').trim();
   if(value)current[key.trim()]=value;
  }
 }
 return root;
}
function unwrap(value){
 if(value&&typeof value.get==='function')return value.get();
 if(Array.isArray(value))return value.map(unwrap);
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,unwrap(v)]));
 return value;
}

if(!existsSync(installed)){console.log('SKIP: 未找到已安装的包 '+installed);process.exit(0)}
if(!existsSync(patch)){console.log('SKIP: 未找到 profile 配置 '+patch);process.exit(0)}

const userConfig=parseSubset(readProfileConfig(readFileSync(patch,'utf8')));
const installedPkg=JSON.parse(readFileSync(join(installed,'package.json'),'utf8'));
const manifest=await import(pathToFileURL(join(installed,'src','index.mjs')).href);

// 宿主真 schemastery：拿不到就退化为"用户配置直通"，并如实说明这次不是完整重放。
const require_=createRequire(join(profile,'package.json'));
let schemastery=null;
for(const id of ['@deepseek-ai/schemastery','schemastery']){try{schemastery=require_(id);break}catch{}}
const failures=[];
const check=(label,ok,detail='')=>{console.log((ok?'  PASS: ':'  FAIL: ')+label+(detail?' → '+detail:''));if(!ok)failures.push(label)};

console.log('激活重放 · 已安装包 '+installedPkg.version+' · profile '+profile);
console.log('─'.repeat(66));
check('profile 配置里有 dataDirectory',typeof userConfig.dataDirectory==='string'&&userConfig.dataDirectory.length>0,userConfig.dataDirectory);
check('profile 配置里有 allowedWorkspaces',Array.isArray(userConfig.allowedWorkspaces)&&userConfig.allowedWorkspaces.length>0,String(userConfig.allowedWorkspaces));
check('包导出了 apply / resolveConfig / Config',typeof manifest.apply==='function'&&typeof manifest.resolveConfig==='function'&&typeof manifest.Config==='function');

// 关键：**不许碰生产库**。profile 里的 dataDirectory 是真实业务数据目录，
// apply() 会打开它并跑幂等迁移（只加列）——第一次写这个脚本时正是如此，写进了生产库的 WAL。
// 所以：真实 dataDirectory 只做"存在性断言"，实际加载指向一次性临时目录。
const safeDirectory=mkdtempSync(join(tmpdir(),'workstation-activation-replay-'));
process.on('exit',()=>{try{rmSync(safeDirectory,{recursive:true,force:true})}catch{}});

// DSH 的加载顺序：先物化 schema 默认值，再叠加用户配置。
let merged={...userConfig};
if(schemastery){
 try{const {Config}=manifest;merged={...unwrap(new Config({})),...userConfig};}
 catch(error){failures.push('物化 Config 默认值失败');console.log('  FAIL: 物化 Config 默认值失败 → '+error.message)}
}else console.log('  注意: 本机拿不到 @deepseek-ai/schemastery，跳过"默认值物化"这一步（不是完整重放）');
// 除 dataDirectory 外，其余配置（工作区白名单 / 文件授权 / 转写策略）全部用 profile 真实值。
merged={...merged,dataDirectory:safeDirectory};
console.log('  加载指向临时目录（不碰生产数据）：'+safeDirectory);

let resolved=null;
try{resolved=manifest.resolveConfig(merged);check('resolveConfig 接受真实配置（含物化默认值）',true)}
catch(error){check('resolveConfig 接受真实配置（含物化默认值）',false,error.message)}

// 最小宿主桩：只提供 apply() 真正会用到的那几个面。
const registered={tools:[],skills:[],web:0,effects:0,disposers:[]};
let lastSmokeError=null;
const ctx={
 effect(fn){registered.effects+=1;const dispose=fn();if(typeof dispose==='function')registered.disposers.push(dispose)},
 // **必须带上宿主真实有的服务**：假 ctx 比真实宿主弱，会让"只在有该服务时才走到"的代码
 // 整段短路跳过 —— 于是插件在重放里"通过"，到用户机器上一启动就炸。
 // 2026-10-16 的真实教训：宿主有 `timer` 服务，而这里的 get() 一律返回 undefined，
 // 导致 `Boolean(timer)&&heartbeatMinutes>0` 短路、跨作用域引用没被求值，重放报 PASS，
 // 用户重启却得到「ReferenceError: heartbeatMinutes is not defined」。
 // 现在按宿主真实能力提供 timer 桩（只提供 apply 会用到的那两个方法形状）。
 get(name){
  // W1 P0-5：宿主真实有 pluginManager（listBundles/listPlugins）；假 ctx 不给它的话，
  // IM 四层健康那条分支会被整段跳过 —— 又是"桩比宿主弱 = 门禁比现实弱"。
  // 这里给一个可复现的夹具（插件不兼容 + 未加载），让 runtime_status 的 imHealth 真的被求值。
  if(name==='pluginManager')return {
   listBundles:async()=>[{name:'@michengai/dsh-im-connect',enabled:true,installed:true,availability:'profile',version:'0.1.68',rows:[],
    error:{code:'incompatible-version',incompatible:[{name:'@michengai/dsh-im-connect',version:'0.1.68',runtimeVersion:'0.2.1-rc.2',requirements:{'@deepseek-ai/dsh-agent':'<=0.2.0-rc.2','@deepseek-ai/dsh-client-locale':'<=0.2.0-rc.2'}}]}},
    {name:'dsh-personal-workstation',enabled:true,installed:true,availability:'profile',version:'2.6.0',rows:[]}],
   listPlugins:async()=>[{entryId:'include:personal-workstation',moduleName:'dsh-personal-workstation',fiberPhase:'active'}]
  };
  if(name==='timer')return {
   timeout(){return()=>{}},
   interval(){return()=>{}},   // 重放里不真的起定时，只要证明"这条分支被求值了、没炸"
   throttle(fn){return fn},
   debounce(fn){return fn},
  };
  return undefined;
},
 tools:{register(tool){registered.tools.push(tool);return()=>{}}},
 skills:{register(skill){registered.skills.push(skill);return()=>{}}},
 sessions:{get:()=>({header:{cwd:userConfig.dataDirectory}})},
 // 授权的工作区必须在册：工具会据此解析写入/读取范围（不靠模型自报）。
 workspaceRegistry:{list:()=>[{id:(userConfig.allowedWorkspaces??[])[0],title:'激活重放',path:userConfig.dataDirectory}],get:id=>id===(userConfig.allowedWorkspaces??[])[0]?{id,title:'激活重放',path:userConfig.dataDirectory}:null,resolveByPath:async()=>({id:(userConfig.allowedWorkspaces??[])[0]})},
 approval:{request:async()=>'denied'},
};
let applyError=null;
try{manifest.apply(ctx,merged)}catch(error){applyError=error}
check('apply() 不抛错（真实配置 + 已安装包）',!applyError,applyError?.message??'');
check('注册了 workstation 工具',registered.tools.some(tool=>tool?.name==='workstation'),registered.tools.map(tool=>tool?.name).join(','));
check('注册了 personal-workstation Skill',registered.skills.some(skill=>skill?.name==='personal-workstation'));
check('注册后能在内存库上跑通一次只读动作',await (async()=>{
 const tool=registered.tools.find(item=>item?.name==='workstation');
 if(!tool)return false;
 try{
  const result=await tool.execute({action:'runtime_status'},{agent:{id:'activation-replay'},callId:'replay',signal:new AbortController().signal});
  if(!result||typeof result!=='object')return false;
  // 只读动作必须回出真实状态（版本/工作区），不是空白对象。
  return Boolean(result.version??result.workspace??result.package);
 }catch(error){lastSmokeError=error.message;return false}
})());
if(lastSmokeError)console.log('        只读动作报错：'+lastSmokeError);
// 主动做事（批次 7）：装好的包里这个动作必须真能跑，并且**如实承认没有定时**。
check('已安装包能跑一次主动做事，且留痕如实',await (async()=>{
  const tool=registered.tools.find(item=>item?.name==='workstation');
  if(!tool){console.log('        没有 workstation 工具');return false}
  try{
   const result=await tool.execute({action:'heartbeat_run'},{agent:{id:'activation-replay'},callId:'replay-hb',signal:new AbortController().signal});
   const record=result?.record;
   if(!record){console.log('        没有返回记录：'+JSON.stringify(result).slice(0,300));return false}
   if(record.scheduled!==false){console.log('        scheduled 不是 false：'+String(record.scheduled));return false}
   if(!Array.isArray(record.silenced)||!record.silenced.length){console.log('        没有"为什么没打扰"的留痕');return false}
   if(!result.status?.lastSuccessAt){console.log('        没有上次跑成时间：'+JSON.stringify(result.status??null).slice(0,200));return false}
   return true;
  }catch(error){console.log('        主动做事抛错：'+error.message);return false}
})());

// 出声（批次 8）：装好的包里额度与反馈必须真能跑，且**不许出现"已推送"这类假话**。
check('已安装包能记账出声额度、且不说已能推送',await (async()=>{
 const tool=registered.tools.find(item=>item?.name==='workstation');
 if(!tool)return false;
 const exec={agent:{id:'activation-replay'},callId:'replay-speak',signal:new AbortController().signal};
 try{
  const before=await tool.execute({action:'speak_status'},exec);
  if(before?.state?.budget!==40){console.log('        初始额度不是 40：'+String(before?.state?.budget));return false}
  if(before.state.channel?.ready!==false||before.state.channel?.implemented!==false){console.log('        未实现发送时 channel.ready/implemented 都必须是 false');return false}
  const json=JSON.stringify(before);
  if(/已推送|已经推送/.test(json)){console.log('        出现了"已推送"这类假话');return false}
  try{
   const after=await tool.execute({action:'speak_feedback',feedback:'unnecessary',condition:'守承诺'},exec);
   if(after?.state?.budget!==30){console.log('        标"没必要"后额度不是 30：'+String(after?.state?.budget));return false}
  }catch(error){
   // Agent 替用户表态要审批：被拒是**正确**的失败方式，但要确认它不是"当成成功"。
   if(!/未获许可|FORBIDDEN/.test(error.message))throw error;
  }
  return true;
 }catch(error){console.log('        出声动作抛错：'+error.message);return false}
})());

// 清理：把 apply 注册的 disposer 跑一遍，确认拆卸不抛错（插件热重载路径）。
try{for(const dispose of registered.disposers)dispose();check('disposer 全部可安全执行',true)}
catch(error){check('disposer 全部可安全执行',false,error.message)}

console.log('─'.repeat(66));
console.log(failures.length?`FAIL: 激活重放失败 ${failures.length} 项 —— ${failures.join('；')}`:'PASS: 已安装的包能用 profile 真实配置激活（工具与 Skill 均注册成功）。');
process.exit(failures.length?1:0);
