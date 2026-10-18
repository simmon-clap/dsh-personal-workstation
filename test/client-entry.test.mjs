import {test} from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {runInNewContext} from 'node:vm';
function load(frames){let plugin;const calls=[],posts=[];const listeners=new Map();
 const document={querySelectorAll:selector=>{const title=/title="([^"]+)"/.exec(selector)?.[1];return title&&frames.has(title)?[{contentWindow:{postMessage:(message,origin)=>posts.push({title,message,origin})}}]:[]}};
 runInNewContext(readFileSync(new URL('../client/client.js',import.meta.url),'utf8'),{location:{origin:'https://host.test'},document,window:{addEventListener(){},removeEventListener(){},__ModuleLoader__:{load({id,factory}){assert.equal(id,'dsh-personal-workstation');plugin=factory(name=>{assert.equal(name,'react');return {createElement:(type,props,...children)=>({type,props,children})}})}}}});
 const effects=[];
 plugin.apply({theme:{getTheme:()=>({active:{colorScheme:frames.scheme??'light'}})},on:(name,handler)=>{const list=listeners.get(name)??[];list.push(handler);listeners.set(name,list);return ()=>{}},effect:run=>{effects.push(run());return ()=>{}},slots:{inject(name,fn){fn()},register(meta,render){calls.push({meta,render});return ()=>{}}},
  // 宿主 Cordis 真有 inject(name,fn)→ fn(scope)；chat 桥整段依赖它。桩缺了它 = 门禁比现实弱。
  inject(names,fn){fn({uiWorkspace:{startSession(){}},effect(run){run();return ()=>{}}});return ()=>{}}});
 return {plugin,calls,posts,listeners,effects};
}
test('native client registers matching sidebar and main slots with same-origin page',()=>{
 const frames=new Map([['个人工作台',true],['工作台旧界面',true]]);frames.scheme='light';
 const {plugin,calls}=load(frames);
 assert.equal(JSON.stringify(plugin.inject),JSON.stringify(['slots','theme']),'必须声明 theme 依赖才能跟随 Host 配色');
 const mains=calls.filter(entry=>entry.meta.name==='main'),navs=calls.filter(entry=>entry.meta.name==='sidebar.panellist');
 assert.equal(mains.length,1,'侧栏与主区都只能有一个工作台入口');
 assert.equal(navs.length,1,'不应再注册「工作台旧界面」入口');
 const frame=mains[0].render();assert.equal(frame.type,'iframe');
 assert.equal(frame.props.src,'/personal-workstation?theme=light','首屏必须带上当前配色，避免先浅后深闪烁');
 assert.equal(frame.props.title,'个人工作台');
 assert.equal(mains[0].meta.key,navs[0].meta.id);assert.equal(navs[0].meta.label,'个人工作台');
 assert(!calls.some(entry=>String(entry.meta.key??entry.meta.id).includes('legacy')),'旧界面入口必须彻底移除');
 const manifest=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8'));
 assert.equal(manifest.exports['./client'],'./client/client.js');assert.equal(manifest.dsh.client.platform,'web');
});
test('the client relays Host theme changes into the frame instead of reloading it',()=>{
 const frames=new Map([['个人工作台',true]]);frames.scheme='dark';
 const {posts,listeners}=load(frames);
 assert(listeners.has('theme/change'),'必须订阅 theme/change');
 for(const handler of listeners.get('theme/change'))handler();
 assert.equal(JSON.stringify(posts),JSON.stringify([{title:'个人工作台',message:{type:'workstation:theme',scheme:'dark'},origin:'https://host.test'}]),'必须把深色通过 postMessage 通知同源的 iframe');
});
