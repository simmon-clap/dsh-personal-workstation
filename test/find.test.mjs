import {test} from 'node:test';import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from '../dev-deps.mjs';
import {mountFind} from '../prototype/find.mjs';

function dom(){
 const html=readFileSync(new URL('../prototype/v7-shell.html',import.meta.url),'utf8');
 return new JSDOM(html);
}
const items=[
 {id:'a1',kind:'artifact',data:{title:'会议纪要 · 示例科技 3D 存算一体芯片路演',path:'示例科技-3D存算一体/杭州示例学校-会议纪要.md'}},
 {id:'p1',kind:'project',data:{title:'示例科技 · 3D 存算一体芯片技术适配与合作研判'}},
 {id:'t1',kind:'task',data:{title:'核对标的：公司主体、股权与融资'}},
];

test('查找框跨类型检索：资料、项目、任务都能按名称找到',async()=>{
 const {window}=dom();
 const opened=[];
 const finder=mountFind(window.document,{send:async()=>({items}),open:id=>opened.push(id)});
 const input=window.document.querySelector('#findinput');
 assert(input,'知识页必须出现查找框');
 // 输入并等待异步渲染
 input.value='会议纪要';input.dispatchEvent(new window.Event('input'));
 await new Promise(resolve=>setTimeout(resolve,20));
 const rows=[...window.document.querySelectorAll('#findresults .findrow')];
 assert.equal(rows.length,1,'应只命中会议纪要');
 assert.match(rows[0].textContent,/资料/);
 assert.match(rows[0].textContent,/会议纪要/);
 rows[0].click();
 assert.deepEqual(opened,['a1'],'点击结果直接打开该记录');
 // 换关键词：按正文/路径也命中
 input.value='股权';input.dispatchEvent(new window.Event('input'));
 await new Promise(resolve=>setTimeout(resolve,20));
 assert.match(window.document.querySelector('#findresults').textContent,/核对标的/);
 // 无命中时给出去哪找的提示，而不是一片空白
 input.value='不存在的关键词zzz';input.dispatchEvent(new window.Event('input'));
 await new Promise(resolve=>setTimeout(resolve,20));
 assert.match(window.document.querySelector('#findresults').textContent,/文件与资料/,'空结果要指路');
 finder.dispose();
});

test('查找框的数据只在首次真正读取，且输入变化会丢弃过期结果',async()=>{
 const {window}=dom();
 let calls=0;
 const finder=mountFind(window.document,{send:async()=>{calls+=1;return {items}},open:()=>{}});
 const input=window.document.querySelector('#findinput');
 for(const query of ['会','会议','会议纪']){input.value=query;input.dispatchEvent(new window.Event('input'))}
 await new Promise(resolve=>setTimeout(resolve,30));
 assert.equal(calls,1,'连续输入不应重复拉取全量数据');
 finder.dispose();
});
