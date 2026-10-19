// Explicit authenticated action; never derive a login destination from client input.
export function browserLoginRoute(connection){return {kind:'exact',path:'/personal-workstation/browser-login',async handler(req,res){
 const reply=(status,body)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','referrer-policy':'no-referrer','x-content-type-options':'nosniff'});res.end(JSON.stringify(body));};
 const admission=connection.admit(req);if('rejection' in admission)return reply(admission.rejection,{error:'当前页面未获登录授权'});
 if(req.method!=='POST'||req.headers['x-workstation-client']!=='1')return reply(403,{error:'需要工作台显式操作'});
 const address=req.socket?.localAddress,port=req.socket?.localPort;
 if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(address)||!Number.isInteger(port)||port<1||port>65535)return reply(503,{error:'仅支持本机浏览器入口'});
 if(typeof connection.authenticatedUrl!=='function')return reply(503,{error:'当前运行时未提供浏览器登录入口'});
 const origin='http://127.0.0.1:'+port;
 try{const login=new URL(connection.authenticatedUrl(origin+'/'));if(login.origin!==origin||login.pathname!=='/'||login.username||login.password||login.hash)return reply(503,{error:'运行时登录地址不匹配'});return reply(200,{url:login.href});}catch{return reply(503,{error:'无法生成浏览器登录入口'});}
}};}
