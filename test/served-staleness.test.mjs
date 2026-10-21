import {test} from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync,readFileSync,cpSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {createAssetIndex} from '../src/v7-assets.mjs';

/** 2026-10-16 的真 bug：`needsRestart` 比的是"已加载文件的 mtime > 进程启动时间"。
 *  插件是**进程启动时加载**的，所以那个判据结构上恒为 false ——
 *  装了新构建、界面照样说"与正在运行的一致"（用户因此长期看到 5 天前的旧界面）。
 *  而且打 tar 包会保留源文件 mtime，时间戳本身也不可信。
 *
 *  现在的判据是**内容指纹**：内存里正在发的那份 == 磁盘上这份吗。
 *  这个测试在临时目录上验证它真的会随磁盘变化而变红。 */

const ROOT=fileURLToPath(new URL('../src/',import.meta.url));
function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'ws-assets-'));
 cpSync(join(ROOT,'v7'),join(dir,'v7'),{recursive:true});
 cpSync(join(ROOT,'v7-shell.html'),join(dir,'v7-shell.html'));
 return dir;
}

test('磁盘没变 → 不算陈旧（否则界面永远在喊"要重启"）',()=>{
 const dir=fixture();
 try{
  const index=createAssetIndex(join(dir,'v7'),join(dir,'v7-shell.html'));
  assert.equal(index.stale(),false);
 }finally{rmSync(dir,{recursive:true,force:true})}
});

test('装了新构建（磁盘变了）→ 必须报"陈旧"，这就是"需要重启才生效"',()=>{
 const dir=fixture();
 try{
  const index=createAssetIndex(join(dir,'v7'),join(dir,'v7-shell.html'));
  // 模拟"又装了一版"：改一个模块的内容（mtime 不变也算变化 —— 指纹比内容不比时间）
  const target=join(dir,'v7','space-view-v5.mjs');
  writeFileSync(target,readFileSync(target,'utf8')+'\n// 新版本\n');
  assert.equal(index.stale(),true,'磁盘内容变了却没报陈旧 —— needsRestart 又会恒为 false');
 }finally{rmSync(dir,{recursive:true,force:true})}
});

test('改了外壳（v7-shell.html）同样要报陈旧',()=>{
 const dir=fixture();
 try{
  const index=createAssetIndex(join(dir,'v7'),join(dir,'v7-shell.html'));
  writeFileSync(join(dir,'v7-shell.html'),readFileSync(join(dir,'v7-shell.html'),'utf8')+'\n<!-- v2 -->\n');
  assert.equal(index.stale(),true);
 }finally{rmSync(dir,{recursive:true,force:true})}
});

test('整棵资源树被换掉（模拟重装）→ 报陈旧',()=>{
 const dir=fixture();
 try{
  const index=createAssetIndex(join(dir,'v7'),join(dir,'v7-shell.html'));
  writeFileSync(join(dir,'v7','额外的新模块.mjs'),'export const added=true;\n');
  assert.equal(index.stale(),true,'多了新模块却没报陈旧');
 }finally{rmSync(dir,{recursive:true,force:true})}
});

test('读不到磁盘时返回 null（不猜），不假装"一致"',()=>{
 const dir=fixture();
 try{
  const index=createAssetIndex(join(dir,'v7'),join(dir,'v7-shell.html'));
  rmSync(join(dir,'v7'),{recursive:true,force:true});
  assert.equal(index.stale(),null);
 }finally{rmSync(dir,{recursive:true,force:true})}
});
