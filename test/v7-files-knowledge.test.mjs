import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {JSDOM} from '../dev-deps.mjs';
import {createBatchFlow} from '../prototype/batch.mjs';
import {createFiles} from '../prototype/files.mjs';
import {createKnowledgeSearch,evidenceRef,evidenceArtifact} from '../prototype/knowledge-search.mjs';

const shell=()=>new JSDOM(readFileSync(new URL('../prototype/replica/index.html',import.meta.url),'utf8'));
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('evidence references follow the stored knowledge citation format',()=>{
 assert.equal(evidenceRef({baseId:'b 1',docId:'d/2',chunkId:'c3'}),'knowledge:b%201:d%2F2:c3');
 assert.equal(evidenceRef({baseId:'b',docId:'d',chunkId:'c',processingRevision:'r7'}),'knowledge:b:d:c@r7');
 const artifact=evidenceArtifact({baseId:'b',docId:'d',chunkId:'c',documentTitle:'方法',text:'正文'});
 assert.equal(artifact.title,'方法 · 摘录');assert.equal(artifact.content,'正文');assert.deepEqual(artifact.sourceRefs,['knowledge:b:d:c']);
});
test('file page reads, edits, saves with version guard and reports conflicts',async()=>{
 const root=mkdtempSync(join(tmpdir(),'ws-files-'));writeFileSync(join(root,'note.md'),'原始内容');
 const dom=shell(),document=dom.window.document,sent=[],notes=[];
 const state={content:'原始内容',version:'v1'};
 const send=async(action,data={})=>{sent.push([action,data]);
  if(action==='file_grants')return {items:[{id:'g1',label:'资料目录',read:true,write:true}]};
  if(action==='file_read')return {grantId:data.grantId,path:data.path,content:state.content,version:state.version};
  if(action==='file_save'){if(data.version!==state.version)throw Error('文件已修改，请重新读取并合并');state.content=data.content;state.version='v2';return {version:'v2',status:'saved'}}
  throw Error('unexpected '+action)};
 const batch=createBatchFlow(document,send,{notify:()=>{},confirm:()=>true});
 const files=createFiles(document,send,{notify:(text,error)=>notes.push([text,error]),confirm:()=>true,onArtifact:payload=>notes.push(['artifact',payload])});
 try{
  await files.openFile({});await tick();
  assert.equal(document.querySelector('#detailtitle').textContent,'文件与资料');
  document.querySelector('[data-role="path"]').value='note.md';
  document.querySelector('[data-role="path"]').oninput();
  document.querySelector('#fileRead').click();await tick();await tick();
  assert.equal(document.querySelector('#detailtitle').textContent,'编辑文件 · note.md');
  const area=document.querySelector('#filetext');assert.equal(area.value,'原始内容');
  assert.match(document.querySelector('#filestate').textContent,/内容已保存/);
  area.value='修改后的内容';area.oninput();
  assert.match(document.querySelector('#filestate').textContent,/有未保存修改/);
  document.querySelector('#filesave').click();await tick();await tick();
  assert.equal(state.content,'修改后的内容');assert.match(document.querySelector('#filestate').textContent,/内容已保存/);
  assert.match(document.querySelector('#filestate').textContent,/版本 v2/);
  const saved=sent.filter(([action])=>action==='file_save');assert.deepEqual(saved[0][1],{grantId:'g1',path:'note.md',version:'v1',content:'修改后的内容'});
  state.version='v9';area.value='并发修改';area.oninput();
  document.querySelector('#filesave').click();await tick();await tick();
  assert.match(notes.at(-1)[0],/文件已修改/, '版本冲突必须报告而不是覆盖');
  assert.equal(state.content,'修改后的内容','冲突时不得写入');
  document.querySelector('#fileartifact').click();
  assert.equal(notes.at(-1)[0],'artifact');
  assert.equal(notes.at(-1)[1].path,'note.md');
  document.querySelector('#fileexport').click();
 }finally{files.dispose();batch.dispose();dom.window.close();rmSync(root,{recursive:true,force:true})}
});
test('read-only grants cannot save, and knowledge hits become previewed artifact drafts',async()=>{
 const dom=shell(),document=dom.window.document,drafts=[],notes=[];
 const send=async(action,data={})=>{if(action==='file_grants')return {items:[{id:'g1',label:'只读目录',read:true,write:false}]};
  if(action==='file_read')return {content:'只读内容',version:'r1'};
  if(action==='knowledge_bases')return {items:[{id:'kb',title:'知识库'}]};
  if(action==='list')return {items:[{id:'p',kind:'project',data:{title:'项目'}}]};
  if(action==='knowledge_search')return {hits:[{baseId:'kb',docId:'doc',chunkId:'chunk',documentTitle:'方法',text:'证据正文',heading:'口径'}]};
  throw Error('unexpected '+action)};
 const batch={draft:async(title,changes)=>drafts.push({title,changes})};
 const files=createFiles(document,send,{notify:(text,error)=>notes.push([text,error]),confirm:()=>true});
 const search=createKnowledgeSearch(document,send,batch,{notify:(text,error)=>notes.push([text,error])});
 try{
  await files.openFile({});await tick();
  document.querySelector('[data-role="path"]').value='readonly.md';document.querySelector('[data-role="path"]').oninput();
  document.querySelector('#fileRead').click();await tick();await tick();
  assert.equal(document.querySelector('#filetext').readOnly,true);
  assert.equal(document.querySelector('#filesave'),null,'只读授权不得出现保存按钮');
  await search.open({projectId:'p'});await tick();
  document.querySelector('[data-role="query"]').value='方法';document.querySelector('#knowsearch').click();await tick();await tick();
  assert.match(document.querySelector('#knowledgehits').textContent,/证据正文/);
  assert.match(document.querySelector('#knowledgehits').textContent,/口径/);
  document.querySelector('#knowledgehits .btn').click();await tick();
  assert.equal(drafts.length,1);assert.equal(drafts[0].title,'保存知识证据');
  assert.deepEqual(drafts[0].changes,[{op:'create',kind:'artifact',data:{title:'方法 · 摘录',content:'证据正文',description:'知识检索证据当时的副本；原文后续更新不会自动同步。',sourceRefs:['knowledge:kb:doc:chunk'],projectId:'p'}}]);
 }finally{files.dispose();search.dispose();dom.window.close()}
});

test('images, PDFs and Office previews render through the authorized byte route without local parsing',async()=>{
 const dom=shell(),document=dom.window.document;
 const send=async(action,data={})=>{
  if(action==='file_grants')return {items:[{id:'g1',label:'资料',read:true,write:false}]};
  if(action==='file_list')return {items:[{name:'photo.png',type:'file',size:10},{name:'方案.docx',type:'file',size:20},{name:'合同.pdf',type:'file',size:30}],nextOffset:null};
  if(action==='file_read')return {content:'文本',version:'v1'};
  throw Error('未预期的动作 '+action)};
 const notices=[];
 const probeLog=[];
 const probe=async url=>({ok:true,status:200,body:{cancel:async()=>{}},text:async()=>'' ,url});
 const files=createFiles(document,send,{notify:(text,error)=>notices.push({text,error}),workspace:'w',fetchImpl:async(url,options)=>{probeLog.push({url,options});return probe(url)}});
 try{
  // 每种格式都重新打开对话框：预览会替换对话框内容。
  await files.openFile();await tick();
  assert(document.querySelector('#filePreview'),'文件页必须提供预览入口');
  document.querySelector('[data-role="path"]').value='pics/photo.png';
  document.querySelector('#filePreview').click();await tick();await tick();
  const image=document.querySelector('#detailbody img');
  assert(image,'图片应渲染为 img');
  const source=image.getAttribute('src');
  assert.match(source,/^\/personal-workstation\/file\?/);
  assert.match(source,/workspace=w/);assert.match(source,/grantId=g1/);assert.match(source,/path=pics%2Fphoto\.png/);
  assert.match(document.querySelector('#detailbody .notice').textContent,/未做转码/);
  assert.equal(probeLog.length,1,'预览前必须先探一次状态，失败时才能给出原因');
  assert.match(probeLog[0].url,/^\/personal-workstation\/file\?/);
  await files.openFile();await tick();
  document.querySelector('[data-role="path"]').value='docs/合同.pdf';
  document.querySelector('#filePreview').click();await tick();await tick();
  const embed=document.querySelector('#detailbody embed');
  assert(embed,'PDF 应交给浏览器内置查看器');assert.equal(embed.getAttribute('type'),'application/pdf');
  // Office 由宿主的 officeToPdf 转换后交给浏览器查看器；工作台不解析字节。
  await files.openFile();await tick();
  document.querySelector('[data-role="path"]').value='docs/方案.docx';
  document.querySelector('#filePreview').click();await tick();await tick();
  const officeEmbed=document.querySelector('#detailbody embed');
  assert(officeEmbed,'Office 应交给 PDF 查看器而不是留在页面里解析');
  assert.equal(officeEmbed.getAttribute('type'),'application/pdf');
  assert.match(officeEmbed.getAttribute('src'),/path=docs%2F%E6%96%B9%E6%A1%88\.docx/);
  assert.match(document.querySelector('#detailbody .notice').textContent,/officeToPdf/,'必须说明转换由宿主服务完成');
  assert.match(document.querySelector('#detailbody .notice').textContent,/工作台不解析字节/);
  // 真正不支持的格式仍必须明确拒绝，而不是静默失败。
  await files.openFile();await tick();
  document.querySelector('[data-role="path"]').value='docs/archive.zip';
  document.querySelector('#filePreview').click();await tick();await tick();
  assert(notices.some(item=>item.error&&/预览只支持/.test(item.text)),'不支持的格式必须明确说明，而不是静默失败');
  assert(!document.querySelector('#detailbody embed'),'不得为不支持的格式伪造预览');
 }finally{files.dispose();dom.window.close()}
});

test('a failing preview reports the real reason instead of leaving a blank frame',async()=>{
 const dom=shell(),document=dom.window.document;
 const notices=[];
 const send=async action=>{if(action==='file_grants')return {items:[{id:'g1',read:true}]};if(action==='file_list')return {items:[],nextOffset:null};throw Error(action)};
 const files=createFiles(document,send,{notify:(text,error)=>notices.push({text,error}),workspace:'w',fetchImpl:async()=>({ok:false,status:503,text:async()=>'Office 预览需要宿主转换服务（officeToPdf），当前未加载',body:{cancel:async()=>{}}})});
 try{
  await files.openFile();await tick();
  document.querySelector('[data-role="path"]').value='docs/方案.docx';
  document.querySelector('#filePreview').click();await tick();await tick();
  const failure=notices.find(item=>item.error&&/预览失败/.test(item.text));
  assert(failure,'预览失败必须报告，而不是留一个空白框');
  assert.match(failure.text,/HTTP 503/);
  assert.match(failure.text,/officeToPdf/,'必须把后端给出的原因原样转达');
  assert(!document.querySelector('#detailbody embed'),'失败时不得渲染空白查看器');
 }finally{files.dispose();dom.window.close()}
});
test('a preview that cannot reach the service says so instead of looking empty',async()=>{
 const dom=shell(),document=dom.window.document;
 const notices=[];
 const send=async action=>{if(action==='file_grants')return {items:[{id:'g1',read:true}]};if(action==='file_list')return {items:[],nextOffset:null};throw Error(action)};
 const files=createFiles(document,send,{notify:(text,error)=>notices.push({text,error}),workspace:'w',fetchImpl:async()=>{throw new TypeError('Failed to fetch')}});
 try{
  await files.openFile();await tick();
  document.querySelector('[data-role="path"]').value='pics/a.png';
  document.querySelector('#filePreview').click();await tick();await tick();
  const failure=notices.find(item=>item.error&&/无法连接工作台服务/.test(item.text));
  assert(failure,'断连必须说明是连接问题');
  assert.doesNotMatch(failure.text,/Failed to fetch/,'不得把底层英文错误丢给用户');
 }finally{files.dispose();dom.window.close()}
});

test('the files dialog offers local transcription and turns the text into a confirmable draft',async()=>{
 const {createFiles}=await import('../prototype/files.mjs');
 const {JSDOM}=await import('../dev-deps.mjs');
 const {readFileSync}=await import('node:fs');
 const dom=new JSDOM(readFileSync(new URL('../prototype/replica/index.html',import.meta.url),'utf8'));
 const document=dom.window.document;
 const calls=[];
 const send=async(action,data)=>{calls.push({action,data});
  if(action==='file_grants')return {items:[{id:'voice-inbox',label:'语音目录（只读）',read:true,write:false}]};
  if(action==='file_list')return {items:[],nextOffset:null};
  if(action==='transcribe')return {text:'把试点范围跟进记为研究议题',provider:'sensevoice-local',audioSeconds:3.2,inferenceSeconds:0.9,path:data.path};
  if(action==='draft')return {id:'b-voice'};
  throw Error(action)};
 let opened=null;
 const files=createFiles(document,send,{notify:()=>{},workspace:'w',onBatch:id=>{opened=id}});
 try{
  await files.openFile({path:'inbox/note.wav'});
  const button=document.querySelector('#detailbody #fileTranscribe');
  assert(button,'文件与资料必须提供语音转写入口');
  button.click();
  for(let index=0;index<8;index+=1)await new Promise(resolve=>setImmediate(resolve));
  const area=document.querySelector('#detailbody #transcribebody');
  assert.match(area.textContent,/把试点范围跟进记为研究议题/,'必须显示真实转写文字');
  assert.match(area.textContent,/来源 inbox\/note.wav/,'必须显示文字来自哪个文件');
  assert(!calls.some(call=>call.action==='file_save'),'转写不得写文件');
  const draftButton=area.querySelector('[data-transcribe-draft]');
  assert(draftButton,'转写后必须提供「生成记录待确认的改动」');
  draftButton.click();
  for(let index=0;index<8;index+=1)await new Promise(resolve=>setImmediate(resolve));
  const draft=calls.find(call=>call.action==='draft');
  assert(draft,'必须走待确认的改动流程，不得直接写记录');
  assert.match(draft.data.title,/语音转写 · note\.wav/);
  assert.equal(draft.data.changes[0].data.description,'把试点范围跟进记为研究议题','待确认的改动必须带上转写原文');
  assert.match(JSON.stringify(draft.data.sources),/语音转写/,'必须标注来源是语音转写，不能伪装成人工录入');
  assert.equal(opened,'b-voice','生成待确认的改动后应打开让用户确认');
 }finally{files.dispose();dom.window.close()}
});
test('an unsupported audio extension is refused with the supported list',async()=>{
 const {createFiles,transcribeTypes}=await import('../prototype/files.mjs');
 const {JSDOM}=await import('../dev-deps.mjs');
 const {readFileSync}=await import('node:fs');
 const dom=new JSDOM(readFileSync(new URL('../prototype/replica/index.html',import.meta.url),'utf8'));
 const document=dom.window.document;
 const send=async(action,data)=>{if(action==='file_grants')return {items:[{id:'voice-inbox',label:'语音目录（只读）',read:true,write:false}]};if(action==='file_list')return {items:[],nextOffset:null};throw Error(action)};
 const files=createFiles(document,send,{notify:()=>{},workspace:'w'});
 try{
  await files.openFile({path:'inbox/note.txt'});
  document.querySelector('#detailbody #fileTranscribe').click();
  await new Promise(resolve=>setImmediate(resolve));
  const text=document.querySelector('#detailbody #transcribebody').textContent;
  assert.match(text,/语音转写支持的格式/);
  assert(transcribeTypes.includes('m4a')&&transcribeTypes.includes('wav'),'常见录音格式必须在支持列表里');
 }finally{files.dispose();dom.window.close()}
});

test('settings state whether agent transcription needs approval instead of leaving it to guesswork',async()=>{
 const {speechLine}=await import('../prototype/inbox.mjs');
 assert.match(speechLine({speechToText:true,speech:{providers:[{id:'p',name:'本地模型',phase:'standby'}]},speechApprovalRequired:true}),/每次需批准一次/);
 assert.match(speechLine({speechToText:true,speech:{providers:[{id:'p',name:'本地模型',phase:'ready'}]},speechApprovalRequired:false}),/免审批/);
 assert.match(speechLine({}),/未接入/,'没接入语音时必须说不接入');
});
