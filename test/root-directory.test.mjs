import {test} from 'node:test';import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {Config} from '../src/config-schema.mjs';
import {resolveConfig} from '../src/index.mjs';

/** 2026-10-16 实测的真 bug：`rootDirectory` 在 Config schema 里标了 volatile，
 *  宿主物化后传进来的是 `{get(){…}}` 而**不是字符串**。resolveConfig 当时按裸字符串读，
 *  于是拿到空值 → rootWorkspaceId 静默回退成"第一个已授权工作区" →
 *  设置页把根目录显示成别的文件夹（实测是「微信工作区」），文件授权也跟着指错。
 *
 *  为什么原来的门禁没抓到：`plugin-activation.test.mjs` 喂的是**普通字符串**，
 *  与宿主真正给的东西不同形。这个测试把"宿主那一套"钉死：
 *  **用真 schema 物化，再走 resolveConfig**。 */

function hostSchema(){
 try{
  const require_=createRequire(process.env.DSH_HOME ? process.env.DSH_HOME + '/profiles/desktop/package.json' : require('node:path').join(require('node:os').homedir(), '.dsh', 'profiles', 'desktop', 'package.json'));
  for(const id of ['@deepseek-ai/schemastery','schemastery']){try{return require_(id)}catch{}}
 }catch{}
 return null;
}

const ROOT='/workspace/飞书工作区';

test('rootDirectory 走宿主物化（volatile 包装）也必须能读出来',()=>{
 const schema=hostSchema();
 const dataDirectory='/tmp/workstation-root-test';
 const raw={dataDirectory,allowedWorkspaces:['w'],fileGrants:[],transcribeWithoutApproval:true,rootDirectory:ROOT};
 // ① 宿主的那套：schema 物化 → volatile 字段变成 {get()} 包装
 const throughHost=schema?new Config(raw):raw;
 const resolved=resolveConfig(throughHost);
 assert.equal(resolved.rootDirectory,ROOT,
  'rootDirectory 没读出来 —— 宿主传进来的是 volatile 包装（{get()}），必须 unwrap（这正是 2026-10-16 把根指成「微信工作区」的原因）');
});

test('普通字符串（配置文件形态）同样能读出来 —— 两种形态都要支持',()=>{
 const resolved=resolveConfig({dataDirectory:'/tmp/workstation-root-test',allowedWorkspaces:['w'],fileGrants:[],transcribeWithoutApproval:true,rootDirectory:ROOT});
 assert.equal(resolved.rootDirectory,ROOT);
});

test('没配 rootDirectory 时是空串（交给上层回退），不是包装对象',()=>{
 const resolved=resolveConfig({dataDirectory:'/tmp/workstation-root-test',allowedWorkspaces:['w'],fileGrants:[],transcribeWithoutApproval:true});
 assert.equal(resolved.rootDirectory,'');
 assert.equal(typeof resolved.rootDirectory,'string');
});
