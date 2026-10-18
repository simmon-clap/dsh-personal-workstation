import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {buildV7,modules,designPlan,designAssets} from '../prototype/build-v7.mjs';
import {httpRoute} from '../src/http-route.mjs';
import {WorkstationStore} from '../src/store.mjs';
import {published,publishedModules,publishedDesign} from '../src/v7-assets.mjs';

test('published V7 tree matches a fresh build of the reviewed prototype and design sources',()=>{
 const root=mkdtempSync(join(tmpdir(),'v7-'));
 try{
  const shell=join(root,'shell.html'),directory=join(root,'v7');
  buildV7({shell,modules:directory});
  assert.equal(readFileSync(shell,'utf8'),readFileSync(new URL('../src/v7-shell.html',import.meta.url),'utf8'),'src/v7-shell.html 与原型重建结果不一致，请重新运行 prototype/build-v7.mjs');
  const built=[];
  const walk=(base,prefix='')=>{for(const name of readdirSync(join(base,prefix))){const rel=prefix?prefix+'/'+name:name;if(readdirSync(join(base,prefix),{withFileTypes:true}).find(entry=>entry.name===name).isDirectory())walk(base,rel);else built.push(rel)}};
  walk(directory);
  assert.deepEqual(built.sort(),[...published].sort(),'src/v7 发布清单与重新构建结果不一致，请重新运行 prototype/build-v7.mjs');
  for(const name of modules)assert.equal(readFileSync(join(directory,name),'utf8'),readFileSync(new URL('../src/v7/'+name,import.meta.url),'utf8'),name+' 与已发布副本不一致，请重新运行 prototype/build-v7.mjs');
  assert.deepEqual([...publishedModules].sort(),[...modules].sort());
  assert.deepEqual([...publishedDesign].sort(),[...designPlan.map(entry=>entry.name),...designAssets].sort(),'VI 变量、覆盖样式与资源清单不一致');
 }finally{rmSync(root,{recursive:true,force:true})}
});
test('every served V7 module resolves inside the published set',()=>{
 const local=new Set(publishedModules);
 for(const name of publishedModules){
  const source=readFileSync(new URL('../src/v7/'+name,import.meta.url),'utf8');
  for(const match of source.matchAll(/from\s+'(\.[^']+)'/g)){
   const target=match[1].replace(/^\.\//,'');
   assert.match(target,/^[a-z0-9-]+\.mjs$/,name+' 引用了非模块路径 '+match[1]);
   assert.ok(local.has(target),name+' 引用了未发布的模块 '+target);
  }
 }
 const entry=readFileSync(new URL('../src/v7/app.mjs',import.meta.url),'utf8');
 assert.match(entry,/import \{mountV7\} from '\.\/v7-controller\.mjs'/);
 assert.doesNotMatch(entry,/jsdom|replica\//);
});
test('the shipped shell loads the 纸上秩序 design system and its assets are served',async()=>{
 const shell=readFileSync(new URL('../src/v7-shell.html',import.meta.url),'utf8');
 const inline=shell.indexOf('<style');
 for(const [order,href]of [['tokens','/personal-workstation/v7/tokens.css'],['visual','/personal-workstation/v7/v7-visual.css']]){
  const at=shell.indexOf('href="'+href+'"');
  assert(at>inline,order+'.css 必须在原型内联样式之后加载才能覆盖默认视觉');
  assert.match(shell.slice(at,at+120),new RegExp('data-design="'+order+'"'));
 }
 const css=readFileSync(new URL('../src/v7/v7-visual.css',import.meta.url),'utf8');
 for(const match of css.matchAll(/url\('([^']+)'\)/g))assert(publishedDesign.includes(match[1]),'VI 样式引用的资源必须一起发布：'+match[1]);
 const store=new WorkstationStore(':memory:');
 const connection={requestRejection:()=>undefined,admit:()=>({peer:{id:'u'}})};
 const invoke=async url=>{let status,headers={},body=null;const res={writeHead:(s,h)=>{status=s;headers=h??{}},end:b=>{body=b===undefined?null:b},on(){},off(){},destroyed:false,writableEnded:true};await httpRoute({store,connection,workspaceRegistry:{list:()=>[],get:()=>null},allowedWorkspaces:[]}).handler({url,method:'GET',headers:{}},res);return {status,headers,body:body?.toString()??null}};
 try{
  const styles=await invoke('/personal-workstation/v7/v7-visual.css');
  assert.equal(styles.status,200);assert.match(styles.headers['content-type'],/text\/css/);
  assert.match(styles.headers['content-security-policy'],/style-src 'self'/);
  assert.match(styles.headers['content-security-policy'],/img-src 'self'/);
  const token=await invoke('/personal-workstation/v7/tokens.css');assert.equal(token.status,200);
  const illustration=await invoke('/personal-workstation/v7/assets/illustrations/connections.svg');
  assert.equal(illustration.status,200);assert.match(illustration.headers['content-type'],/image\/svg\+xml/);
  assert.match(illustration.body,/<svg/);
  assert.equal((await invoke('/personal-workstation/v7/assets/icons/project.svg')).status,200);
 }finally{store.close()}
});
test('V7 routes serve the replica shell and modules, never the demo scripts',async()=>{
 const store=new WorkstationStore(':memory:');
 const connection={requestRejection:()=>undefined,admit:()=>({peer:{id:'u'}})};
 const invoke=async url=>{let status,headers={},body=null;const res={writeHead:(s,h)=>{status=s;headers=h??{}},end:b=>{body=b===undefined?null:b},on(){},off(){},destroyed:false,writableEnded:true};await httpRoute({store,connection,workspaceRegistry:{list:()=>[],get:()=>null},allowedWorkspaces:[]}).handler({url,method:'GET',headers:{}},res);return {status,headers,body:body?.toString()??null}};
 try{
  const shell=await invoke('/personal-workstation/v7');
  assert.equal(shell.status,200);assert.match(shell.headers['content-type'],/text\/html/);assert.match(shell.headers['content-security-policy'],/frame-ancestors 'self'/);
  assert.equal(shell.body,(await invoke('/personal-workstation/v7/')).body);
  assert.match(shell.body,/\/personal-workstation\/v7\/app\.mjs/);assert.doesNotMatch(shell.body,/<script(?![^>]*src=)[^>]*>/);
  const entry=await invoke('/personal-workstation/v7/app.mjs');assert.equal(entry.status,200);assert.match(entry.headers['content-type'],/text\/javascript/);assert.match(entry.body,/mountV7/);
  for(const name of published)assert.equal((await invoke('/personal-workstation/v7/'+name)).status,200,name);
  assert.equal((await invoke('/personal-workstation/v7/replica/core.js')).status,404);
  assert.equal((await invoke('/personal-workstation/v7/verify-v7.mjs')).status,404);
  assert.equal((await invoke('/personal-workstation/v7/build-shell.mjs')).status,404);
  assert.equal((await invoke('/personal-workstation/v7/../web-app.mjs')).status,404);
  connection.admit=()=>({rejection:401});
  assert.equal((await invoke('/personal-workstation/v7')).status,401);
  assert.equal((await invoke('/personal-workstation/v7/app.mjs')).status,401);
 }finally{store.close()}
});
test('the dark layer only uses colours from the 纸上秩序 palette',async()=>{
 const tokens=JSON.parse(readFileSync(new URL('../../design-system/tokens.json',import.meta.url),'utf8'));
 // 数据调色板（逐项目/伙伴配色）是**登记在册**的数据色，与 VI 调色板一起构成允许集合；
 // 断言的是"不许自造颜色"，不是"只许 15 色"——用户已拍板逐项目配色算数据。
 const {DATA_COLORS}=await import('../prototype/data-palette.mjs');
 const allowed=new Set([...Object.values(tokens.color),...Object.values(tokens.dark),...Object.values(DATA_COLORS)].map(value=>value.toUpperCase()));
 // 注释里会引用"被改掉的问题色值"（那是文档，不是实际用色），因此先剥注释再扫描。
 const css=['v7-dark.css','v7-contrast.css','v7-workbench.css'].map(name=>readFileSync(new URL('../src/v7/'+name,import.meta.url),'utf8')).join('\n').replace(/\/\*[\s\S]*?\*\//g,'');
 const used=new Set([...css.matchAll(/#[0-9A-Fa-f]{3,8}\b/g)].map(match=>match[0].toUpperCase()));
 const unknown=[...used].filter(value=>!allowed.has(value));
 assert.deepEqual(unknown,[],'深色层不得自造颜色；以下色值不在 VI 调色板内：'+unknown.join('、'));
 assert.match(css,/\[data-theme="dark"\]/,'深色层必须挂在 data-theme 上');
 assert.match(css,/\[data-theme="dark"\] body \.view \.gantt \.axis\{color:var\(--ws-muted\)\}/,'深色下轴标签必须改用 VI 变量（不再靠 !important 压内联值）');
 const shell=readFileSync(new URL('../src/v7-shell.html',import.meta.url),'utf8');
 assert.match(shell,/href="\/personal-workstation\/v7\/v7-dark\.css" data-design="dark"/,'外壳必须加载深色层');
});
