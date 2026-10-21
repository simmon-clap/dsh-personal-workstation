import {readFileSync,writeFileSync,mkdirSync,copyFileSync,readdirSync,statSync,unlinkSync,existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve,join,relative} from 'node:path';
import {buildShell} from './build-shell.mjs';
import {PRESETS,tokenizeShell} from './shell-tokenize.mjs';
import {dataPaletteCss} from './data-palette.mjs';

const here=fileURLToPath(new URL('./',import.meta.url));
const worktree=fileURLToPath(new URL('./frozen/workbench-v7.html',import.meta.url));
const workstation=fileURLToPath(new URL('../',import.meta.url));
const design=fileURLToPath(new URL('../design-system/',import.meta.url));

// Only production modules ship. Demo scripts, the V7 extractor and the verifier must never be served.
// Shared client-safe modules are copied from src/ and their specifiers rewritten so the served graph is self-contained.
export const plan=[
 ...['appearance-v8.mjs','command-palette.mjs','loading.mjs','pending-badge.mjs','vi-select.mjs','ref-labels.mjs','v7-controller-v6.mjs','api.mjs','navigation.mjs','modal.mjs','card.mjs','batch.mjs','editor.mjs','inbox.mjs','ecosystem-layout.mjs','space-view-v5.mjs','judgment-export.mjs','files.mjs','download.mjs','empty-state.mjs','knowledge-search.mjs','find.mjs','apple-calendar-view.mjs','event-model.mjs','preview-types.mjs','human-title.mjs','calendar-view.mjs','knowledge-view-v2.mjs','generated-view-v2.mjs','overview-view.mjs','human-time.mjs','inline-edit.mjs','record-detail.mjs','project-data.mjs','project-detail.mjs','project-populated.mjs','project-render.mjs','project-roadmap.mjs','project-view.mjs','projects-controller.mjs','task-detail.mjs','status-vocab.mjs','task-render.mjs','task-view.mjs','intake.mjs','markdown.mjs','directory-browser.mjs'].map(name=>({name,source:join(here,name)})),
 {name:'app.mjs',source:join(here,'app-v12.mjs')},

 {name:'validation.mjs',source:join(workstation,'src/validation.mjs')},
 // 生成视图 v1 的契约校验（validation.mjs 会 import 它）：浏览器侧也要能解析，所以随 v7 一起发布。
 {name:'view-spec.mjs',source:join(workstation,'src/view-spec.mjs')}
];
// 「纸上秩序」VI：变量与覆盖样式，以及图标/简笔画资源。CSS 里的相对资源路径要求 assets/ 与样式同级。
export const designPlan=[
 {name:'tokens.css',source:join(design,'tokens.css')},
 // 纸上玻璃 v1.0 扩展 token（渐变/色板/材质变量），与工作台 VI 同源。
 {name:'paper-glass-tokens.css',source:join(design,'paper-glass/tokens.css')},
 // 数据调色板：逐项目/伙伴配色（算数据，不算界面配色）。由 prototype/data-palette.mjs 生成，
 // 登记在 spec/registry.json 的 dataPalette；要改色改那张表，不要手改这里。
 // 宿主主题映射层（VI §12）：把 --ws-* 接到 --dsw-alias-* 上，宿主在就跟随宿主主题。
 // 放最前：后面几层（data/visual/dark/contrast/workbench）都建立在 --ws-* 之上。
 {name:'v7-host-theme.css',source:join(design,'v7-host-theme.css')},
 {name:'v7-data.css',source:join(here,'data-palette.css')},
 {name:'v7-visual.css',source:join(design,'v7-visual.css')},
 // 深色层由本仓库维护：VI 只提供深色变量，没有应用层深色变体。
 {name:'v7-dark.css',source:join(here,'v7-dark.css')},
 // 对比度修正层：覆盖原型内联颜色，保证 VI 第 9 条成立。
 {name:'v7-contrast.css',source:join(here,'v7-contrast.css')},
 // 工作台修正层：手册要求但两层参考实现都缺的版面规则（两行截断、等宽数字）。
 {name:'v7-workbench.css',source:join(here,'v7-workbench.css')},
 // 纸上玻璃接入层：必须在最后，负责极光背景/玻璃导航/渐变主按钮/生成视图视觉。
 {name:'v7-paper-glass-v26.css',source:join(here,'v7-paper-glass-v26.css')}
];
export const assetDirectories=['assets/icons','assets/illustrations','assets'];
const rewrites=[['../src/validation.mjs','./validation.mjs']];
export const modules=plan.map(entry=>entry.name);

function emitted(entry){
 let text=readFileSync(entry.source,'utf8');
 for(const [from,to]of rewrites)text=text.split("'"+from+"'").join("'"+to+"'");
 for(const match of text.matchAll(/from\s+'([^']+)'/g))if(!/^\.\/[a-z0-9-]+\.mjs$/.test(match[1]))throw Error(entry.name+' 仍引用不可发布路径 '+match[1]);
 return text;
}
function assets(){
 const files=[];
 for(const directory of assetDirectories){
  const root=join(design,directory);let entries;try{entries=readdirSync(root)}catch{continue}
  for(const name of entries){const full=join(root,name);if(!statSync(full).isFile())continue;files.push({name:relative(design,full),source:full})}
 }
 return files;
}
export const designAssets=assets().map(entry=>entry.name);

export function buildV7({shell,modules:directory}){
 // 每次构建清掉上一版遗留的模块/CSS：版本化文件名会换名，旧产物不清就会混进发布包和门禁。
 if(existsSync(directory)){
  const keep=new Set([...plan.map(entry=>entry.name),...designPlan.map(entry=>entry.name),...designAssets]);
  for(const name of readdirSync(directory)){
   const full=join(directory,name);
   if(statSync(full).isDirectory())continue;
   if(!keep.has(name)&&/\.(mjs|css|html|json)$/.test(name))unlinkSync(full);
  }
 }
 // 数据调色板是生成物：每次构建重写，避免手改产物。
 writeFileSync(join(here,'data-palette.css'),dataPaletteCss());
 // 生成期收敛（批次 5）：冻结原型一个字不动，转换只发生在产物里。
 // 1) 原型内联字面值 → VI token（实测六页像素差 ≤0.12%）；
 // 2) 标尺外的间距/字号 → **同值变量**（值完全不变，零重排），定义放进 `:root` 变量层。
 const {html:tokens,report,layer,definitions}=tokenizeShell(buildShell(readFileSync(worktree,'utf8')),PRESETS.exact);
 const html=layer.trim()?tokens.replace('</head>','<style data-v7="proto-exact">'+layer+'</style></head>'):tokens;
 // 产物自检：转换必须真的清掉字面值，否则宁可直接构建失败（不要让债务静默回归）。
 const style=[...html.matchAll(/<style[^>]*data-v7="proto-exact"[^>]*>([\s\S]*?)<\/style>/g)].map(m=>m[1]).join('\n');
 const body=html.replace(/<style[^>]*data-v7="proto-exact"[^>]*>[\s\S]*?<\/style>/g,'');
 const hexLeft=(body.match(/#[0-9a-fA-F]{3,8}\b/g)??[]).length;
 if(hexLeft)throw Error('外壳仍有 '+hexLeft+' 处字面色值，生成期收敛未覆盖（首个：'+body.match(/#[0-9a-fA-F]{3,8}\b/)[0]+'）');
 // 生成期收敛（B1/B3 收口）：冻结外壳里 `.drawer` 的旧宽度 510px 是**死声明**——同一个元素随后
 // 被 760px 的规则覆盖，渲染值一直是 760（dialog-audit/S7 实测）。冻结原型不改，只在生成物里
 // 把这条旧声明收敛成 760，让「详情弹窗只有一个宽度」在产物里也成立（spec/56 §2 / spec/54 §4）。
 const converged=html.includes('width:510px')?html.replace('width:510px','width:760px'):html;
 writeFileSync(shell,converged);
 mkdirSync(directory,{recursive:true});
 for(const entry of plan)writeFileSync(join(directory,entry.name),emitted(entry));
 for(const entry of designPlan)copyFileSync(entry.source,join(directory,entry.name));
 for(const entry of assets()){const target=join(directory,entry.name);mkdirSync(join(target,'..'),{recursive:true});copyFileSync(entry.source,target)}
 return {shell,modules:[...modules],design:[...designPlan.map(entry=>entry.name),...designAssets],tokenize:{colors:Object.keys(report.colors).length,spacing:Object.keys(report.spacing).length,fontSize:Object.keys(report.fontSize).length,alpha:Object.keys(report.alpha).length,definitions:Object.keys(definitions).length}};
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===resolve(process.argv[1])){
 const written=buildV7({shell:fileURLToPath(new URL('../src/v7-shell.html',import.meta.url)),modules:fileURLToPath(new URL('../src/v7/',import.meta.url))});
 console.log('Generated '+written.shell+' · '+written.modules.length+' modules · '+written.design.length+' VI files. Not published.');
}
