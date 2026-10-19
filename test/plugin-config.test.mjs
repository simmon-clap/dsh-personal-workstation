import {test} from 'node:test';import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Config,schemaAvailable} from '../src/config-schema.mjs';
import {resolveConfig} from '../src/index.mjs';

const base={dataDirectory:'/tmp/workstation-data',allowedWorkspaces:['w1']};

test('the plugin declares a Config schema so DSH settings can render the fields',()=>{
 assert(Config,'必须导出 Config：DSH 的插件设置页按它渲染表单');
 const source=readFileSync(new URL('../src/config-schema.mjs',import.meta.url),'utf8');
 // 凭据必须是 secret 角色：设置页只显示"是否已填"，不会把密钥回显给客户端
 for(const field of ['mini.token','calendar.token','feishu.appSecret','dingtalk.clientSecret','ticket.token']){
  const [parent,child]=field.split('.');
  const block=new RegExp(String.raw`${parent}:[\s\S]{0,400}?${child}:[\s\S]{0,80}?role\(`).test(source);
  assert(block,'凭据字段必须标 role(\'secret\')：'+field);
 }
 // 源码树没有宿主的 schemastery 时优雅降级，插件仍能加载
 assert.equal(typeof schemaAvailable,'boolean');
});

test('integration credentials are optional, trimmed, and unknown keys are refused',()=>{
 const resolved=resolveConfig({...base,mini:{endpoint:' http://mini.local:8787 ',token:' t '},feishu:{appId:'cli_x'}});
 assert.deepEqual(resolved.integrations.mini,{endpoint:'http://mini.local:8787',token:'t'},'两端空格必须去掉');
 assert.deepEqual(resolved.integrations.feishu,{appId:'cli_x',appSecret:''},'没填的字段留空 = 未接入');
 assert.deepEqual(resolved.integrations.dingtalk,{clientId:'',clientSecret:''});
 assert.throws(()=>resolveConfig({...base,unknownKey:1}),/未知/);
 assert.throws(()=>resolveConfig({...base,mini:{endpoint:'x',bogus:1}}),/未知字段/);
 assert.throws(()=>resolveConfig({...base,mini:{endpoint:123}}),/必须为字符串/);
});

test('runtime status reports integrations honestly instead of implying a connection',async()=>{
 const {runtimeStatus}=await import('../src/runtime-status.mjs');
 const status=runtimeStatus(undefined,'w',undefined,undefined,{config:{integrations:{
  mini:{endpoint:'http://mini.local:8787',token:'t'},
  calendar:{provider:'',endpoint:'',token:''},
  feishu:{appId:'',appSecret:''},dingtalk:{clientId:'',clientSecret:''},ticket:{endpoint:'',token:''},
 }}});
 assert.equal(status.capabilities.integrations.mini.configured,true,'填了凭证 = 已配置');
 assert.equal(status.capabilities.integrations.mini.connected,false,'但绝不能声称已连通');
 assert.match(status.capabilities.integrations.mini.reason,/接入尚未实现/);
 assert.equal(status.capabilities.integrations.calendar.configured,false);
 assert.match(status.capabilities.integrations.calendar.reason,/插件设置/,'未配置时要指向 DSH 的插件设置');
});

test('the config DSH materializes from the schema defaults must load (regression: 1.1.0 refused to activate)',()=>{
 // DSH 按 Config schema 物化默认值：未配置的执行器是 {enabled:false,provider:'',tools:[]}，
 // 集成项全为空字符串、授权数组为空。以前把空 provider 当非法值 → 插件激活失败。
 const materialized={
  ...base,
  execution:{enabled:false,provider:'',tools:[]},
  transcribeWithoutApproval:false,
  fileGrants:[],knowledgeGrants:[],
  mini:{endpoint:'',token:''},calendar:{provider:'',endpoint:'',token:''},
  feishu:{appId:'',appSecret:''},dingtalk:{clientId:'',clientSecret:''},ticket:{endpoint:'',token:''},
 };
 const resolved=resolveConfig(materialized);
 assert.equal(resolved.execution.enabled,false);
 assert.equal(resolved.execution.provider,'');
 assert.deepEqual(resolved.execution.tools,[]);
 // 真的启用执行时，仍然必须给提供方与工具范围
 assert.throws(()=>resolveConfig({...materialized,execution:{enabled:true,provider:'',tools:[]}}),/必须指定提供方/);
 // 启用时允许空工具列表（既有测试锁定的语义：由执行器自身的工具过滤决定范围）
 resolveConfig({...materialized,execution:{enabled:true,provider:'local',tools:[]}});
 // 但工具不是数组、含通配符或重复时仍然拒绝
 assert.throws(()=>resolveConfig({...materialized,execution:{enabled:true,provider:'local',tools:'all'}}),/必须指定提供方/);
 assert.throws(()=>resolveConfig({...materialized,execution:{enabled:false,provider:'local',tools:['*']}}),/工具范围无效/);
 assert.throws(()=>resolveConfig({...materialized,execution:{enabled:false,provider:'local',tools:['a','a']}}),/工具范围无效/);
 resolveConfig({...materialized,execution:{enabled:true,provider:'local',tools:['workstation']}});
});

test('the credential fields are marked volatile so DSH settings actually renders them',()=>{
 // DSH 的设置表单只渲染 volatile 字段（dsh-settings 的 volatileForm：if(schema.meta.volatile)…）。
 // 只写 default+role('secret') 时设置页什么都不显示——1.1.2 之前就是这样，用户看到"插件设置没做"。
 const source=readFileSync(new URL('../src/config-schema.mjs',import.meta.url),'utf8');
 for(const field of ['endpoint','token','provider','appId','appSecret','clientId','clientSecret']){
  const marked=new RegExp("[A-Za-z]*"+field+":schema\\.string\\(\\)[^,}]*\\.volatile\\(\\)").test(source);
  const optional=field==='provider'||field==='endpoint'||field==='token'||field==='appId'||field==='appSecret'||field==='clientId'||field==='clientSecret';
  if(optional)assert(marked,field+' 必须标 .volatile()，否则 DSH 设置页不显示该字段');
 }
 // 结构上也要真的生效：每个接入组的叶子字段 meta.volatile 为 true
 // （真 schemastery 用 .dict；源码树缺库时的降级实现用 .shape）
 const fieldsOf=node=>node.dict??node.shape??{};
 const metaOf=node=>node.meta??(node.toJSON?node.toJSON():{});
 const groups=fieldsOf(Config);
 for(const name of ['mini','calendar','feishu','dingtalk','ticket']){
  const group=groups[name];
  assert(group,'schema 必须包含接入组：'+name);
  const leaves=Object.entries(fieldsOf(group));
  assert(leaves.length,'接入组必须至少一个字段：'+name);
  for(const [field,node] of leaves)assert.equal(metaOf(node).volatile,true,name+'.'+field+' 必须是 volatile');
 }
});

test('both runtime_status paths report the same integration state (browser and Agent tool)',async()=>{
 // 浏览器设置页与 Agent 工具是两条通道；只给一条接上 integrations，另一条就会显示成空对象（1.3.1 的实测现象）。
 const adapter=readFileSync(new URL('../src/dsh-adapter.mjs',import.meta.url),'utf8');
 assert.match(adapter,/integrations=\{}/,'适配器必须接收 integrations');
 assert.match(adapter,/config:\{integrations:this\.integrations\?\?\{\}\}/,'Agent 工具的 runtime_status 必须带上 integrations');
 const browser=readFileSync(new URL('../src/browser-api.mjs',import.meta.url),'utf8');
 assert.match(browser,/config:\{integrations\}/,'浏览器 API 的 runtime_status 也必须带上 integrations');
 const index=readFileSync(new URL('../src/index.mjs',import.meta.url),'utf8');
 assert.match(index,/const adapter=new DshAdapter\(\{integrations:resolved\.integrations/,'主程序必须把解析后的 integrations 传进适配器');
});
