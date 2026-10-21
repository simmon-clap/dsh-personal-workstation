import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';

const directory=fileURLToPath(new URL('../src/v7/',import.meta.url));
const sources=readdirSync(directory).filter(name=>name.endsWith('.mjs')).map(name=>[name,readFileSync(join(directory,name),'utf8')]);
// Actions the V7 UI deliberately does not call, with the reason it is not a capability loss.
const intentional=new Map([
 ['receipt','已提交待确认的改动的记录编号随 preview 返回，收件箱据此显示与撤销，无需单独读取'],
 ['schedule_list','W1 P0-1：设置页删掉「定时与提醒」展示——那是实验包「自动化任务」，不是心跳定时；心跳定时由 heartbeat_status 唯一来源负责。API 保留，界面不再调用。'],
 // P1 收件本（spec/55）：先做后台与 API，界面在 P4 才接。这不是能力缺失，是**按批次顺序还没做到**。
 // P4 接上界面时把这几条从例外里删掉（删掉后门禁会因为"有入口"而自然通过；若忘了接线，它会继续红）。
 ['intake_summary','P1 只做后台：收件本已能记账，界面（收件箱分组）排在 P4；P4 接线后删掉本条'],
 ['intake_list','同上：P1 后台已就绪，界面在 P4'],
 ['intake_open','同上：P1 后台已就绪，界面在 P4'],
 ['intake_assign','同上：P1 后台已就绪，界面在 P4'],
 // P2 着落本同样先后台，界面在 P4（收件箱里"这件事去哪了"的分组）接。
 ['loop_close','P2 只做后台：着落本已能记终态，界面排在 P4；P4 接线后删掉本条'],
 ['loop_list','同上：P2 后台已就绪，界面在 P4'],
 ['loop_sweep','同上：P2 后台已就绪，界面在 P4'],
]);
test('every server action the legacy UI used has a V7 entry or a recorded reason',()=>{
 const api=readFileSync(new URL('../src/browser-api.mjs',import.meta.url),'utf8');
 const actions=[...api.matchAll(/case '([a-z_]+)':/g)].map(match=>match[1]);
 assert(actions.length>=20,'应能列出服务端动作清单');
 const missing=[];
 for(const action of actions){
  const used=sources.some(([,source])=>source.includes("'"+action+"'")||source.includes('"'+action+'"'));
  if(!used&&!intentional.has(action))missing.push(action);
 }
 assert.deepEqual(missing,[],'以下服务端动作在 V7 既没有入口也没有记录原因：'+missing.join('、'));
 for(const action of intentional.keys())assert(actions.includes(action),'已记录的例外应仍然存在：'+action);
});
test('V7 keeps the legacy feature entries reachable',()=>{
 const controller=sources.find(([name])=>name==='v7-controller-v6.mjs')[1];
 const expect={
  '新建入口':/editor\.menu\(\)/,
  '编辑与归档':/editor\.open\(kind,item\)/,
  '待确认的改动预览与提交':/batch\.draft|createBatchFlow/,
  '收件箱':/inbox\.render\(root\)|renderInbox/,
  '空间与设置':/inbox\.openSettings\(\)/,
  '总览待确认计数':/send\('overview'\)/,
  '浏览器登录':/browser-login/,
  '文件读取与保存':/files\.openFile\(\)/,
  '知识检索':/knowledgeSearch\.open\(/,
  '关联空间画布':/mountSpace/,
  '总览/项目/任务/知识/日程挂载':/mountOverview|mountProjectViews|mountTaskViews|mountKnowledge|mountPersonal/,
 };
 for(const [label,pattern]of Object.entries(expect))assert.match(controller,pattern,label+'入口缺失');
 // 运行状态已并入「空间与设置」，入口必须仍然可达，且要显示实测到的接入状态。
 const inboxSource=sources.find(([name])=>name==='inbox.mjs')[1];
 assert.match(inboxSource,/send\('runtime_status'\)/,'运行状态入口缺失');
 assert.match(inboxSource,/接入状态/,'设置里必须显示接入状态而不是一句话提示');
 const taskDetail=sources.find(([name])=>name==='task-detail.mjs')[1];
 assert.match(taskDetail,/execution_history/,'任务执行历史入口缺失');
 const recordDetail=sources.find(([name])=>name==='record-detail.mjs')[1];
 assert.match(recordDetail,/calendar_export/,'日程导出入口缺失');
});
test('V7 never ships demonstration records or a model claim it cannot back',()=>{
 for(const [name,source]of sources){
  // 注释里会引用原型的演示文案用于说明（例如"原型显示…"），那不是发布的数据，先剥掉注释。
  const code=source.replace(/\/\*[\s\S]*?\*\//g,'').replace(/^\s*\/\/.*$/gm,'');
  assert.doesNotMatch(code,/伙伴 A|伙伴 B|联合验证方案交流|示例资料|示例日程|演示输入已收到/,name+' 含演示内容');
 }
 const controller=sources.find(([name])=>name==='v7-controller-v6.mjs')[1];
 assert.match(controller,/在工作台里不调用模型|不内置模型输入/,'缺少未接入能力的如实说明（工作台不调用模型，只把人送回 DSH 对话）');
 assert.doesNotMatch(controller,/自动确认关系|AI 已生成/,'不得声称未实现的模型能力');
});
