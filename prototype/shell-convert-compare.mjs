/**
 * 批次 5 收敛的**受控对照**：改前（现产物）vs 改后（生成期转换）。
 *
 * 为什么必须这么做：用户要求"基线尽量不改"，而冻结原型的调色板/间距/字号与 VI token
 * 不是同一套值 —— 收敛必然带来位移。位移多大**不许估计**，必须逐页量。
 *
 * 做法：同一个真实服务（真实数据 + 真实样式层），只换 <style> 里的字面值写法，
 * 其余字节完全相同；两版各自截图，逐像素比较。
 *
 * 用法：node prototype/shell-convert-compare.mjs [conservative|balanced|strict]
 */
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {extname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {httpRoute} from '../src/http-route.mjs';
import {WorkstationStore} from '../src/store.mjs';
import {seedVisualStore} from './visual-seed.mjs';
import {PRESETS,SNAPSHOT,tokenizeShell} from './shell-tokenize.mjs';
import {puppeteer, chromeExecutable} from '../dev-deps.mjs';

const chrome=chromeExecutable();
const pages=['home','space','projects','tasks','knowledge','personal'];
const viewport={width:1440,height:940};

const shellPath=fileURLToPath(new URL('../src/v7-shell.html',import.meta.url));
const v7Root=fileURLToPath(new URL('../src/v7/',import.meta.url));

const presetName=process.argv[2]??'balanced';
const preset=PRESETS[presetName];
if(!preset)throw Error('未知强度：'+presetName+'（可选 '+Object.keys(PRESETS).join('/')+'）');

const original=readFileSync(shellPath,'utf8');
let {html:converted,report,layer}=tokenizeShell(original,preset);
// 同值变量层：作为最外层样式放进 <head> 末尾（变量定义与顺序无关），保证 shell 与主题层都能取到。
if(layer.trim())converted=converted.replace('</head>','<style data-v7="proto-exact">'+layer+'</style></head>');

const count=(text,re)=>[...text.matchAll(re)].length;
const debt=(html)=>{
 const css=[...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(m=>m[1]).join('\n');
 const colors=(css.match(/#[0-9a-fA-F]{3,8}\b/g)??[]).length;
 let spacing=0;for(const d of css.matchAll(/\b(padding|margin|gap)(?:-[a-z]+)?\s*:\s*([^;{}"'\n]+)/g))
  for(const n of d[2].matchAll(/(\d+(?:\.\d+)?)px/g))if(!SNAPSHOT.SPACING_SCALE.includes(Number(n[1])))spacing++;
 const font=(css.match(/font-size\s*:\s*(\d+(?:\.\d+)?)px/g)??[]).filter(m=>!SNAPSHOT.TYPE_SCALE.includes(Number(/(\d+(?:\.\d+)?)px/.exec(m)[1]))).length;
 return {colors,spacing,font,total:colors+spacing+font};
};
const before=debt(original),after=debt(converted);

const store=new WorkstationStore(':memory:');
seedVisualStore(store);
const connection={admit:()=>({peer:{id:'operator'}}),requestRejection:()=>undefined};
const route=httpRoute({store,connection,workspaceRegistry:{list:()=>[{id:'w',title:'飞书工作区'}],get:id=>id==='w'?{id:'w',title:'飞书工作区'}:null},allowedWorkspaces:['w']});
const types={'.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.html':'text/html; charset=utf-8','.png':'image/png','.json':'application/json'};
const server=createServer((request,response)=>{
 const url=request.url.split('?')[0];
 // 外壳里嵌的是真实服务地址，所以 **只换字节、不另开路由**：
 // `/personal-workstation` 的响应体本来是 src/v7-shell.html，这里按 useConverted 换成转换版。
 // （第一次写成"另开 /compare 路由"是错的：工作台路由按前缀匹配，/compare 仍被它吃掉，
  //   于是两版其实是同一页，差异全部来自加载抖动 —— 实测踩过。）
 const useConverted=new URL(request.url,'http://x').searchParams.has('convert');
 if(useConverted){
  const originalEnd=response.end.bind(response);
  response.end=(body,...rest)=>{
   if(typeof body==='string'&&body.includes('data-design="tokens"'))body=converted;
   else if(Buffer.isBuffer(body)){
    const text=body.toString('utf8');
    if(text.includes('data-design="tokens"'))body=Buffer.from(converted,'utf8');
   }
   return originalEnd(body,...rest);
  };
 }
 if(url.startsWith('/personal-workstation/v7/')){
  const target=join(v7Root,url.slice('/personal-workstation/v7/'.length));
  if(!target.startsWith(v7Root)||!existsSync(target)){response.writeHead(404);response.end('Not found');return}
  response.writeHead(200,{'content-type':types[extname(target)]??'application/octet-stream'});response.end(readFileSync(target));return;
 }
 route.handler(request,response);
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base='http://127.0.0.1:'+server.address().port;
const browser=await puppeteer.launch({executablePath:chrome,headless:'new',args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu']});
const directory=fileURLToPath(new URL('./screenshots/convert/',import.meta.url));mkdirSync(directory,{recursive:true});
const results=[];
try{
 const page=await browser.newPage();
 await page.setViewport(viewport);
 const shoot=async(url,view,file)=>{
  const errors=[];const onError=error=>errors.push(error.message);page.on('pageerror',onError);
  await page.goto(url,{waitUntil:'networkidle0'});
  await page.evaluate(name=>{const button=document.querySelector('.nav [data-view="'+name+'"]');if(button)button.click();window.scrollTo(0,0)},view);
  await new Promise(resolve=>setTimeout(resolve,600));
  const buffer=await page.screenshot({type:'png'});
  writeFileSync(file,buffer);
  page.off('pageerror',onError);
  return {buffer,errors};
 };
 for(const view of pages){
  const mine=await shoot(base+'/personal-workstation',view,join(directory,`before-${view}.png`));
  const again=await shoot(base+'/personal-workstation',view,join(directory,`before2-${view}.png`));
  const candidate=await shoot(base+'/personal-workstation?convert=1',view,join(directory,`after-${view}.png`));
  const compare=(aUrl,bUrl,tolerance,file)=>page.evaluate(async(aUrl,bUrl,tolerance)=>{
   const load=src=>new Promise((resolve,reject)=>{const image=new Image();image.onload=()=>resolve(image);image.onerror=()=>reject(new Error('图片加载失败'));image.src=src});
   const [a,b]=await Promise.all([load(aUrl),load(bUrl)]);
   const width=Math.min(a.width,b.width),height=Math.min(a.height,b.height);
   const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
   const context=canvas.getContext('2d',{willReadFrequently:true});
   context.drawImage(a,0,0);const left=context.getImageData(0,0,width,height).data;
   context.clearRect(0,0,width,height);context.drawImage(b,0,0);const right=context.getImageData(0,0,width,height).data;
   let differing=0,worst=0;const overlay=context.createImageData(width,height);
   const hot=[];
   for(let y=0;y<height;y+=1)for(let x=0;x<width;x+=1){
    const index=(y*width+x)*4;
    const delta=Math.max(Math.abs(left[index]-right[index]),Math.abs(left[index+1]-right[index+1]),Math.abs(left[index+2]-right[index+2]));
    worst=Math.max(worst,delta);
    const bad=delta>tolerance;
    if(bad){differing+=1;if(hot.length<6)hot.push({x,y,delta})}
    overlay.data[index]=bad?255:left[index];overlay.data[index+1]=bad?0:left[index+1];overlay.data[index+2]=bad?0:left[index+2];overlay.data[index+3]=255;
   }
   const canvasOut=document.createElement('canvas');canvasOut.width=width;canvasOut.height=height;
   canvasOut.getContext('2d').putImageData(overlay,0,0);
   return {differing,total:width*height,worst,overlay:canvasOut.toDataURL('image/png'),hot};
  },`data:image/png;base64,${aUrl}`,`data:image/png;base64,${bUrl}`,tolerance).then(diff=>{
   writeFileSync(join(directory,file),Buffer.from(diff.overlay.split(',')[1],'base64'));
   return diff;
  });
  // 抖动基线：同一条 URL 截两次，量出"与改动无关"的差异下限。
  const jitter=await compare(mine.buffer.toString('base64'),again.buffer.toString('base64'),8,`jitter-${view}.png`);
  const diff=await compare(mine.buffer.toString('base64'),candidate.buffer.toString('base64'),8,`diff-${view}.png`);
  results.push({view,ratio:diff.differing/diff.total,worst:diff.worst,hot:diff.hot,jitter:jitter.differing/jitter.total,jitterWorst:jitter.worst,errors:[...mine.errors,...candidate.errors]});
 }
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));store.close()}

console.log(`这次改动 受控对照 · 强度 ${presetName} · 视口 ${viewport.width}×${viewport.height}`);
console.log('─'.repeat(72));
console.log(`外壳字面值存量：改前 ${JSON.stringify(before)} → 改后 ${JSON.stringify(after)}`);
console.log(`替换：色值 ${Object.keys(report.colors).length} 种 · alpha ${Object.keys(report.alpha).length} 种 · 间距 ${Object.keys(report.spacing).length} 种 · 字号 ${Object.keys(report.fontSize).length} 种`);
if(report.unmapped.length)console.log(`没有对应值，保持原样（保持原样）：${[...new Set(report.unmapped)].join(' ')}`);
console.log('─'.repeat(72));
let worst=0;
for(const row of results){
 worst=Math.max(worst,row.ratio);
 console.log(row.view.padEnd(10)+`改动像素 ${(row.ratio*100).toFixed(2)}%  ·  最大单通道差 ${row.worst}`
  +`  ·  同页抖动基线 ${(row.jitter*100).toFixed(2)}%（最大差 ${row.jitterWorst}）`
  +(row.errors.length?`  错误 ${JSON.stringify(row.errors)}`:''));
}
console.log('─'.repeat(72));
console.log(`对照图写入 prototype/screenshots/convert/（before-*.png / after-*.png / diff-*.png）`);
console.log(worst<0.01?'PASS: 六页改动像素均低于 1% —— 改动是视觉中性的。'
 :worst<0.05?'注意: 最大 '+ (worst*100).toFixed(2) +'% —— 需人眼确认这几页。'
 :'FAIL: 最大 '+(worst*100).toFixed(2)+'% —— 位移过大，需换更保守的映射。');
process.exit(0);
