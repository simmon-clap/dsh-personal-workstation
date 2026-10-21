import fs from 'node:fs';
import path from 'node:path';
const root = decodeURIComponent(path.dirname(new URL(import.meta.url).pathname));
const file = '02-VI规范-v1.0.html';
const info = await (await fetch('http://127.0.0.1:19431/json/new?about:blank', { method: 'PUT' })).json();
const ws = new WebSocket(info.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r, { once: true }));
let id = 0; const pending = new Map(); const errors = [];
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.id) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(Error(m.error.message)) : p.resolve(m.result); }
  else if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.text);
};
const call = (method, params = {}) => new Promise((res, rej) => { const n = ++id; pending.set(n, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id: n, method, params })); });
const ev = async expr => (await call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result.value;
await call('Page.enable'); await call('Runtime.enable');
const out = [];
for (const [w, h] of [[1440, 1000], [390, 900]]) {
  await call('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  await call('Page.navigate', { url: 'file://' + encodeURI(root + '/' + file) });
  await ev('new Promise(r=>document.readyState==="complete"?r():addEventListener("load",r,{once:true}))');
  const metrics = await ev(`({
    width: innerWidth,
    scroll: document.documentElement.scrollWidth,
    sections: document.querySelectorAll('main>section').length,
    svgs: document.querySelectorAll('svg').length,
    brokenImages: [...document.images].filter(i=>!i.complete||i.naturalWidth===0).length,
    emptySvgs: [...document.querySelectorAll('main svg')].filter(s=>s.getBoundingClientRect().width===0).length,
    wideEls: [...document.querySelectorAll('main *')].filter(e=>e.getBoundingClientRect().right > innerWidth+2).slice(0,5).map(e=>e.tagName+'.'+(e.className||'').toString().slice(0,28))
  })`);
  out.push({ width: w, ...metrics });
  const shot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(path.join(root, `VI-${w}.png`), Buffer.from(shot.data, 'base64'));
}
// 深色切换
await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
await ev('document.querySelector("#theme").click()');
const darkOk = await ev('document.documentElement.dataset.theme === "dark"');
const shot2 = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
fs.writeFileSync(path.join(root, 'VI-dark.png'), Buffer.from(shot2.data, 'base64'));
console.log(JSON.stringify({ out, darkOk, errors }, null, 2));
ws.close();
const bad = errors.length || out.some(o => o.scroll > o.width + 1 || o.brokenImages || o.emptySvgs || o.wideEls.length);
process.exitCode = bad ? 1 : 0;
