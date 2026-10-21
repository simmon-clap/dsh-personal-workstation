import {test} from 'node:test';import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from '../dev-deps.mjs';
import {marqueeSelect,groupBounds,hiddenByGroups,capEdges} from '../prototype/space-view-v5.mjs';
import {validateData} from '../src/validation.mjs';
import {WorkstationStore} from '../src/store.mjs';
import {saveLayout,readLayout} from '../src/layout.mjs';

const placed=[
 {node:{id:'a',kind:'project'},position:{x:0,y:0}},
 {node:{id:'b',kind:'task'},position:{x:300,y:0}},
 {node:{id:'c',kind:'task'},position:{x:600,y:400}},
];

test('框选只选中与选框相交的对象，并给出分组包围盒',()=>{
 // 覆盖 a 与 b 的矩形（节点卡片 200×86）
 assert.deepEqual(marqueeSelect({x1:-10,y1:-10,x2:520,y2:120},placed),['a','b']);
 // 只覆盖 c
 assert.deepEqual(marqueeSelect({x1:560,y1:360,x2:900,y2:600},placed),['c']);
 // 什么都不覆盖
 assert.deepEqual(marqueeSelect({x1:1000,y1:1000,x2:1100,y2:1100},placed),[]);
 // 反向拖拽（右下→左上）与正向一致
 assert.deepEqual(marqueeSelect({x1:520,y1:120,x2:-10,y2:-10},placed),['a','b']);
 const box=groupBounds([placed[0],placed[1]]);
 assert.equal(box.x,-18,'左边距');assert.equal(box.width,(300+200)+36,'宽度覆盖两个卡片与左右边距（a 起点 0 → b 右边界 500）');
 assert.ok(box.height>86,'高度须包含标题行与上下边距');
 assert.equal(groupBounds([]),null,'没有成员时不给包围盒');
});

test('折叠分组只隐藏成员（视图层），不改业务数据',()=>{
 const groups=[{id:'g1',title:'组',nodeIds:['a','b'],collapsed:true},{id:'g2',title:'组2',nodeIds:['c'],collapsed:false}];
 const hidden=hiddenByGroups(groups);
 assert.deepEqual([...hidden],['a','b']);
 assert.deepEqual([...hiddenByGroups([])],[]);
});

test('分组是布局层数据：检查只认 ID/名称/成员/折叠，且成员必须真实存在',()=>{
 const viewport={x:0,y:0,zoom:1};
 validateData('layout',{positions:{},viewport,groups:[{id:'g1',title:'示例科技相关',nodeIds:['a'],collapsed:false}]});
 assert.throws(()=>validateData('layout',{positions:{},viewport,groups:[{id:'g1',title:'x',nodeIds:[]}]}),/至少一个成员/);
 assert.throws(()=>validateData('layout',{positions:{},viewport,groups:[{id:'g1',title:'x',nodeIds:['a'],owner:'me'}]}),/格式无效/);
 // 服务端保存时再查一次：分组不能引用不存在/已归档的对象
 const store=new WorkstationStore(':memory:'),ctx={workspace:'w',actor:'t',canWrite:true};
 try{
  const seed=store.draft(ctx,{title:'种子',changes:[{op:'create',id:'p1',kind:'project',data:{title:'项目'}}]});
  store.commit(ctx,{batchId:seed.id,revision:1,key:'k1'});
  saveLayout(store,ctx,{view:'space',revision:0,positions:{p1:{x:1,y:2}},viewport,groups:[{id:'g1',title:'组',nodeIds:['p1']}],key:'layout-1'});
  assert.equal(readLayout(store,ctx,'space').data.groups.length,1,'分组随布局一起保存');
  assert.throws(()=>saveLayout(store,ctx,{view:'space',revision:1,positions:{p1:{x:1,y:2}},viewport,groups:[{id:'g2',title:'组',nodeIds:['nope']}],key:'layout-2'}),/不存在或已归档/);
 }finally{store.close()}
});

test('the canvas exposes box-select, batch actions and grouping in the shipped module',()=>{
 const source=readFileSync(new URL('../prototype/space-view-v5.mjs',import.meta.url),'utf8');
 for(const needle of ['marqueeSelect','canvasbar','canvasgroup','canvasassign','canvasconfirm','canvasignore','canvasarchive','canvasselect','syncBar']){
  assert(source.includes(needle),'画布必须提供：'+needle);
 }
 // 分组随布局保存（不是另一条写入路径）
 assert.match(source,/layout_save',\{view:'space',revision,positions:snapshot,viewport,groups:/);
 // Shift+点击＝多选；Esc 清空选择
 assert.match(source,/event\.shiftKey/);
 assert.match(source,/selection\.size\)\{selection=new Set\(\)/);
});

test('画布第 2 批：手动连线当场问清关系与依据，保存即生效（不再走待确认流程）',()=>{
 const source=readFileSync(new URL('../prototype/space-view-v5.mjs',import.meta.url),'utf8');
 // 用户 2026-10-12：手动连线原来生成"待确认的改动"，而"关系需要文本证据"是硬规则，
 // 结果点同意必报错 → 死路。现在改成当场问清楚：类型 + 一句话依据。
 assert.match(source,/askLink\(/,'连线必须先问清关系与依据');
 assert.match(source,/data-linktype/,'必须能选关系类型');
 assert.match(source,/data-linkbasis/,'必须填一句话依据');
 assert.match(source,/batch\.apply\(/,'保存要直接生效（apply），不是又生成待确认的改动');
 assert.doesNotMatch(source,/batch\.draft\('画布手动关联/,'不得再把手动连线做成待确认的改动');
 assert.match(source,/evidence:answer\.basis/,'依据必须写进关系的 evidence，提交时才不会因缺依据被拒');
 assert.match(source,/手动连线（人工确认，不是模型推断）|你在画布上手动连线/,'来源要如实标注是人工确认');
 // 重复连线仍要拦住
 assert.match(source,/这两个对象之间已经有关联了/);
 // 弹窗必须走全站唯一实现（modal.mjs）：第 12 轮实测这里曾自己造 veil 外壳，
 // 是**全站第二套弹窗**（几何/焦点/关闭口径不一致）。第 17 轮改为 sharedModal 后加这条回归断言。
 assert.match(source,/modal\.present\(request,\{title:'建立关联'/,'连线弹窗必须走 modal.mjs 的唯一实现');
 assert.doesNotMatch(source,/createElement\('div'\);veil\.className='veil|className='veil open'/,'不得再手搓 veil 外壳');
});

test('画布第 3 批：撤销/重做、导出、无右键菜单、高连接分页都在，且不直接写业务数据',()=>{
 const source=readFileSync(new URL('../prototype/space-view-v5.mjs',import.meta.url),'utf8');
 // 撤销/重做只作用于视图层（位置与分组），并随保存写入 layout
 assert.match(source,/const history=\{past:\[\],future:\[\]\}/);
 assert.match(source,/function undo\(\)/);assert.match(source,/function redo\(\)/);
 assert.match(source,/event\.shiftKey\)redo\(\);else undo\(\)/,'Cmd/Ctrl+Z 撤销、Shift+Cmd/Ctrl+Z 重做');
 // 导出：SVG 直接序列化，PNG 走 canvas 光栅化
 assert.match(source,/downloadFile/);assert.match(source,/image\/svg\+xml/);assert.match(source,/toBlob/);
 // 2026-10-14（用户点名「画布仍然有右键点击的很多多余的功能」）：两个右键菜单已删除。
 // 依据宪章六「克制：新元素必须证明无法被现有元素表达」+ §7「不依赖隐藏手势」：
 // 节点菜单 7 项与空白菜单 3 项没有一项是别处表达不了的（单击/双击/拖圆点/常驻按钮/详情里的编辑）。
 // 这里反过来守住"不许长回来"。
 assert.ok(!source.includes('contextmenu'),'画布不许再挂右键菜单（隐藏手势）');
 assert.ok(!source.includes('nodeMenu'),'节点右键菜单已删除，不许回退');
 assert.ok(!/showMenu|canvasmenu/.test(source),'空白右键菜单已删除，不许回退');
 // 节点上的增删改仍要可达——但走详情弹窗里的编辑，不再是画布右键：
 const detail=readFileSync(new URL('../prototype/record-detail.mjs',import.meta.url),'utf8');
 assert.match(detail,/organization:'organization',person:'person'/,'详情弹窗必须能编辑联系人与组织');
 const editor=readFileSync(new URL('../prototype/editor.mjs',import.meta.url),'utf8');
 for(const label of ['归档…','删除…'])assert(editor.includes(label),'编辑弹窗必须提供：'+label);
 assert.match(editor,/op:'archive'/);assert.match(editor,/op:'delete'/);
 // 双击打开详情（单击仍按 PRD 聚焦展开）
 assert.match(source,/'dblclick'/);
 // 高连接分页：按节点上限保留，并在状态栏如实计数
 assert.match(source,/EDGES_PER_NODE=12/);assert.match(source,/已隐藏/);
});

test('高连接分页：单节点超过最多就折叠，且已确认的关系优先保留',()=>{
 const edges=[];
 for(let index=0;index<20;index+=1)edges.push({id:'s'+index,from:'hub',to:'n'+index,status:'suggested'});
 edges.push({id:'confirmed-1',from:'hub',to:'重要节点',status:'confirmed'});
 const {kept,dropped}=capEdges(edges,3);
 assert.equal(kept.length,3,'最多内只画 3 条');
 assert.equal(kept[0].id,'confirmed-1','已确认的关系必须优先保留');
 assert.ok(dropped.length>0,'其余如实计入被隐藏');
 // 上限内的图不受影响
 const small=capEdges([{id:'a',from:'x',to:'y',status:'suggested'}],12);
 assert.equal(small.dropped.length,0);
});
