window.__ModuleLoader__.load({id:'dsh-personal-workstation',factory:(require)=>{
  const React=require('react');
  const h=React.createElement;
  // 深色跟随 Host：首屏把配色作为参数传入，之后在 theme/change 时用 postMessage 通知 iframe，避免整页重载。
  function schemeOf(ctx){try{return ctx.theme?.getTheme?.().active?.colorScheme??'light'}catch{return 'light'}}
  function frame(src,title){return h('iframe',{src,title,style:{width:'100%',height:'100%',minHeight:0,flex:1,border:0,display:'block'},allow:'fullscreen'});}
  const PAGE_TITLE='个人工作台';
  function Icon({size=20}={}){return h('svg',{width:size,height:size,viewBox:'0 0 24 24',fill:'none',stroke:'currentColor',strokeWidth:1.6,'aria-hidden':true},h('rect',{x:3,y:3,width:18,height:18,rx:4}),h('path',{d:'M3 9h18M9 9v12'}));}
  // 工作台 iframe → 宿主对话（W1 P0-4）。只用宿主公开的 uiWorkspace.startSession()，
  // 不碰宿主 DOM、不做第二套模型入口；宿主没有该服务时不装桥，由 iframe 自己兜底跳 /。
  function chatBridge(scope){
    return ()=>{
      const handler=event=>{
        if(event.origin!==location.origin)return;
        if(event.data?.type==='workstation:generate'){
          const frame=[...document.querySelectorAll('iframe[title="'+PAGE_TITLE+'"]')].find(node=>node.contentWindow===event.source);
          if(!frame)return;
          const prompt=typeof event.data.prompt==='string'?event.data.prompt.slice(0,4000):'';
          const workspaceId=typeof event.data.workspaceId==='string'?event.data.workspaceId:'';
          const requestId=String(event.data.requestId||'');
          const reply=(ok,extra={})=>{try{event.source?.postMessage({type:'workstation:generate-ack',requestId,ok,...extra},location.origin)}catch{}};
          (async()=>{
            if(!prompt.trim()||!workspaceId){reply(false,{error:'后台生成缺少提示词或工作区'});return;}
            let ref=null;
            try{
              const sessionId=await scope.uiWorkspace.connectWorkspace(workspaceId);
              ref=scope.sessions.retain(sessionId,{source:'controllerOperation'});
              await ref.ready;
              const result=await ref.binding.session.prompt([{type:'text',text:prompt}],'queue');
              if(result&&result.ok===false)throw Error(result.error?.message||'后台任务没有被接受');
              reply(true,{sessionId});
            }catch(error){reply(false,{error:String(error?.message||error)})}
            finally{try{ref?.release()}catch{}}
          })();
          return;
        }
        if(event.data?.type!=='workstation:open-chat')return;
        const frame=[...document.querySelectorAll('iframe[title="'+PAGE_TITLE+'"]')].find(node=>node.contentWindow===event.source);
        if(!frame)return;   // 只认自己那个 iframe
        const prompt=typeof event.data.prompt==='string'?event.data.prompt.slice(0,4000):'';
        try{scope.uiWorkspace.startSession(undefined,prompt?{prompt,clearPreviousDraft:false}:undefined);}catch{location.assign('/');}
        event.source?.postMessage({type:'workstation:open-chat-ack'},location.origin);
      };
      window.addEventListener('message',handler);
      return ()=>window.removeEventListener('message',handler);
    };
  }
  function relay(ctx,title){
    return ()=>{
      const stop=ctx.on?.('theme/change',()=>{
        const scheme=schemeOf(ctx);
        for(const node of document.querySelectorAll('iframe[title="'+title+'"]'))node.contentWindow?.postMessage({type:'workstation:theme',scheme},location.origin);
      });
      return typeof stop==='function'?stop:()=>{};
    };
  }
  return {name:'dsh-personal-workstation',inject:['slots','theme'],apply(ctx){
    ctx.effect(relay(ctx,PAGE_TITLE));
    // 可选依赖：宿主没有 uiWorkspace 时不装桥，面板照常存在（避免"宿主没服务 → 整个插件不挂"）。
    ctx.inject(['uiWorkspace','sessions'],scope=>{scope.effect(chatBridge(scope))});
    // 只保留一个入口：旧界面对用户是重复导航，已移除（回退改用版本回滚）。
    ctx.slots.inject('main',()=>ctx.slots.register({name:'main',key:'personal-workstation'},()=>frame('/personal-workstation?theme='+schemeOf(ctx),PAGE_TITLE)));
    ctx.slots.inject('sidebar.panellist',()=>ctx.slots.register({name:'sidebar.panellist',id:'personal-workstation',label:PAGE_TITLE,order:10},Icon));
  }};
}});
