/** 插件配置 schema。
 *
 *  DSH 的插件设置页按 `Config` 渲染表单，凭据字段用 `role('secret')` 标记（只显示"是否已填"，不回显）。
 *  真 schema 来自宿主的 `@deepseek-ai/schemastery`——它只存在于运行时的 profile 依赖里
 *  （插件装进 profile 的 node_modules，Node 向上查找能拿到，与 dsh-mnemon 同一套做法）。
 *  源码树与单元测试里没有这个包，因此这里**优雅降级**成同形状的普通描述对象：
 *  插件在两种环境下都能加载，绝不会因为缺少 schema 库而启动失败。 */

let z=null;
try{
 // 测试/无宿主环境可强制走降级实现，防止再出现 `schema.number is not a function` 这类缺方法崩溃。
 if(globalThis.__DSH_FORCE_CONFIG_FALLBACK__)throw new Error('forced fallback');
 ({default:z}=await import('@deepseek-ai/schemastery'))
}catch{z=null}

/** 降级实现：只需支持 default / description / role / volatile 的链式调用与形状可读。
 *  链式方法必须返回**同一个节点**（带 shape），否则 `.object({...}).description(...)` 会把 shape 丢掉
 *  —— P0-4 里"第三方环境一构建 schema 就崩/形状缺失"就是这一类。 */
function fallbackNode(kind,inner){
 const meta={kind,...(inner?{inner}:{})};
 const node={
  default(value){meta.default=value;return node},
  description(text){meta.description=text;return node},
  role(name,extra){meta.role=name;if(extra!==undefined)meta.extra=extra;return node},
  volatile(){meta.volatile=true;return node},
  toJSON(){return meta},
 };
 Object.defineProperty(node,'kind',{value:kind,enumerable:true});
 if(inner)Object.defineProperty(node,'inner',{value:inner,enumerable:true});
 return node;
}
const fallback={
 string:()=>fallbackNode('string'),
 boolean:()=>fallbackNode('boolean'),
 number:()=>fallbackNode('number'),
 array:inner=>fallbackNode('array',inner),
 object:shape=>{
  const node=fallbackNode('object');
  Object.defineProperty(node,'shape',{value:shape,enumerable:true});
  return node;
 },
};
const schema=z??fallback;

/** 工作台插件的配置：基础设施 + 外部接入（凭据留空 = 未接入）。 */
export const Config=schema.object({
 dataDirectory:schema.string().description('工作台数据目录（SQLite 与运行时授权存放处）'),
 // 用户定义的根目录（例如 /Users/example/Desktop/DSH）：业务数据全库一份，文件按项目文件夹放在它下面。
 // 工作台不再让你选工作区——根目录就是唯一入口。
 rootDirectory:schema.string().default('').volatile().description('根目录（你自己定义，例如 DSH 的目录）：工作台只认这一个根，工作区不再需要选择'),
 allowedWorkspaces:schema.array(schema.string()).default([]).description('允许的工作区 ID（界面里点授权会追加到运行时授权，不改这里）'),
 fileGrants:schema.array(schema.object({
  id:schema.string(),workspace:schema.string(),root:schema.string(),
  read:schema.boolean().default(true),write:schema.boolean().default(false),label:schema.string().default(''),
 })).default([]).description('目录授权：工作台能读/写的目录'),
 knowledgeGrants:schema.array(schema.object({
  id:schema.string(),workspace:schema.string(),baseId:schema.string(),label:schema.string().default(''),
 })).default([]).description('知识库授权'),
 execution:schema.object({
  enabled:schema.boolean().default(false),provider:schema.string().default(''),tools:schema.array(schema.string()).default([]),
 }).description('任务执行器（未配置即不启动任何后台任务）'),
 transcribeWithoutApproval:schema.boolean().default(false).description('语音转写是否免每次批准（默认每次批准）'),
 mini:schema.object({endpoint:schema.string().default('').volatile(),token:schema.string().role('secret').default('').volatile()})  .description('Mini 私人服务器：地址与令牌（留空 = 未接入）'),
 calendar:schema.object({provider:schema.string().default('').volatile(),endpoint:schema.string().default('').volatile(),token:schema.string().role('secret').default('').volatile()})  .description('外部日历：提供方、地址与令牌（留空 = 未接入）'),
 feishu:schema.object({appId:schema.string().default('').volatile(),appSecret:schema.string().role('secret').default('').volatile()})  .description('飞书开放平台应用凭证（工作台没有发送代码：填了也不会发消息；IM 渠道由 IM 助理插件管理）'),
 dingtalk:schema.object({clientId:schema.string().default('').volatile(),clientSecret:schema.string().role('secret').default('').volatile()})  .description('钉钉应用凭证（留空 = 未接入）'),
 ticket:schema.object({endpoint:schema.string().default('').volatile(),token:schema.string().role('secret').default('').volatile()})  .description('票据识别服务（留空 = 未接入；工作台不伪造识别结果）'),
 // 苹果日历：本机系统能力，不需要凭证；这里只调"同步哪些日历、同步到哪个日历、时间窗"。
 appleCalendar:schema.object({
  enabled:schema.boolean().default(true).volatile(),
  targetCalendar:schema.string().default('个人工作台').volatile().description('写入目标日历（工作台只写这一个日历）'),
  includeCalendars:schema.string().default('').volatile().description('要同步的日历（逗号分隔；留空 = 排除噪音后的全部）'),
  excludeCalendars:schema.string().default('').volatile().description('额外排除的日历（逗号分隔；默认已排除节假日/生日/Siri建议等）'),
  pastDays:schema.number().default(30).volatile().description('往前同步的天数'),
  futureDays:schema.number().default(30).volatile().description('往后同步的天数'),
 }).description('苹果日历（macOS 本机，无需凭证；首次使用需要在系统设置里允许自动化→日历）'),
 // 主动做事的**真定时**（2026-10-16 加）：默认 0 = 不自动醒（保持"只有你点它才跑"）。
 // 大于 0 时，工作台会用宿主的 `timer` 服务按这个间隔自己醒一次（DSH 在跑的时候才可能醒）。
 // 为什么默认关：它决定"什么时候会出声打扰你" —— 这属于用户拍板的事，不该由实现替他决定。
 // 真正的 24 小时常驻需要常驻节点（Mini）在线；本机 DSH 关了就不会醒，这一点在设置页如实写明。
 heartbeat:schema.object({
  intervalMinutes:schema.number().default(0).volatile().description('多久自己醒一次（分钟；0 = 不自动醒，只有手动触发）'),
 }).description('主动做事的定时（0 = 关闭；开启后按间隔自动跑一次留痕，是否出声仍按出声规则判断）'),
 // 助理后台：常驻节点判活（宪章 v1.4 第七条 · spec/13 §10）。
 // 为什么默认 false：只有**常驻节点**承担"必须在线"的承诺；笔记本/手机打开它只会制造假告警。
 assistant:schema.object({
  residentNode:schema.boolean().default(false).volatile().description('这台机器是不是常驻节点（承担"必须在线"；笔记本/手机保持关闭）'),
  beatMinutes:schema.number().default(15).volatile().description('常驻节点多久记一次心跳（分钟）'),
  anchors:schema.boolean().default(true).volatile().description('到 09:30 / 21:00 各开口一次（关掉就只在收件箱里排序，绝不主动出声）'),
  pushToIM:schema.boolean().default(true).volatile().description('开口时把那条消息推到 IM（关掉就只排在收件箱，不推送）'),
 }).description('助理后台：只有常驻节点记心跳，用来判断"它还在不在"，与是否出声无关'),
});

/** 判断 schema 是否来自宿主的真实现（供运行时状态如实说明）。 */
export const schemaAvailable=Boolean(z);
