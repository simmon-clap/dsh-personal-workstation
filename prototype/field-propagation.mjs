#!/usr/bin/env node
/** 字段传播门禁：一个字段必须在它声明的**每一个界面面**都出现，缺一个就构建失败。
 *
 *  为什么需要它：以前我只在"写进去的那几个地方"验证（校验/筛选/编辑器），
 *  用户打开界面却看不到（项目卡片没有优先级标签、DSH 设置页是空白的）。
 *  这里把"字段 × 界面"变成一张**声明表**：
 *   · 表里必须覆盖 validation.mjs 允许的**所有**字段——新加字段不声明就失败；
 *   · 每个字段声明的每个面，都必须在对应文件里真的引用该字段名。
 *
 *  用法：node prototype/field-propagation.mjs（已接入 npm run verify）
 *  退出码 0 = 全部到位；1 = 有缺口（缺哪格会逐条打印）。 */
import {readFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=join(dirname(fileURLToPath(import.meta.url)),'..');
const read=relative=>readFileSync(join(root,relative),'utf8');

/** 界面面 → 文件。一个面可以有多个文件（任一命中即算到位）。 */
const SURFACES={
 card:['prototype/project-render.mjs','prototype/task-render.mjs','prototype/knowledge-view-v2.mjs'],
 detail:['prototype/project-populated.mjs','prototype/project-detail.mjs','prototype/task-detail.mjs','prototype/record-detail.mjs'],
 editor:['prototype/editor.mjs'],
 filter:['prototype/project-view.mjs','prototype/task-view.mjs'],
 canvas:['prototype/space-view-v5.mjs','src/graph.mjs'],
 labels:['prototype/batch.mjs'],
 skill:['skills/personal-workstation/SKILL.md'],
 // 信息简报（在知识页卡片上渲染）
 source:{surfaces:['card','labels']},
 sourceUrl:{surfaces:['card','labels']},
 publishedAt:{surfaces:['card','labels']},
 fetchedAt:{surfaces:['card','labels']},
 linkStatus:{surfaces:['card','labels']},
 uncertainty:{surfaces:['card','labels']},
 // 生成视图 v1（18 号 §3）在项目/任务/知识弹窗内的区块里渲染（渲染器 prototype/generated-view.mjs）。
 generatedView:['prototype/generated-view-v2.mjs','src/v7/generated-view-v2.mjs'],
};

/** 每个字段要求在哪些面出现。理由写在注释里，避免"为了过门禁乱加"。 */
const MATRIX={
 // 通用字段：详情与批次差异必须有中文标签；编辑器/卡片看对象是否展示
 title:{surfaces:['detail','editor','labels']},
 description:{surfaces:['detail','editor','labels']},
 tags:{surfaces:['detail','labels']},
 projectId:{surfaces:['detail','editor','labels']},
 sourceRefs:{surfaces:['detail','labels']},
 // 项目
 goal:{surfaces:['detail','editor','labels']},
 stage:{surfaces:['card','detail','editor','filter','labels','skill']},
 // stageHistory 在卡片上以派生名 stageEnteredAt 显示（进入当前阶段的时间）
 stageHistory:{surfaces:['detail','labels','skill'],via:['stageEnteredAt']},
 importance:{surfaces:['card','detail','editor','filter','canvas','labels','skill']},
 urgency:{surfaces:['card','detail','editor','filter','canvas','labels','skill']},
 folder:{surfaces:['card','detail','editor','canvas','labels','skill']},
 partnerId:{surfaces:['detail','editor','filter','labels']},
 ownerId:{surfaces:['detail','editor','filter','labels']},
 startDate:{surfaces:['detail','editor','labels']},
 dueDate:{surfaces:['detail','editor','filter','labels']},
 deliverables:{surfaces:['detail','editor','labels','skill']},
 // 任务
 status:{surfaces:['card','detail','editor','labels']},
 steps:{surfaces:['card','detail','editor','labels']},
 dependsOn:{surfaces:['detail','editor','labels','skill']},
 executionTarget:{surfaces:['card','detail','editor','labels']},
 expectedOutput:{surfaces:['detail','editor','labels','skill']},
 blockedReason:{surfaces:['card','detail','editor','labels','skill']},
 deliverableId:{surfaces:['card','detail','editor','labels','skill']},
 // 材料 / 文件
 path:{surfaces:['card','detail','editor','labels','skill']},
 mime:{surfaces:['card','detail','labels']},
 fileGrantId:{surfaces:['detail','editor','labels']},
 fileVersion:{surfaces:['card','detail','labels','skill']},
 content:{surfaces:['detail','editor','labels','skill']},
 taskIds:{surfaces:['card','detail','labels','skill']},
 knowledgeBaseId:{surfaces:['detail','labels']},
 knowledgeDocId:{surfaces:['detail','labels']},
 knowledgeUpdatedAt:{surfaces:['detail','labels']},
 // 事务 / 组织 / 议题 / 关系 / 记忆 / 简报
 startDateEvent:{skip:true},
 endDate:{surfaces:['detail','editor','labels']},
 timezone:{surfaces:['detail','editor','labels']},
 location:{surfaces:['detail','editor','labels']},
 attendees:{surfaces:['detail','editor','labels','skill']},
 eventType:{surfaces:['detail','editor','labels']},
 // 外部日历同步（苹果日历）：详情要显示来源与同步时间，批次要中文标签，Agent 侧 Skill 要写清规则
 externalSource:{surfaces:['detail','labels','skill']},
 externalUid:{surfaces:['detail','labels','skill']},
 externalSyncedAt:{surfaces:['detail','labels','skill']},
 externalFingerprint:{surfaces:['detail','labels','skill']},
 organizationId:{surfaces:['detail','editor','labels']},
 email:{surfaces:['detail','editor','labels']},
 website:{surfaces:['detail','editor','labels']},
 provider:{surfaces:['detail','editor','labels']},
 reference:{surfaces:['detail','editor','labels']},
 verification:{surfaces:['detail','labels']},
 positions:{surfaces:['labels']},
 groups:{surfaces:['canvas','labels']},
 viewport:{surfaces:['labels']},
 // 关系：在画布右侧的「关系清单」里渲染（不是对象详情）
 from:{surfaces:['canvas','labels']},
 to:{surfaces:['canvas','labels']},
 evidence:{surfaces:['canvas','labels']},
 reason:{surfaces:['canvas','labels']},
 basis:{surfaces:['generatedView','canvas','labels']},
 // 信息简报（在知识页卡片上渲染）
 source:{surfaces:['card','labels']},
 sourceUrl:{surfaces:['card','labels']},
 publishedAt:{surfaces:['card','labels']},
 fetchedAt:{surfaces:['card','labels']},
 linkStatus:{surfaces:['card','labels']},
 uncertainty:{surfaces:['card','labels']},
 // 判断（宪章第三条）：什么时候成立、何时复核、推翻依据
 validFrom:{surfaces:['card','detail','editor','labels','skill']},
 share:{surfaces:['card','detail','editor','labels','skill']},
 reviewBy:{surfaces:['detail','editor','labels','skill']},
 overturnedBy:{surfaces:['detail','labels','skill']},
 // 来源（2026-10-17 用户拍板：「可以把来源记下来，最好只是 TAG」）：
 // 只出现在**详情的一枚标签**与**导出文档的一行字**里；不进卡片（避免信息更复杂的呈现），
 // 也没有手工输入（用户新建=你说的、Agent 新建=AI 起草，自动判定）。
 // 生成视图的出处条也要显示来源（AI 生成 / 由你生成 / 来源未记录）。
 origin:{surfaces:['generatedView','detail','labels','skill']},
 // 生成视图（18 号 §3）：渲染器要读到模板、对象、参数、引用、生成时间、状态与动作；
 // savedAs 只用于「转存为判断/简报」后的回执联动，不单独成面（批次差异里按标签显示）。
 template:{surfaces:['generatedView','labels']},
 analysis:{surfaces:['generatedView','labels']},
 subject:{surfaces:['generatedView','labels']},
 params:{surfaces:['generatedView','labels']},
 dataRefs:{surfaces:['generatedView','labels']},
 generatedAt:{surfaces:['generatedView','labels']},
 state:{surfaces:['generatedView','labels']},
 actions:{surfaces:['generatedView','labels']},
 savedAs:{skip:true},

};

/** 从 validation.mjs 里读出"允许的字段"全集（通用字段 + 各类字段），字段名一律归一化。 */
function allowedFields(){
 const source=read('src/validation.mjs');
 const keys=new Set();
 const common=/const common=\[([^\]]*)\]/.exec(source);
 if(!common)throw new Error('读不到 validation.mjs 的通用字段清单');
 for(const match of common[1].matchAll(/'([A-Za-z][A-Za-z0-9]*)'/g))keys.add(match[1]);
 const fields=/const fields=\{([^;]*)\};/.exec(source);
 if(!fields)throw new Error('读不到 validation.mjs 的各类字段清单');
 for(const match of fields[1].matchAll(/'([A-Za-z][A-Za-z0-9]*)'/g))keys.add(match[1]);
 return [...keys].sort();
}

// 自检：注入一个"必然缺失"的声明，确认门禁真的会报——否则它只是一段永远通过的代码。
const selfTest=process.argv.includes('--self-test');
if(selfTest)MATRIX.__selfTestMissingField__={surfaces:['detail']};

const problems=[];
const allowed=allowedFields();
// ① 声明表必须覆盖所有允许字段（新字段不声明就是缺口）
for(const field of allowed)if(!MATRIX[field])problems.push('字段 '+field+' 没有在 field-propagation 表里声明它要出现在哪些界面');
// ② 每个字段声明的每个面都必须真的引用该字段名
const cache=new Map();
for(const [field,rule] of Object.entries(MATRIX)){
 if(rule.skip)continue;
 for(const surface of rule.surfaces){
  const files=SURFACES[surface];
  if(!files){problems.push(field+' 声明了未知的界面面：'+surface);continue}
  // via：界面上显示的是派生名（例如 stageHistory → stageEnteredAt），按派生名检查同样算到位。
  const needles=[field,...(rule.via??[])];
  const hit=files.some(file=>{
   if(!cache.has(file))cache.set(file,read(file));
   const source=cache.get(file);
   return needles.some(needle=>source.includes(needle));
  });
  if(!hit)problems.push(field+' 在「'+surface+'」缺失（'+files.join(' / ')+' 都没有引用它）');
 }
}
if(selfTest){
 const detected=problems.some(problem=>problem.includes('__selfTestMissingField__'));
 console.log(detected?'PASS: 自检通过（门禁能发现缺失的界面面）':'FAIL: 自检未通过——门禁没有发现人为注入的缺口，说明它没有真正生效');
 process.exit(detected?0:1);
}
const cells=Object.values(MATRIX).filter(rule=>!rule.skip).reduce((sum,rule)=>sum+rule.surfaces.length,0);
if(problems.length){
 console.log('FAIL: 字段传播未到位（'+problems.length+' 处）：');
 for(const problem of problems)console.log('  · '+problem);
 process.exit(1);
}
console.log('PASS: '+Object.keys(MATRIX).length+' 个字段 × '+cells+' 个界面面全部到位（表覆盖 validation.mjs 的 '+allowed.length+' 个字段）。');
