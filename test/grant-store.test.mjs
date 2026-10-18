import {test} from 'node:test';import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createGrantStore,validateRoot} from '../src/grant-store.mjs';
import {createWorkspaceFs} from '../src/workspace-fs.mjs';

const scratch=()=>mkdtempSync(join(tmpdir(),'grant-check-'));

test('a folder can be authorised at runtime, and the grant survives a reload',()=>{
 const home=scratch(),workspace=join(home,'ws'),data=join(home,'data');
 mkdirSync(join(workspace,'资料'),{recursive:true});
 try{
  const store=createGrantStore({directory:data,workspaceRoots:()=>({w:workspace})});
  store.add({id:'g1',workspace:'w',root:join(workspace,'资料'),read:true,write:false,label:'资料'});
  assert.equal(store.list('w').length,1);
  // 重新加载（相当于重启）后授权仍在：授权是数据，不是内存状态
  const reloaded=createGrantStore({directory:data,workspaceRoots:()=>({w:workspace})});
  assert.deepEqual(reloaded.list('w').map(g=>g.root),[join(workspace,'资料')]);
  assert.match(readFileSync(join(data,'grants.json'),'utf8'),/资料/,'授权必须落盘');
  reloaded.remove('g1');
  assert.equal(createGrantStore({directory:data,workspaceRoots:()=>({w:workspace})}).list('w').length,0);
 }finally{rmSync(home,{recursive:true,force:true})}
});
test('authorisation refuses paths outside the workspace, files, and the filesystem root',()=>{
 const home=scratch(),workspace=join(home,'ws');
 mkdirSync(workspace,{recursive:true});
 writeFileSync(join(workspace,'note.txt'),'x');
 try{
  const store=createGrantStore({directory:join(home,'data'),workspaceRoots:()=>({w:workspace})});
  assert.throws(()=>store.add({id:'x',workspace:'w',root:'/etc'}),/只能授权工作台数据目录里/);
  assert.throws(()=>store.add({id:'x',workspace:'w',root:'/'}),/文件系统根目录/);
  assert.throws(()=>store.add({id:'x',workspace:'w',root:join(workspace,'note.txt')}),/只能授权文件夹/,'工作区内的单个文件也不能被授权为目录');
  assert.throws(()=>store.add({id:'x',workspace:'w',root:join(workspace,'不存在')}),/目录不存在/);
  assert.throws(()=>store.add({id:'x',workspace:'w',root:join(workspace,'a'),write:true,read:false}),/写权限必须同时有读权限/);
  assert.equal(store.list('w').length,0,'被拒绝的授权不得留下任何记录');
 }finally{rmSync(home,{recursive:true,force:true})}
});
test('directories can be listed and created inside the workspace, and traversal is refused',()=>{
 const home=scratch(),workspace=join(home,'ws');
 mkdirSync(join(workspace,'项目'),{recursive:true});
 mkdirSync(join(workspace,'.hidden'),{recursive:true});
 writeFileSync(join(workspace,'随手记.txt'),'x');
 try{
  const fs1=createWorkspaceFs();
  const top=fs1.list(workspace,'');
  assert.deepEqual(top.items.map(item=>item.name),['项目'],'只列目录、跳过隐藏目录');
  const created=fs1.create(workspace,'','会议录音');
  assert.equal(created.path,'会议录音');
  assert.deepEqual(fs1.list(workspace,'').items.map(item=>item.name),['会议录音','项目'].sort((a,b)=>a.localeCompare(b,'zh')));
  assert.deepEqual(fs1.list(workspace,'项目').path,'项目');
  assert.throws(()=>fs1.list(workspace,'../..'),/不能包含 \.\./);
  assert.throws(()=>fs1.list(workspace,'/etc'),/请使用工作区内的相对路径/,'绝对路径不能被静默当成相对路径');
  assert.throws(()=>fs1.create(workspace,'','../逃逸'),/不能包含斜杠或 \.\./);
  assert.throws(()=>fs1.create(workspace,'','会议录音'),/已存在/);
 }finally{rmSync(home,{recursive:true,force:true})}
});
test('validateRoot keeps the workspace boundary even for nested folders',()=>{
 const home=scratch(),workspace=join(home,'ws');
 mkdirSync(join(workspace,'a/b'),{recursive:true});
 try{
  assert.equal(validateRoot(join(workspace,'a/b'),{workspaceRoot:workspace}),join(workspace,'a/b'));
  assert.throws(()=>validateRoot(join(home,'other'),{workspaceRoot:workspace}),/只能授权工作台数据目录里/);
  assert.throws(()=>validateRoot('相对路径',{workspaceRoot:workspace}),/绝对路径/);
 }finally{rmSync(home,{recursive:true,force:true})}
});

test('a runtime grant immediately makes a folder readable through the file service',async()=>{
 const {HostFiles}=await import('../src/host-files.mjs');
 const home=mkdtempSync(join(tmpdir(),'grant-live-')),workspace=join(home,'ws');
 mkdirSync(join(workspace,'资料'),{recursive:true});
 writeFileSync(join(workspace,'资料','会议.md'),'# 会议\n试点范围跟进。');
 try{
  // 与插件里一致：HostFiles 拿到的是"配置授权 + 运行时授权"的取函数
  const store=createGrantStore({directory:join(home,'data'),workspaceRoots:()=>({w:workspace})});
  // 宿主文件服务用**不透明目标**（不是裸路径）：resolve 返回 target、contains 判边界、
  // processPath 只用于定位。这里用真实文件系统实现这套契约。
  const {statSync,readFileSync}=await import('node:fs');
  const {resolve:resolvePath}=await import('node:path');
  const fsShim={
   async resolve(pathOrTarget,options){
    const base=typeof pathOrTarget==='string'&&options?.cwd?options.cwd:pathOrTarget;
    const target=resolvePath(typeof pathOrTarget==='string'?join(base,pathOrTarget===base?'.':pathOrTarget):base);
    return {targetKey:target,target};
   },
   processPath(target){return target.target},
   contains(root,target){const prefix=root.target.endsWith('/')?root.target:root.target+'/';return target.target===root.target||target.target.startsWith(prefix)},
   async stat(target){try{const info=statSync(target.target);return {type:info.isDirectory()?'directory':'file',size:info.size,version:String(info.mtimeMs)}}catch{return null}},
   async readBytes(target){return new Uint8Array(readFileSync(target.target))},
  };
  const files=new HostFiles(fsShim,()=>[...store.list('w')]);
  const ctx={workspace:'w',actor:'operator',canWrite:true};
  await assert.rejects(()=>files.read(ctx,{grantId:'g1',path:'会议.md'}),/未授权|授权/, '授权之前不得读取');
  store.add({id:'g1',workspace:'w',root:join(workspace,'资料'),read:true,write:false,label:'资料'});
  files.refresh(); // 界面点授权后立刻刷新，不必重启
  const read=await files.read(ctx,{grantId:'g1',path:'会议.md'});
  assert.match(read.content,/试点范围跟进/,'授权之后应立即可读');
 }finally{rmSync(home,{recursive:true,force:true})}
});
