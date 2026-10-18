import {readFileSync} from 'node:fs';import assert from 'node:assert/strict';
import {JSDOM} from '../dev-deps.mjs';
const original=readFileSync(new URL('../../工作台-视觉原型-v7.html',import.meta.url),'utf8');
const replica=readFileSync(new URL('./replica/index.html',import.meta.url),'utf8');
const reconstructed=replica.replace(/<script src="\.\/([\w-]+)\.js"><\/script>/g,(_,name)=>'<script>'+readFileSync(new URL('./replica/'+name+'.js',import.meta.url),'utf8')+'</script>');
assert.equal(reconstructed,original,'split and rejoined source must match exactly');
function load(html){const errors=[];const dom=new JSDOM(html,{runScripts:'dangerously',pretendToBeVisual:true,beforeParse(w){w.ResizeObserver=class{observe(){}disconnect(){}};w.addEventListener('error',e=>errors.push(e.message));}});assert.deepEqual(errors,[]);return dom;}
const a=load(original),b=load(reconstructed);try{assert.equal(a.window.document.documentElement.outerHTML,b.window.document.documentElement.outerHTML);for(const name of ['home','space','projects','tasks','knowledge','personal']){a.window.eval('show('+JSON.stringify(name)+')');b.window.eval('show('+JSON.stringify(name)+')');assert.equal(a.window.document.documentElement.outerHTML,b.window.document.documentElement.outerHTML,'navigation parity '+name);}console.log('PASS: exact source reconstruction, initialized DOM and all six page navigation states match V7. No pixel or live-data acceptance claimed.');}finally{a.window.close();b.window.close();}
