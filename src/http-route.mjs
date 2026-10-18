import {REQUEST_MAX_BYTES} from './limits.mjs';
import {browserRoute} from './browser-api.mjs';
import {v7AssetRoutes} from './v7-assets.mjs';
import {filePreviewRoute} from './file-preview-route.mjs';
/** Bridge exact plugin endpoints to the existing DSH HTTP server. */
export function httpRoute(deps){
 const routes=[...v7AssetRoutes(deps.connection),filePreviewRoute(deps),browserRoute({...deps,rootWorkspaceId:deps.rootWorkspaceId,rootStatus:deps.rootStatus,integrations:deps.config?.integrations??{},apple:deps.apple,appleConfig:deps.appleConfig??deps.config?.appleCalendar??{}})];
 return {kind:'prefix',path:'/personal-workstation',async handler(req,res){
  const rejection=deps.connection.requestRejection({headers:req.headers});
  if(rejection){res.writeHead(rejection);res.end('Unauthorized');return;}
  const controller=new AbortController();const disconnected=()=>{if(!res.writableEnded)controller.abort(new Error('HTTP client disconnected'));};res.on('close',disconnected);
  try{
   const url=new URL(req.url,'http://localhost');const route=routes.find(r=>r.path===url.pathname);
   if(!route){res.writeHead(404);res.end('Not found');return;}
   if(!route.methods.includes(req.method)){res.writeHead(405);res.end('Method not allowed');return;}
   const chunks=[];let bytes=0;
   if(req.method==='POST')for await(const chunk of req){bytes+=chunk.length;if(bytes>REQUEST_MAX_BYTES){res.writeHead(413);res.end('Too large');return;}chunks.push(chunk);}
   const headers=new Headers();for(const [k,v]of Object.entries(req.headers))if(v!==undefined)headers.set(k,Array.isArray(v)?v.join(', '):v);
   const response=await route.fetch(new Request(url,{method:req.method,headers,signal:controller.signal,...(req.method==='POST'?{body:Buffer.concat(chunks)}:{})}));
   if(res.destroyed)return;
   res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
  }catch{if(!res.destroyed){if(!res.headersSent)res.writeHead(500);res.end('Workstation request failed');}}finally{res.off('close',disconnected);}
 }};
}
