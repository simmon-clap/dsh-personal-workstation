/** 批次 7 验收（真实浏览器）：主动做事的**手动触发 + 留痕 + 告警**真的在界面上出现。
 *
 *  依据：spec/04 §3 批次 7 验收 —— 「手动触发后留痕如实记录"看到什么、为什么不打扰"；模拟失败能产生告警」；
 *  spec/03 §6 ⑦ 心跳的诚实约束（必须留痕 · 最后成功时间可见 · 连续失败告警 · 不产出无来源的判断）。
 *
 *  取证纪律（前几轮踩过的坑）：
 *    · 真的点进「空间与设置」并等它渲染完，不靠"元素在 DOM 里"就算过；
 *    · 必须点一次「现在做一次」，再断言留痕出现（否则测的是空页）；
 *    · 失败告警用**真的写进记录表**的两次失败来触发，不伪造界面；
 *    · 入口数不变（不新增一级入口与知识页签）。
 *  用法：node prototype/heartbeat-browser-check.mjs
 */
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {httpRoute} from '../src/http-route.mjs';
import {WorkstationStore} from '../src/store.mjs';
import {HeartbeatStore} from '../src/heartbeat-store.mjs';
import {SpeakStore} from '../src/speak-store.mjs';
import {seedVisualStore} from './visual-seed.mjs';
import {puppeteer, chromeExecutable} from '../dev-deps.mjs';

const chrome = chromeExecutable();

async function main(){
 const store = new WorkstationStore(':memory:');
 seedVisualStore(store);
 const heartbeat = new HeartbeatStore(store);
 const speak = new SpeakStore(store);
 const connection = {admit:()=>({peer:{id:'operator'}}),requestRejection:()=>undefined};
 const route = httpRoute({store,connection,workspaceRegistry:{list:()=>[{id:'w',title:'飞书工作区'}],get:id=>id==='w'?{id:'w',title:'飞书工作区'}:null},allowedWorkspaces:['w'],heartbeat,speak});
 const server = createServer((request,response)=>route.handler(request,response));
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base = 'http://127.0.0.1:'+server.address().port;
 const browser = await puppeteer.launch({executablePath:chrome,headless:'new',args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu']});
 const checks = [], failures = [];
 const check = (name,ok,detail='')=>{checks.push({name,ok,detail});if(!ok)failures.push(name+(detail?'（'+detail+'）':''))};
 try{
  const page = await browser.newPage();
  await page.setViewport({width:1440,height:940});
  const errors = [];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(base+'/personal-workstation',{waitUntil:'networkidle0'});
  const entries = await page.evaluate(()=>document.querySelectorAll('.nav [data-view]').length);
  const tabs = await page.evaluate(()=>document.querySelectorAll('#knowtabs button').length);

  // 打开「空间与设置」——入口不动，内容加在这个既有视图里。
  const opened = await page.evaluate(()=>{const button=document.querySelector('#settings');if(!button)return false;button.click();return true});
  check('侧栏仍有「空间与设置」入口',opened);
  // W1 P0-1：留痕收进「助理替你做过的」折叠（首屏只留授权/状态/一个动作），展开后才渲染。
  await page.waitForFunction(()=>document.querySelector('#veil')?.classList.contains('open'),{timeout:8000});
  await page.evaluate(()=>{const details=document.querySelector('[data-settings-details="history"]');if(details)details.open=true});
  await page.waitForFunction(()=>document.querySelector('#heartbeatbody')?.textContent?.includes('定时')&&!document.querySelector('#heartbeatbody')?.textContent?.includes('展开时读取'),{timeout:8000});
  const before = await page.evaluate(()=>{
   const body=document.querySelector('#heartbeatbody');
   return {text:body.textContent, hasTrigger:!!document.querySelector('#settingsheartbeat'),
    open:document.querySelector('#veil').classList.contains('open'),
    section:document.querySelector('#detailbody').textContent.includes('助理替你做过的')};
  });
  check('弹窗真的打开了（#veil.open）',before.open);
  check('有「助理替你做过的」这一段',before.section);
  // 唯一话术（W1 P0-1）：没有定时就说没有开启；不再出现"未接入/手动触发"第二套说法。
  check('如实说明没有开启定时',/没有开启/.test(before.text)&&/点一下/.test(before.text),before.text.slice(0,80));
  check('不再出现旧口径「还没有接入定时/已在定时运行」',!/还没有接入定时|已在定时运行/.test(before.text));
  check('有手动触发按钮',before.hasTrigger);
  check('还没跑过时给下一步',/还没有跑过/.test(before.text));

  // 手动触发一次
  await page.evaluate(()=>document.querySelector('#settingsheartbeat').click());
  // 触发一次之后，留痕是**分几步**写进 #heartbeatbody 的（先状态、再判定、再理由）。
  // 原来只等到「上次跑成 + 这次看了」就取文本，随后断言「没打扰你的原因」，在 verify 里串行跑时
  // 偶发读到还没写完的那一帧（单独跑必过、进 verify 偶发红）——这是**时序竞态**，不是功能坏了。
  // 改成等到「理由这一行也写出来」为止再取文本；真的没写出来，等到超时后断言照样会红，不会掩盖问题。
  await page.waitForFunction(()=>{
   const text=document.querySelector('#heartbeatbody')?.textContent??'';
   return /上次跑成/.test(text)&&/这次看了/.test(text)&&/没打扰你的原因|值得找你的/.test(text);
  },{timeout:15000});
  // 这条以前偶发过一次（单跑过、并发跑偶发不过）：它等的是"跑完了"，而**理由那几行是随后
  // 异步补进去的** —— 页面一更新就断言，就赶在理由渲染之前。
  //
  // 第一版修法把"理由已落位"并进 waitForFunction —— 那是**错的**：
  // 负载一高就抛 TimeoutError，栈直接把整条 verify 链掐断，后面的门禁一条都不跑，
  // 比原来的偶发红更坏（偶发红只红一条，这个红整条链）。
  // 正确做法：等待超时就**落到下面的断言**，让它作为一条具名判据失败，链继续走。
  try {
   await page.waitForFunction(()=>{
    const text=document.querySelector('#heartbeatbody')?.textContent??'';
    return /还有 \d+ 天|还没有新证据|在等|没有新材料|还不用复核|现在说太早/.test(text);
   // 全量链里同时有别的浏览器门禁在跑，45 秒在忙碌时会不够 → 那次会**假失败**
   // （实测：单跑 PASS，全量链 FAIL）。这里给足预算；真跑不完仍然会在下面如实报错，不静默跳过。
   },{timeout:120000});
  } catch { /* 超时不停链：下面 check() 会如实报这一条 */ }
  const after = await page.evaluate(()=>document.querySelector('#heartbeatbody').textContent);
  check('留痕写出"上次跑成"的时间',/上次跑成：\d{4}/.test(after),after.slice(0,80));
  check('留痕写出"这次看了"什么',/这次看了/.test(after));
  check('留痕写出"没打扰你的原因"',/没打扰你的原因/.test(after));
  check('留痕里带着具体理由（不是空话）',/还有 \d+ 天|还没有新证据|在等|没有新材料|还不用复核|现在说太早/.test(after),after.slice(0,160));

  // 出声（批次 8）：额度、反馈、门槛放宽都要能在界面上真的走一遍。
  // 先补一条"上次跑之后才有的"材料，再跑一次 —— 这样才真有"值得找你"的条目可回应（否则这项检查会空转）。
  const seedCtx = {workspace:'w',actor:'check',canWrite:true};
  const seedBatch = store.draft(seedCtx,{title:'补一份新材料',changes:[{op:'create',id:'check-fresh',kind:'artifact',data:{title:'新到的路演纪要',path:'会议/新到的路演纪要.md'}}]});
  store.commit(seedCtx,{batchId:seedBatch.id,revision:seedBatch.revision,key:'check-fresh'});
  await page.evaluate(()=>document.querySelector('#settingsheartbeat').click());
  await page.waitForFunction(()=>document.querySelectorAll('#heartbeatbody [data-speak-feedback]').length>0,{timeout:8000}).catch(()=>{});
  const budgetLine = await page.evaluate(()=>document.querySelector('#heartbeatbody').textContent);
  check('显示出声额度与阶段（初值 40 / 试用期）',/出声额度 40（试用期）/.test(budgetLine),budgetLine.slice(0,120));
  check('显示二级每周上限与免打扰时段',/这周最多打断 \d+ 次/.test(budgetLine)&&/免打扰/.test(budgetLine));
  const feedbackButtons = await page.evaluate(()=>document.querySelectorAll('#heartbeatbody [data-speak-feedback]').length);
  const missedButtons = await page.evaluate(()=>document.querySelectorAll('#heartbeatbody [data-speak-missed]').length);
  check('每条"值得找你的"都能回应（照做了/知道了/没必要/忽略）',feedbackButtons>=4,String(feedbackButtons));
  check('四类判定都能标"该说没说"',missedButtons===4,String(missedButtons));
  if(feedbackButtons===0){
   const dump=await page.evaluate(()=>({body:document.querySelector('#heartbeatbody').textContent.slice(0,400),html:document.querySelector('#heartbeatbody').innerHTML.slice(0,400)}));
   console.log('        没有反馈按钮，body=',dump.body);
   console.log('        html=',dump.html);
  }
  // 点「没必要」→ 额度必须降到 30 及以下（验收判据 1）
  if(feedbackButtons>0)await page.evaluate(()=>document.querySelector('#heartbeatbody [data-speak-feedback="unnecessary"]').click());
  if(feedbackButtons>0)await page.waitForFunction(()=>/出声额度 30（/.test(document.querySelector('#heartbeatbody')?.textContent??''),{timeout:8000}).catch(()=>{});
  const afterUnnecessary = await page.evaluate(()=>document.querySelector('#heartbeatbody').textContent);
  check('标"没必要"后额度降到 30 及以下',/出声额度 30（试用期）/.test(afterUnnecessary),afterUnnecessary.slice(0,80));
  // 标「该说没说」→ 该类门槛放宽一档
  if(missedButtons>0)await page.evaluate(()=>document.querySelector('#heartbeatbody [data-speak-missed="守承诺"]').click());
  if(missedButtons>0)await page.waitForFunction(()=>/门槛已放宽一档/.test(document.querySelector('#heartbeatbody')?.textContent??''),{timeout:8000}).catch(()=>{});
  const afterMissed = await page.evaluate(()=>document.querySelector('#heartbeatbody').textContent);
  check('标"该说没说"后该类门槛放宽一档',/守承诺 的门槛已放宽一档/.test(afterMissed),afterMissed.slice(0,120));
  check('界面上不出现"已推送"这类假话',!/已推送|已经推送/.test(afterMissed));

  // 失败告警：往记录表里真写两次失败，重新渲染后必须报警。
  const ctx = await page.evaluate(()=>null); void ctx;
  heartbeat.record({workspace:'w',actor:'check',canWrite:true},{trigger:'manual',startedAt:new Date().toISOString(),outcome:'failed',errors:[{rule:'示例',message:'示例故障'}],looked:[],candidates:[],silenced:[]});
  heartbeat.record({workspace:'w',actor:'check',canWrite:true},{trigger:'manual',startedAt:new Date().toISOString(),outcome:'failed',errors:[{rule:'示例',message:'示例故障'}],looked:[],candidates:[],silenced:[]});
  // 2026-10-14：设置里的「刷新运行状态」按钮已删（和重新打开这一页是同一件事，交互律 03 一个视图一个主动作）。
  // 刷新改回它本来的动作：关掉再打开设置。
  await page.evaluate(()=>document.querySelector('#veil .close')?.click());
  await new Promise(resolve=>setTimeout(resolve,300));
  await page.evaluate(()=>document.querySelector('#settings')?.click());
  await page.waitForFunction(()=>document.querySelector('#veil')?.classList.contains('open'),{timeout:8000});
  await page.evaluate(()=>{const details=document.querySelector('[data-settings-details="history"]');if(details)details.open=true});
  await page.waitForFunction(()=>/上次跑成/.test(document.querySelector('#heartbeatbody')?.textContent??''),{timeout:8000});
  const alerted = await page.evaluate(()=>{
   const alert=document.querySelector('#heartbeatbody [data-heartbeat-alert]');
   return {shown:!!alert, text:alert?.textContent??'', body:document.querySelector('#heartbeatbody').textContent};
  });
  check('连续两次没跑成 → 界面出现告警',alerted.shown,alerted.text.slice(0,80));
  check('告警带真实原因',/示例故障/.test(alerted.text),alerted.text.slice(0,80));
  check('告警期间"上次跑成"仍然可见（不掩盖历史成功）',/上次跑成/.test(alerted.body));

  // 入口不动：一级入口仍是 7 个（含设置），知识页签数不变。
  const entriesAfter = await page.evaluate(()=>document.querySelectorAll('.nav [data-view]').length);
  const tabsAfter = await page.evaluate(()=>document.querySelectorAll('#knowtabs button').length);
  check('一级入口数不变（'+entries+' → '+entriesAfter+'）',entries===entriesAfter);
  check('知识页签数不变（'+tabs+' → '+tabsAfter+'）',tabs===tabsAfter);
  check('没有页面错误',errors.length===0,errors.join('；'));
 } finally { await browser.close(); await new Promise(resolve=>server.close(resolve)); store.close(); }
 return {checks,failures};
}

if(process.argv[1]){
 const {checks,failures}=await main();
 for(const item of checks)console.log((item.ok?'  ok   ':'  FAIL ')+item.name+(item.ok?'':' → '+item.detail));
 console.log('─'.repeat(62));
 console.log(failures.length?'FAIL: 主动做事验收 '+failures.length+' 项未通过：'+failures.join('；'):'PASS: 主动做事（手动触发 + 留痕 + 告警）在真实浏览器里全部通过。');
 process.exit(failures.length?1:0);
}
