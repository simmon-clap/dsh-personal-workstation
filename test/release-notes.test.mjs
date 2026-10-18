import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

// G5 发布留证：发布说明必须与账本、包版本一致，且**不能少报未接入能力**。
const notes=readFileSync(new URL('../发布说明.md',import.meta.url),'utf8');
const ledger=readFileSync(new URL('../验收账本.md',import.meta.url),'utf8');
const manifest=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8'));
// 两个文档都是两列表格：能力 | 原因；剔除表头行，缺列的行不进入比较。
// 2026-10-14：取「某个 ## 小节」时必须**在下一个 ## 处截断**。原来用 slice(indexOf('## 未接入'))
// 把该小节之后的所有内容都算进来了 —— 发布说明在末尾追加新版本段落（里面也有表格）后，
// 未接入条目数就会被误算成 15（实际 8），测试反而挡住"在发布说明里写新版本"这件正常的事。
const sectionOf=(text,heading)=>{const start=text.indexOf(heading);if(start<0)return '';const rest=text.slice(start+heading.length);const next=rest.indexOf('\n## ');return next<0?rest:rest.slice(0,next)};
const capabilityRows=section=>section.split('\n').filter(line=>line.startsWith('| ')).filter(line=>!line.includes('---')).map(line=>line.split('|').map(cell=>cell.trim())[1]).filter(name=>name&&name!=='能力');

test('the release note states the packaged version and the exact artifact name',()=>{
 assert.match(notes,new RegExp('当前版本：\\*\\*'+manifest.version.replace(/\./g,'\\.')+'\\*\\*'),'发布说明版本必须与 package.json 一致');
 assert.match(notes,new RegExp('releases/dsh-personal-workstation-'+manifest.version.replace(/\./g,'\\.')+'\\.tgz'),'必须写明实际产物名');
 // W4-4：发布物只带公开文档；内部发布说明/验收账本留在仓库本地、不进包。
 assert(!manifest.files.includes('发布说明.md'),'内部发布说明不进公开包');
 assert(!manifest.files.includes('验收账本.md'),'内部账本不进公开包');
 assert(manifest.files.includes('CHANGELOG.md'),'公开 CHANGELOG 必须随包发布');
 const changelog=readFileSync(new URL('../CHANGELOG.md',import.meta.url),'utf8');
 assert(changelog.includes(manifest.version),'CHANGELOG 必须包含当前版本');
});

test('the release note never under-reports an unintegrated capability',()=>{
 const ledgerGaps=capabilityRows(sectionOf(ledger,'## 未接入能力'));
 const notesGaps=capabilityRows(sectionOf(notes,'## 未接入'));
 assert(ledgerGaps.length>=5,'账本应当逐项列出未接入能力');
 for(const gap of ledgerGaps){
  const keyword=gap.split('、')[0].replace(/（.*?）/g,'').trim();
  assert(notesGaps.some(row=>row.includes(keyword)),'发布说明漏报了未接入能力：'+gap);
 }
 assert.equal(notesGaps.length,ledgerGaps.length,'发布说明与账本的未接入条目数必须一致，多写或漏写都算不一致');
});

test('the release note repeats the facts a user must know before expecting features',()=>{
 assert.match(notes,/安装不等于加载/,'必须说明安装不等于加载');
 assert.match(notes,/必须\*\*重启 DSH\*\*|必须重启 DSH/,'必须写明要重启');
 assert.match(notes,/没有 `fileGrants`/,'必须说明文件功能需要配置 fileGrants');
 assert.match(notes,/首次录音/,'必须说明语音模型在首次录音时下载');
 assert.match(notes,/不写入生产数据/,'必须说明验证不写入生产数据');
});

test('the stated acceptance counts match the ledger',()=>{
 const verified=(ledger.match(/\| 已验证 \|/g)??[]).length;
 const partial=(ledger.match(/\| 部分验证 \|/g)??[]).length;
 const claimed=/共 45 条：\*\*(\d+) 条已验证、(\d+) 条部分验证\*\*/.exec(notes);
 assert(claimed,'发布说明必须写明账本统计');
 assert.equal(Number(claimed[1]),verified,'已验证条数必须与账本一致');
 assert.equal(Number(claimed[2]),partial,'部分验证条数必须与账本一致');
});

test('the release note gives a restart checklist with expected results and failure signs',()=>{
 assert.match(notes,/## 重启后验收清单/,'必须给出重启后验收清单');
 for(const keyword of ['预期','失败判据'])assert(notes.includes(keyword),'清单必须包含：'+keyword);
 assert.match(notes,/把这条记为研究议题/,'IM 验收步骤必须给出可直接发送的示例消息');
 assert.match(notes,/没出现批次的排查顺序/,'必须给出排查顺序，而不是只说"有问题找我"');
 assert.match(notes,/allowedWorkspaces/,'排查必须点到工作台授权这一层');
 assert.match(notes,/审批策略为 never/,'必须解释提交被拒的常见原因');
});
