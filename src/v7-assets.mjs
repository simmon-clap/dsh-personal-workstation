import {readFileSync,readdirSync,statSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {join,relative} from 'node:path';

// `src/v7/` is generated from the reviewed prototype modules and the design system by
// prototype/build-v7.mjs. This module must not import prototype code: the build step needs a
// DOM plus the design sources, production does not.
const directory=fileURLToPath(new URL('./v7/',import.meta.url));
const shellFile=fileURLToPath(new URL('./v7-shell.html',import.meta.url));
export const shellPath='/personal-workstation';
const contentType={'.mjs':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.json':'application/json','.png':'image/png','.woff2':'font/woff2'};

function walk(root,base=root){
 const out=[];
 for(const name of readdirSync(root)){
  const full=join(root,name);
  if(statSync(full).isDirectory())out.push(...walk(full,base));
  else out.push(relative(base,full).split('\\').join('/'));
 }
 return out;
}

/** 把一组 [名字, 内容] 折成一个指纹。回答的是"我正在发的这份，还是磁盘上那一份吗"。 */
function fingerprintOf(entries){
 const hash=createHash('sha256');
 for(const [name,body] of entries){hash.update(name);hash.update('\0');hash.update(String(body.length));hash.update('\0');hash.update(body)}
 return hash.digest('hex');
}

/** 可测的资源索引：**加载时定格一份**（就是浏览器实际拿到的），之后能问它"磁盘变了吗"。
 *  独立成工厂是为了能在测试里用临时目录验证"陈旧检测"真的会红，而不是只在自己身上自证。 */
export function createAssetIndex(dir,shell){
 const readAll=()=>[['../v7-shell.html',readFileSync(shell)],...walk(dir).sort().map(name=>[name,readFileSync(join(dir,name))])];
 const initial=readAll();
 const fingerprint=fingerprintOf(initial);
 const bodies=new Map(initial.slice(1));
 return {
  files:[...bodies.keys()],
  bodies,
  shell:initial[0][1].toString('utf8'),
  servedFingerprint:fingerprint,
  /** 磁盘当前指纹；读不到返回 null（不猜）。 */
  currentFingerprint(){try{return fingerprintOf(readAll())}catch{return null}},
  /** true=内存里这份已过期（装了新的、需重启才生效）；false=一致；null=无法判定。 */
  stale(){const now=this.currentFingerprint();return now===null?null:now!==fingerprint},
 };
}

// ── 加载时定格：进程活着期间一直发这一份 ────────────────────────────────────────
// 2026-10-16 实测：装好的新构建不会自动生效，进程会一直发内存里这份旧的；
// 界面当时还说"与正在运行的一致"，用户因此长期看到旧界面。
const index=createAssetIndex(directory,shellFile);
export const publishedModules=index.files.filter(name=>name.endsWith('.mjs')).sort();
export const publishedDesign=index.files.filter(name=>!name.endsWith('.mjs')).sort();
export const published=[...publishedModules,...publishedDesign];

/** 正在服务的资源是否已经不是磁盘上那一份了（= 装了新的，需要重启才生效）。 */
export function servedStale(){return index.stale()}
/** 供状态接口与门禁核对：正在服务的指纹，以及磁盘当前指纹。 */
export function assetFingerprints(){const onDisk=index.currentFingerprint();return {served:index.servedFingerprint,onDisk,stale:onDisk===null?null:onDisk!==index.servedFingerprint}}

const headers=type=>({'content-type':type+'; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; frame-ancestors 'self'; base-uri 'none'"});
const typeOf=name=>contentType[name.slice(name.lastIndexOf('.'))]||'application/octet-stream';

/** V7 replica routes. Only the generated tree is exposed; demo scripts are not reachable.
 *  The replica is the default surface at /personal-workstation; the previous interface stays at /legacy for rollback. */
export function v7AssetRoutes(connection,{root=true}={}){
 const routes=[
  ...(root?[[shellPath,index.shell,'text/html'],[shellPath+'/',index.shell,'text/html']]:[]),
  ['/personal-workstation/v7',index.shell,'text/html'],['/personal-workstation/v7/',index.shell,'text/html'],
  ...[...index.bodies].map(([name,body])=>['/personal-workstation/v7/'+name,body,typeOf(name)])
 ];
 return routes.map(([path,body,type])=>({path,methods:['GET'],requestBody:'buffered',async fetch(request){const admission=connection.admit({headers:request.headers});if('rejection' in admission)return new Response('Unauthorized',{status:admission.rejection});return new Response(body,{headers:headers(type)})}}));
}
