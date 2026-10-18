import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

// G5：账本必须可核对。标为「已验证」的条款必须引用真实存在的测试/脚本证据；
// 标为「未接入」的条款不得引用任何测试——否则就是拿措辞冒充完成度。
const root=fileURLToPath(new URL('..',import.meta.url));
const ledger=readFileSync(new URL('../验收账本.md',import.meta.url),'utf8');
const statuses=['已验证','部分验证','未接入','设计不支持'];
const rows=ledger.split('\n').filter(line=>line.startsWith('| ')&&line.includes(' | '))
 .map(line=>line.split('|').map(cell=>cell.trim()))
 .map(cells=>({id:cells[1],clause:cells[2],status:cells[3],evidence:cells[4]??'',note:cells[5]??''}))
 // 只保留看起来像条款 ID 的行；未知 ID 不能靠「不匹配」被静默忽略，下面会单独报错。
 .filter(row=>/^[A-Za-z0-9.-]+-\d+[a-z]?$/.test(row.id));
const citations=text=>[...text.matchAll(/`(test\/[^`]+?\.test\.mjs::[^`]+)`/g)].map(match=>match[1])
 .concat([...text.matchAll(/`(script:[^`]+::[^`]+)`/g)].map(match=>match[1]))
 .concat([...text.matchAll(/`(doc:[^`]+::[^`]+)`/g)].map(match=>match[1]));
function resolve(citation){
 const [target,needle]=citation.split('::');
 const path=target.startsWith('script:')||target.startsWith('doc:')?target.replace(/^(?:script|doc):/,'/'):'/'+target;
 const file=root.replace(/\/$/,'')+path;
 if(!existsSync(file))return {ok:false,reason:'文件不存在：'+path};
 const body=readFileSync(file,'utf8');
 if(target.startsWith('test/'))return body.includes(needle)?{ok:true}:{ok:false,reason:'测试标题不存在于 '+path+'：'+needle};
 return body.includes(needle)?{ok:true}:{ok:false,reason:'脚本中找不到该证据：'+path+' :: '+needle};
}
const expected=[];
for(let i=1;i<=10;i+=1)expected.push('v1.0-'+i);
for(let i=1;i<=10;i+=1)expected.push('IN-AC-'+i);
for(let i=1;i<=7;i+=1)expected.push('v1.2-'+i);
for(let i=1;i<=8;i+=1)expected.push('CH-06-'+i);
for(let i=1;i<=10;i+=1)expected.push('VI-'+i);

test('the ledger covers every PRD and VI acceptance item exactly once',()=>{
 const ids=rows.map(row=>row.id);
 assert.deepEqual([...ids].sort(),[...expected].sort(),'账本必须恰好覆盖全部验收条款；多出的 ID 也算错误，不能靠守卫忽略它');
 const unknown=[...ledger.matchAll(/^\| *([A-Za-z][A-Za-z0-9.-]*-\d+[a-z]?) *\|/gm)].map(match=>match[1]).filter(id=>!expected.includes(id));
 assert.deepEqual(unknown,[],'账本出现了未定义的条款 ID：'+unknown.join('、'));
 assert.equal(new Set(ids).size,ids.length,'条款 ID 不得重复');
 for(const row of rows)assert(statuses.includes(row.status),row.id+' 的状态必须是 '+statuses.join('/')+'，实际：'+row.status);
});
test('every cited piece of evidence actually exists',()=>{
 const failures=[];
 for(const row of rows)for(const citation of citations(row.evidence)){
  const result=resolve(citation);
  if(!result.ok)failures.push(row.id+' → '+result.reason);
 }
 assert.deepEqual(failures,[],'账本引用了不存在的证据：\n'+failures.join('\n'));
});
test('verified items carry evidence, unintegrated items carry none',()=>{
 const problems=[];
 for(const row of rows){
  const cites=citations(row.evidence);
  if(row.status==='已验证'&&!cites.length)problems.push(row.id+' 标为已验证却没有证据');
  if(['未接入','设计不支持'].includes(row.status)&&cites.length)problems.push(row.id+' 标为 '+row.status+' 却引用了测试证据');
  if(row.status==='部分验证'&&(!cites.length||row.note.length<8))problems.push(row.id+' 标为部分验证必须既有证据又写明缺口');
 }
 assert.deepEqual(problems,[],problems.join('\n'));
});
test('unintegrated capabilities are listed with a reason instead of a test',()=>{
 const section=ledger.slice(ledger.indexOf('## 未接入能力'));
 // 该表为两列：能力 | 原因。
 const lines=section.split('\n').filter(line=>line.startsWith('| ')&&!line.includes('---')&&!line.includes('| 能力 |'));
 assert(lines.length>=4,'未接入能力必须逐项列出');
 for(const line of lines){
  const [,capability,reason]=line.split('|').map(cell=>cell.trim());
  assert(capability,'未接入能力必须写明名称：'+line);
  assert(reason&&reason.length>=8,'未接入能力必须写明原因：'+line);
  assert(!citations(line).length,'未接入能力不得引用测试证据：'+line);
  assert(!/test\/[^\s`|]+\.test\.mjs/.test(line),'未接入能力不得引用测试文件，哪怕是附带提及：'+line);
 }
});
test('the ledger states the composition limits it is verified against',()=>{
 assert.match(ledger,/runtime_status 实测 `calendarSync\/deviceSync=false`/,'必须记录实测到的运行能力，不能凭空声称已接入');
 assert.match(ledger,/需用户提供地址与身份授权/,'外部接入必须写明前置条件');
});
