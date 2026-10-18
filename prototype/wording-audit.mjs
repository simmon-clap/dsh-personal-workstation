#!/usr/bin/env node
/** 文案门禁：界面上不许出现内部术语。
 *
 *  起因（用户 2026-10-12）：收件箱里写「批次 / 草稿 / 差异 / 提交 / 修订」，
 *  用户不知道"什么叫改动化"、"我需要同意什么"。术语泄漏不是个别页面问题，
 *  所以做成扫描全站的闸门，而不是逐个手改。
 *
 *  做法：先剥掉注释与代码，只留**字符串字面量与模板文本**，再查黑名单词。
 *  用法：node prototype/wording-audit.mjs（已接入 npm run verify） */

import {readFileSync,readdirSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=join(dirname(fileURLToPath(import.meta.url)),'..');
/** 工具/验证脚本不是界面，里面的字符串是断言与词表，不能当文案扫描或改写。 */
const TOOLS=['build-v7.mjs','extract-v7.mjs','pixel-diff.mjs','pixel-diff-apply.mjs','replica-core.mjs','diag-contrast.mjs','wording-audit.mjs','geom-diff.mjs','style-check.mjs','verify-v7.mjs','form-metrics.mjs','layout-metrics.mjs','preview-check.mjs','control-audit.mjs','dialog-audit.mjs','canvas-suggestion-check.mjs','private-data-guard.mjs','control-state-audit.mjs','live-acceptance.mjs','real-data-check.mjs','mobile-real-check.mjs','audio-seek-check.mjs','agent-swap-check.mjs','accept.mjs','live-visual-audit.mjs','release-check.mjs','field-propagation.mjs','pixel-diff-report.mjs','visual-seed.mjs','charter-guard.mjs','interaction-audit.mjs','judgment-browser-check.mjs','pages-screenshots.mjs','advice-browser-check.mjs','space-color-check.mjs','export-browser-check.mjs','status-audit.mjs','prototype-conversion-check.mjs','audit-fs-port.mjs','build-shell.mjs','structure-diff.mjs','visual-check.mjs','shell-tokenize.mjs','shell-convert-compare.mjs','visual-tokenize-compare.mjs','activation-replay.mjs','data-palette.mjs','heartbeat-browser-check.mjs','css-var-audit.mjs','type-scale-audit.mjs','user-view-audit.mjs','reference-create-check.mjs','craft-audit.mjs','mobile-audit.mjs','measure-page.mjs','live-entry-check.mjs','field-relevance-audit.mjs','human-time.mjs','charter-ux-audit.mjs','spec-coverage-audit.mjs','motion-audit.mjs','semantic-gates.mjs','semantic-checks.mjs','live-target.mjs','baseline-capture.mjs','public-repo-check.mjs','clean-install-check.mjs','w5-real-paths.mjs','c7-simulation.mjs'];

/** 内部术语 → 用户看得懂的说法。left 是禁止出现在界面上的词。 */
const TERMS=[
 // 收件箱 / 变更流程
 ['草稿','还没确认的改动'],['一批改动','这次改动'],
 ['批次','这次改动 / 这一组改动'],['提交','同意'],['回执','改动记录（撤销用）'],
 ['幂等','（内部概念）'],['修订','（内部版本号）'],
 // 技术黑话
 ['差异','改动'],['落库','写进工作台'],['拓扑','关联结构'],
 ['实体','记录'],['元数据','（内部概念）'],['校验','检查'],['约束','规则'],
 ['归一化','统一格式'],['乐观并发','（内部概念）'],['引用完整性','引用检查'],
 ['快照','当时的副本'],['阈值','界线'],['分页','翻页'],['语义','含义'],
 ['收敛','稳定下来'],['写回','保存回'],['调度','安排执行'],['编排','安排'],
 ['解析器','读取器'],['序列化','保存格式'],['反序列化','读取格式'],
 ['协议','（内部约定）'],['接口','（内部约定）'],
 // 知识与检索
 ['收录','存进知识库'],['核验','核对来源'],['召回','找到'],['索引','检索'],
 ['分块','切分'],['持久化','长期保存'],
 // 2026-10-13 依据「纸上秩序」VI 与宪章第四条新增：这些词是设计过程中我自己造的概念，
 // 不该出现在界面上（registry.uiVocabulary.forbidden 必须被本表完全覆盖，charter-guard 会核对）。
 ['倒推链','为什么这么建议'],['可倒推','可追问'],
 ['契合度','最近的建议你采纳了多少'],['时效','什么时候成立'],
 ['能力域','（文档用词，不进界面）'],['结论流','（文档用词，不进界面）'],
 ['生命周期','（文档用词，不进界面）'],['分享边界','仅自己 / 可以给同事看'],
 ['乐观 UI','无回执的假成功'],
];
/** 允许保留的地方：产品里已经在用、用户能懂的说法，或必须精确的技术标识。 */
const ALLOW=[
 /^#/,                       // 代码/选择器
 /data-[a-z-]+/,
 /application\/|text\/markdown|image\/|audio\//,
 /localStorage|JSON|HTTP|API|URL|DSH|UUID|ICS|PDF|CSV|Markdown|mnemon|sherpa|SenseVoice|Univer|Excel|Word|PPT/,
 /--ws-|--md-|aria-|role=|class=|id=|data-/,
];

function stripComments(source){
 return source
  .replace(/\/\*[\s\S]*?\*\//g,'')
  .split('\n').map(line=>line.replace(/(^|[^:'"\\])\/\/.*$/,'$1')).join('\n');
}
/** 提取字符串字面量与模板里的文本（只在这些里面查术语）。 */
function literals(source){
 const out=[];
 for(const match of source.matchAll(/'([^'\\\n]*(?:\\.[^'\\\n]*)*)'|"([^"\\\n]*(?:\\.[^"\\\n]*)*)"|`([^`]*)`/g)){
  const text=match[1]??match[2]??match[3]??'';
  if(/[\u4e00-\u9fa5]/.test(text))out.push(text);
 }
 return out;
}
// 界面 + 宿主侧：src/ 里的通知文案、失败原因也会显示给用户（Agent 的回答里）。
const files=[
 ...readdirSync(join(root,'prototype')).filter(name=>name.endsWith('.mjs')&&!TOOLS.includes(name)).map(name=>['prototype',name]),
 ...readdirSync(join(root,'src')).filter(name=>name.endsWith('.mjs')).map(name=>['src',name]),
];

// 自检：注入一个必然被命中的假术语，确认门禁真的会报（防止它变成永远通过的摆设）。
const selfTest=process.argv.includes('--self-test');
if(selfTest)TERMS.push(['__自检假术语__','（自检用）']);

const problems=[];
for(const [dir,file] of files){
 const source=stripComments(readFileSync(join(root,dir,file),'utf8'));
 const texts=selfTest&&dir==='prototype'&&file==='inbox.mjs'?[...literals(source),'这里故意放一个 __自检假术语__ 看看门禁报不报']:literals(source);
 for(const text of texts){
  if(ALLOW.some(rule=>rule.test(text)))continue;
  for(const [term,plain] of TERMS){
   if(text.includes(term))problems.push({file,term,plain,text:text.slice(0,90)});
  }
 }
}
if(selfTest){
 const detected=problems.some(problem=>problem.term==='__自检假术语__'||problem.text.includes('__自检假术语__'));
 console.log(detected?'PASS: 自检通过（门禁能发现新冒出来的术语）':'FAIL: 自检未通过——注入的假术语没有被发现，门禁没有生效');
 process.exit(detected?0:1);
}
if(problems.length){
 console.log(`FAIL: 界面文案里有 ${problems.length} 处内部术语（用户看不懂）：`);
 const grouped=new Map();
 for(const problem of problems){if(!grouped.has(problem.term))grouped.set(problem.term,[]);grouped.get(problem.term).push(problem)}
 for(const [term,list] of grouped){
  console.log(`  · 「${term}」（建议改成：${list[0].plain}）× ${list.length} 处`);
  for(const item of list.slice(0,4))console.log(`      ${item.file}: ${item.text}`);
  if(list.length>4)console.log(`      …还有 ${list.length-4} 处`);
 }
 process.exit(1);
}
console.log(`PASS: 全站界面文案没有内部术语（扫描 ${files.length} 个模块、${TERMS.length} 个词）。`);
