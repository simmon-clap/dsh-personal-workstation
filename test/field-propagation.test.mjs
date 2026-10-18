import {test} from 'node:test';import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
const run=args=>{
 try{return {code:0,out:execFileSync(process.execPath,['prototype/field-propagation.mjs',...args],{encoding:'utf8',cwd:new URL('..',import.meta.url)})}}
 catch(error){return {code:error.status??1,out:String(error.stdout??'')+String(error.stderr??'')}}
};

test('every field the store accepts must declare where it shows up, and every declared surface must really reference it',()=>{
 const result=run([]);
 assert.equal(result.code,0,'字段传播门禁必须通过：\n'+result.out);
 assert.match(result.out,/PASS: \d+ 个字段 × \d+ 个界面面全部到位/);
});

test('the gate is not vacuous: an injected missing surface must make it fail',()=>{
 // 门禁自己带自检：人为注入一个必然缺失的声明，它必须报出来，否则说明这段代码没有真正生效。
 const result=run(['--self-test']);
 assert.equal(result.code,0,'自检必须通过：\n'+result.out);
 assert.match(result.out,/自检通过/);
});
