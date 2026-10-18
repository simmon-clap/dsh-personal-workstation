import {test} from 'node:test';import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync,existsSync} from 'node:fs';
import {Config} from '../src/config-schema.mjs';
import {resolveConfig} from '../src/index.mjs';

/** 真实激活路径重放：DSH 会先把 Config 的默认值**物化**成一份配置再交给 resolveConfig。
 *  两次激活失败（1.1.0 的 execution、1.6.1 的 appleCalendar）都是因为"schema 里声明了新键、
 *  resolveConfig 的白名单没跟上"。这个测试就是那道闸门：**schema 里有的键，resolveConfig 必须接受**。 */

function hostSchema(){
 try{
  const require_=createRequire(process.env.DSH_HOME ? process.env.DSH_HOME + '/profiles/desktop/package.json' : require('node:path').join(require('node:os').homedir(), '.dsh', 'profiles', 'desktop', 'package.json'));
  for(const id of ['@deepseek-ai/schemastery','schemastery']){try{return require_(id)}catch{}}
 }catch{}
 return null;
}
function unwrap(value){
 if(value&&typeof value.get==='function')return value.get();
 if(Array.isArray(value))return value.map(unwrap);
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,unwrap(item)]));
 return value;
}
/** 一份合法的最小配置（与用户 profile 里的真实配置同形）。 */
function baseline(){
 const dataDirectory=process.env.WORKSTATION_TEST_DATA??'/tmp/workstation-activation-test';
 return {dataDirectory,allowedWorkspaces:['w'],fileGrants:[],transcribeWithoutApproval:true};
}

test('DSH 物化出来的每一配置键都必须被 resolveConfig 接受（防止再次激活失败）',t=>{
 const schema=hostSchema();
 if(!schema){t.skip('本机拿不到 @deepseek-ai/schemastery，跳过真实物化重放');return}
 const materialized=unwrap(new Config({}));
 const keys=Object.keys(materialized);
 assert(keys.includes('appleCalendar'),'Config 里必须先声明 appleCalendar');
 let resolved;
 assert.doesNotThrow(()=>{resolved=resolveConfig({...materialized,...baseline()})},'物化后的配置必须能通过 resolveConfig');
 // 新键解析结果要真的可用，而不是被默默丢掉
 assert.equal(resolved.appleCalendar.enabled,true);
 assert.equal(resolved.appleCalendar.targetCalendar,'个人工作台');
 assert.equal(resolved.appleCalendar.pastDays,30);
 assert.equal(resolved.appleCalendar.futureDays,30);
 assert.deepEqual(resolved.appleCalendar.includeCalendars,[]);
});

test('volatile 包装形态（设置页热改后的样子）也要能通过',t=>{
 const schema=hostSchema();
 if(!schema){t.skip('本机拿不到 schemastery，跳过');return}
 const live=new Config({});
 assert.doesNotThrow(()=>resolveConfig({...live,...baseline()}));
});

test('苹果日历配置：逗号分隔转数组、天数夹在 0–365、目标日历兜底',()=>{
 const resolved=resolveConfig({...baseline(),appleCalendar:{enabled:false,targetCalendar:'  我的日历  ',includeCalendars:'个人安排, 飞行计划 ,,',excludeCalendars:'家庭',pastDays:999,futureDays:-5}});
 assert.equal(resolved.appleCalendar.enabled,false);
 assert.equal(resolved.appleCalendar.targetCalendar,'我的日历');
 assert.deepEqual(resolved.appleCalendar.includeCalendars,['个人安排','飞行计划']);
 assert.deepEqual(resolved.appleCalendar.excludeCalendars,['家庭']);
 assert.equal(resolved.appleCalendar.pastDays,365,'最多夹紧');
 assert.equal(resolved.appleCalendar.futureDays,0,'下限夹紧');
});

test('未知配置键仍然要被拒绝（白名单不能形同虚设）',()=>{
 assert.throws(()=>resolveConfig({...baseline(),notARealKey:1}),/未知工作台配置项/);
});
