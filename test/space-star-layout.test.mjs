import test from 'node:test';
import assert from 'node:assert/strict';
import {nodeSize,spaceLayout,starLayout,wasColumnLayout} from '../prototype/space-view-v5.mjs';

const nodes=[
 {id:'p1',kind:'project',title:'项目一'},{id:'p2',kind:'project',title:'项目二'},
 {id:'t1',kind:'task',title:'任务一'},{id:'t2',kind:'task',title:'任务二'},
 {id:'j1',kind:'judgment',title:'判断一'},{id:'a1',kind:'artifact',title:'资料一'},
];
const edges=[
 {from:'p1',to:'t1',status:'confirmed'},{from:'p1',to:'t2',status:'confirmed'},
 {from:'t1',to:'j1',status:'confirmed'},{from:'p1',to:'a1',status:'confirmed'},
 {from:'p2',to:'t2',status:'confirmed'},
];

test('星点布局：焦点项目在中心，一度邻居在更外圈', () => {
 const pos=starLayout(nodes,edges,'p1');
 assert.deepEqual(pos.p1,{x:0,y:0});
 const dist=id=>Math.hypot(pos[id].x,pos[id].y);
 assert.ok(dist('t1')>0);
 assert.ok(dist('j1')>dist('t1'),'二度关系必须比一度更远');
});

test('旧列布局能被识别，星点布局不会退回列布局', () => {
 assert.equal(wasColumnLayout(spaceLayout(nodes)),true);
 assert.equal(wasColumnLayout(starLayout(nodes,edges,'p1')),false);
});

test('类型决定基础尺寸：项目大于任务，任务大于资料', () => {
 const p=nodeSize('project',2),t=nodeSize('task',2),a=nodeSize('artifact',2);
 assert.ok(p.w>t.w && p.h>t.h);
 assert.ok(t.w>a.w && t.h>a.h);
});
