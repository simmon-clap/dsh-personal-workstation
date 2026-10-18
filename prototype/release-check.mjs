import {execFileSync} from 'node:child_process';
import {existsSync,mkdtempSync,readFileSync,readdirSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,relative,resolve,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

/** 发布包完整性检查：验证**真正会被安装的 tarball**，而不只是源码树。
 *  源码测试通过、但包内漏发模块，只有重启后才会发现——那正好浪费用户的时间。 */

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');

function walk(directory,base=directory){
 const out=[];
 for(const entry of readdirSync(directory)){
  const full=join(directory,entry);
  if(statSync(full).isDirectory())out.push(...walk(full,base));
  else out.push(relative(base,full));
 }
 return out;
}

/** 收集一个模块图里所有相对导入是否都能在包内找到。 */
function missingImports(files,{root}){
 const present=new Set(files);
 const missing=[];
 for(const file of files){
  if(!file.endsWith('.mjs'))continue;
  const body=readFileSync(join(root,file),'utf8');
  for(const match of body.matchAll(/(?:from|import)\s*\(?\s*["'](\.[^"']+)["']/g)){
   const specifier=match[1];
   const target=resolve(dirname(join(root,file)),specifier);
   const rel=relative(root,target);
   if(!present.has(rel))missing.push({file,specifier,resolved:rel});
  }
 }
 return missing;
}

export function runReleaseCheck({tarball}={}){
 const manifest=JSON.parse(readFileSync(join(root,'package.json'),'utf8'));
 // 过期检测（第 14 轮踩到）：verify 链原来不打包，release-check 会拿一个几小时前的旧包报「自洽」——
 // 那道绿灯测的不是当前代码。包必须比 src/ 与 package.json 都新。
 const newestSource=(()=>{
  let newest=0;
  const walkTimes=directory=>{
   for(const entry of readdirSync(directory)){
    const full=join(directory,entry);
    if(statSync(full).isDirectory()){walkTimes(full);continue}
    newest=Math.max(newest,statSync(full).mtimeMs);
   }
  };
  walkTimes(join(root,'src'));
  walkTimes(join(root,'client'));
  newest=Math.max(newest,statSync(join(root,'package.json')).mtimeMs);
  return newest;
 })();
 const archive=tarball??join(root,'releases',`${manifest.name}-${manifest.version}.tgz`);
 const findings={archive,version:manifest.version,problems:[]};
 if(!existsSync(archive)){
  findings.problems.push('找不到发布包：'+archive+'（请先运行 pnpm pack --pack-destination releases，且版本应与 package.json 一致）');
  }else if(statSync(archive).mtimeMs<newestSource){
   findings.problems.push('发布包比源码旧（'+archive+'）：这道检查测的是旧包；请先打包（npm run verify 现已自带打包）');
  findings.passed=false;
  return findings;
 }
 const workdir=mkdtempSync(join(tmpdir(),'workstation-release-'));
 try{
  try{execFileSync('tar',['-xzf',archive,'-C',workdir],{stdio:'pipe'})}
  catch(error){
   findings.problems.push('无法解开发布包（不是有效的 tar.gz？）：'+(error?.stderr?.toString?.().trim()||error?.message||'未知原因'));
   findings.passed=false;
   return findings;
  }
  const top=join(workdir,'package');
  const files=walk(top);
  findings.fileCount=files.length;
  // 1) 声明要发布的每一项都必须真的在包里；以 ! 开头的排除项必须真的不在包里
  for(const entry of manifest.files){
   if(entry.startsWith('!'))continue;
   const hit=files.some(file=>file===entry||file.startsWith(entry+'/'));
   if(!hit)findings.problems.push('声明发布但包内缺失：'+entry);
  }
  for(const entry of manifest.files.filter(item=>item.startsWith('!'))){
   const excluded=entry.slice(1);
   const leaked=files.filter(file=>file===excluded||file.startsWith(excluded+'/'));
   if(leaked.length)findings.problems.push('明确排除但仍被打包：'+excluded+'（'+leaked.length+' 个文件）');
  }
  // 2) 不得夹带源码之外的东西
  for(const forbidden of ['prototype/','test/','releases/','node_modules/','screenshots/']){
   const hit=files.filter(file=>file.startsWith(forbidden));
   if(hit.length)findings.problems.push('包内不应包含 '+forbidden+'（'+hit.length+' 个文件）');
  }
  // 3) 关键交付物与版本号一致
  const packed=JSON.parse(readFileSync(join(top,'package.json'),'utf8'));
  if(packed.version!==manifest.version)findings.problems.push('包内版本与源码不一致：'+packed.version+' ≠ '+manifest.version);
  // W4-4：发布物只带**公开文档**；内部账本/审计/设计文档不进包。
  for(const name of ['README.md','CHANGELOG.md','LICENSE']){
   if(!files.includes(name)){findings.problems.push('缺少交付文档：'+name);continue}
   const body=readFileSync(join(top,name),'utf8');
   if(name==='CHANGELOG.md'&&!body.includes(manifest.version))findings.problems.push('CHANGELOG 未包含当前版本 '+manifest.version);
  }
  // W4-4：内部账本/审计/设计/发布说明一律不进发布物（公开文档只有 README/CHANGELOG/LICENSE）。
  const internalDocs=['验收账本.md','发布说明.md','审计-差距清单.md','功能核查-用户视角.md','弹窗与文案整改计划.md','项目总结报告.md','工作台迭代计划-v2.md','项目与知识模块设计.md','到位标准与传播矩阵.md'];
  const leakedDocs=files.filter(name=>internalDocs.includes(name));
  if(leakedDocs.length)findings.problems.push('发布物含内部文档：'+leakedDocs.join('、'));
  // 4) 插件配置必须带工作目录与工作区授权，否则装上也无法激活
  const patch=readFileSync(join(top,'cordis.patch.yml'),'utf8');
  for(const key of ['dataDirectory','allowedWorkspaces'])if(!patch.includes(key))findings.problems.push('cordis.patch.yml 缺少 '+key);
  // 5) 模块图完整：每个相对导入都能在包内解析（漏发模块会在这里暴露）
  const sources=files.filter(file=>file.startsWith('src/'));
  const missing=missingImports(sources,{root:top});
  for(const item of missing)findings.problems.push('模块图缺文件：'+item.file+' 引用 '+item.specifier+'（解析为 '+item.resolved+'）');
  findings.moduleCount=sources.filter(file=>file.endsWith('.mjs')).length;
  // 5b) 可达性：包内每个模块都必须能从**随包入口**走到。
  //     真实入口：src/index.mjs（插件入口）、src/v7/app.mjs（客户端入口，由 v7-shell.html 加载）。
  //     反例（第 14 轮实测）：9 个 *-client.mjs + files.mjs + v7/projects-controller.mjs 随包发布了，
  //     但唯一引用它们的是已被排除的 src/web-app.mjs —— 装上以后取不到，是死重量。
  {
   const modules=sources.filter(file=>file.endsWith('.mjs'));
   const present=new Set(modules);
   const graph=new Map();
   for(const file of modules){
    const body=readFileSync(join(top,file),'utf8');
    const deps=new Set();
    for(const match of body.matchAll(/(?:from|import)\s*\(?\s*["'](\.[^"']+)["']/g)){
     const target=relative(top,resolve(dirname(join(top,file)),match[1]));
     for(const candidate of [target,target+'.mjs',target+'/index.mjs'])if(present.has(candidate))deps.add(candidate);
    }
    graph.set(file,deps);
   }
   const entries=['src/index.mjs','src/v7/app.mjs'];
   const seen=new Set(),stack=[...entries];
   while(stack.length){
    const current=stack.pop();
    if(seen.has(current)||!present.has(current))continue;
    seen.add(current);
    for(const dep of graph.get(current)??[])stack.push(dep);
   }
   const dead=modules.filter(file=>!seen.has(file));
   if(dead.length)findings.problems.push('包内有走不到的模块（随包发布但取不到，属于死重量）：'+dead.join('、'));
  }
  // 6) 客户端入口必须存在且注册了两个面板
  const client=files.find(file=>file==='client/client.js');
  if(!client)findings.problems.push('缺少 client/client.js');
  else{
   const body=readFileSync(join(top,client),'utf8');
   // 客户端必须只有一个工作台入口：侧栏重复入口是用户明确指出的缺陷。
   if(!body.includes("'personal-workstation'"))findings.problems.push('客户端入口缺少面板：personal-workstation');
   if(body.includes('personal-workstation-legacy'))findings.problems.push('客户端仍注册了第二个入口：personal-workstation-legacy');
   // 一次注册里 sidebar.panellist 会出现两次（inject 与 register），因此数 inject。
   const sidebarEntries=(body.match(/inject\('sidebar\.panellist'/g)??[]).length;
   if(sidebarEntries!==1)findings.problems.push('侧栏注册了 '+sidebarEntries+' 个入口，应恰好 1 个');
  }
  findings.passed=findings.problems.length===0;
  return findings;
 }finally{
  rmSync(workdir,{recursive:true,force:true});
 }
}

// 工作区路径含非 ASCII：用 pathToFileURL 才能与 import.meta.url 正确比对。
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const findings=runReleaseCheck();
 // ── 「客户端资源 = 已装构建」门禁（A 批次要求，2026-10-16 补）───────────────────
 // 为什么必须查这一步：`release-check` 只证明"打出来的包自洽"，
 // 证明不了"**本机装着的那份 == 这一版**"。而用户反复说"你说的没实现"的根因正是这个 ——
 // 实测出现过：仓库/包/运行实例三者互不相同，门禁却全绿。
 // 判据：把**包里会装的客户端资源**（src/v7/** 与外壳）与**本机已装包**里的同名文件逐字比。
 //   · 没装 → 如实说"无法核对"（不算通过，也不冤判失败）；
 //   · 装了但不同 → FAIL，并给出下一步（install:local + 重启）。
 try{
  const installedRoot=join(process.env.HOME??'','.dsh/profiles/desktop/node_modules/dsh-personal-workstation');
  if(!existsSync(join(installedRoot,'package.json'))){
   console.log('（本机 profile 里没装这个包，跳过"已装=这一版"核对 —— 这不是通过）');
  }else{
   const installedVersion=JSON.parse(readFileSync(join(installedRoot,'package.json'),'utf8')).version;
   const repoVersion=JSON.parse(readFileSync(join(root,'package.json'),'utf8')).version;
   // **只比"真的会装进去的"文件**：package.json 的 files 里有 4 条 `!` 排除
   // （例如 !src/*-client.mjs、!src/files.mjs）—— 那些文件在仓库里有、包里故意没有，
   // 我第一次没排除，于是门禁把 13 个"故意不发"的文件当成"已装包缺文件"报了出来（假失败）。
   const NOT_SHIPPED=(JSON.parse(readFileSync(join(root,'package.json'),'utf8')).files??[])
    .filter(entry=>entry.startsWith('!')).map(entry=>entry.slice(1))
    .map(pattern=>new RegExp('^'+pattern.replace(/[.+^${}()|[\]\\]/g,'\\$&').replace(/\*\*/g,'\u0000').replace(/\*/g,'[^/]*').replace(/\u0000/g,'.*')+'$'));
   const assets=[];
   const collect=(dir,rel='')=>{
    for(const entry of readdirSync(dir,{withFileTypes:true})){
     const next=join(dir,entry.name), relNext=rel?rel+'/'+entry.name:entry.name;
     if(entry.isDirectory())collect(next,relNext);
     else if(/\.(mjs|css|html|json)$/.test(entry.name))assets.push(relNext);
    }
   };
   collect(join(root,'src'));
   const shipped=assets.filter(rel=>!NOT_SHIPPED.some(re=>re.test('src/'+rel)));
   assets.length=0; assets.push(...shipped);
   const drift=[];
   for(const rel of assets){
    const mine=join(root,'src',rel), theirs=join(installedRoot,'src',rel);
    if(!existsSync(theirs)){drift.push(rel+'（已装包里没有这个文件）');continue}
    if(!readFileSync(mine).equals(readFileSync(theirs)))drift.push(rel+'（内容不同）');
   }
   console.log('已装版本 '+installedVersion+' · 仓库版本 '+repoVersion+' · 逐字比对了 '+assets.length+' 个客户端文件');
   if(drift.length){
    findings.problems.push('已装的那份不是这一版（'+drift.length+' 个文件不同，例如 '+drift.slice(0,3).join('、')+'）—— 请 npm run install:local 并**重启**，否则用户看到的是旧实现');
    findings.passed=false;
   }else{
    console.log('PASS: 客户端资源与已装包逐字一致（"看到的 = 装的"这一步成立）。');
   }
  }
 }catch(error){
  findings.problems.push('"已装=这一版"核对本身出错：'+(error?.message??error));
  findings.passed=false;
 }
 console.log('包：'+findings.archive);
 console.log('版本 '+findings.version+' · 文件 '+findings.fileCount+' 个 · 模块 '+findings.moduleCount+' 个');
 for(const problem of findings.problems)console.log('FAIL  '+problem);
 console.log(findings.passed?'PASS: 发布包自洽（声明文件齐全、无夹带、版本一致、模块图完整、客户端入口完好）。':'FAIL: 发布包存在 '+findings.problems.length+' 处问题。');
 process.exit(findings.passed?0:1);
}
