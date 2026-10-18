import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {httpRoute} from '../src/http-route.mjs';
import {WorkstationStore} from '../src/store.mjs';
import {puppeteer, chromeExecutable} from '../dev-deps.mjs';

/** 预览端到端校验：真实 Chrome + 真实受权字节路由。
 *  断言图片被浏览器解码（naturalWidth）而不是留一个空白框，并对照 Office 走宿主转换服务。
 *  用一次性内存库，不碰生产数据。 */
const PNG=Buffer.from(readFileSync(new URL('./fixtures/preview.png',import.meta.url)));
const PDF=Buffer.from('%PDF-1.4\n% workstation preview fixture\n');

export async function runPreviewCheck({port=0}={}){
 const store=new WorkstationStore(':memory:');
 const files={grants:[{id:'g1',workspace:'w',root:'/files',read:true,write:false}],
  async readBinary(ctx,{path,extensions}){
   const suffix=path.split('.').pop();
   if(!extensions.includes(suffix))throw Object.assign(new Error('预览只接受授权目录内的 '+extensions.join('、')),{code:'INVALID'});
   return {bytes:suffix==='pdf'?PDF:PNG,version:'v1',size:PNG.length};
  }};
 const office={async convert(request){
  if(request.extension==='xlsx')throw Object.assign(new Error('LibreOffice 转换失败'),{name:'OfficeToPdfError'});
  return {pdf:PDF,missingFonts:['缺失字体样例']};
 }};
 const connection={admit:()=>({peer:{id:'operator'}}),requestRejection:()=>undefined};
 const deps={store,files,office,connection,workspaceRegistry:{list:()=>[{id:'w',title:'飞书工作区'}],get:id=>id==='w'?{id:'w',title:'飞书工作区'}:null},allowedWorkspaces:['w']};
 const route=httpRoute(deps);
 const server=createServer((q,s)=>route.handler(q,s));
 await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));
 const base='http://127.0.0.1:'+server.address().port;
 const browser=await puppeteer.launch({executablePath:chromeExecutable(),headless:'new',args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu']});
 const page=await browser.newPage();await page.setViewport({width:1200,height:900});
 const pageErrors=[],httpErrors=[];
 page.on('pageerror',error=>pageErrors.push(error.message));
 page.on('response',response=>{if(response.status()>=400&&!/favicon/.test(response.url()))httpErrors.push('http '+response.status()+' '+response.url())});
 const openPreview=async path=>{
  // 2026-10-14 用户拍板（走查 C7b）：顶栏那个「文件与资料」与知识页页签重复，删顶栏的。
  // 预览这条路改走知识页页签（能力没变，入口换了一个）。
  await page.evaluate(()=>{
   const tab=document.querySelector('#knowtabs [data-know="files"]');
   if(tab){tab.click();return;}
   const fallback=[...document.querySelectorAll('.actions .btn')].find(node=>node.textContent.includes('文件与资料'));
   fallback?.click();
  });
  await new Promise(resolve=>setTimeout(resolve,300));
  await page.evaluate(()=>{
   const open=document.querySelector('[data-know-act="files"]');
   if(open)open.click();
  });
  await new Promise(resolve=>setTimeout(resolve,700));
  await page.evaluate(value=>{const input=document.querySelector('[data-role="path"]');input.value=value;input.dispatchEvent(new Event('input'))},path);
  await page.evaluate(()=>document.querySelector('#filePreview').click());
  await new Promise(resolve=>setTimeout(resolve,900));
 };
 const findings={};
 try{
  await page.goto(base+'/personal-workstation',{waitUntil:'networkidle0'});
  await openPreview('pics/photo.png');
  findings.image=await page.evaluate(()=>{const node=document.querySelector('#detailbody img');return {present:Boolean(node),naturalWidth:node?.naturalWidth??0}});
  await page.screenshot({path:'prototype/screenshots/v7-preview-image.png'});
  await openPreview('docs/方案.docx');
  findings.office=await page.evaluate(()=>{const node=document.querySelector('#detailbody embed');return {present:Boolean(node),type:node?.getAttribute('type')??null}});
  await page.screenshot({path:'prototype/screenshots/v7-preview-office.png'});
  await openPreview('docs/预算.xlsx');
  findings.conversionFailure=await page.evaluate(()=>document.querySelector('#toast')?.textContent??'');
  findings.imageDecoded=findings.image.present&&findings.image.naturalWidth===360;
  findings.officeConverted=findings.office.present&&findings.office.type==='application/pdf';
  findings.failureReported=/预览失败/.test(findings.conversionFailure)&&/LibreOffice 转换失败/.test(findings.conversionFailure);
 }finally{
  await browser.close();await new Promise(resolve=>server.close(resolve));store.close();
 }
 // 故意触发的转换失败会返回 502：那是被验证的行为，不算意外错误。
 findings.pageErrors=pageErrors;
 findings.unexpectedHttp=httpErrors.filter(url=>!url.includes('%E9%A2%84%E7%AE%97')&&!url.includes('预算'));
 return findings;
}

// 工作区路径含非 ASCII：直接拼 file:// 会与百分号编码的 import.meta.url 失配。
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const findings=await runPreviewCheck();
 console.log(JSON.stringify(findings,null,2));
 const ok=findings.imageDecoded&&findings.officeConverted&&findings.failureReported&&findings.pageErrors.length===0&&findings.unexpectedHttp.length===0;
 console.log(ok?'PASS: 图片经受权路由被浏览器解码，Office 经宿主转换，转换失败给出原因。':'FAIL: 预览端到端检查没通过。');
 process.exit(ok?0:1);
}
