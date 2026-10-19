import {createHash} from 'node:crypto';
import {DomainError} from './store.mjs';
import {validateData} from './validation.mjs';
function layoutId(view){if(typeof view!=='string'||!view.trim()||view.length>4096)throw new DomainError('INVALID','视图标识无效');return 'layout:'+createHash('sha256').update(view).digest('hex');}
export function readLayout(store,ctx,view){const e=store.get(ctx,layoutId(view));if(e&&(e.kind!=='layout'||e.archived))throw new DomainError('CONFLICT','布局标识不可用');return e;}
export function saveLayout(store,ctx,{view,revision,positions,viewport,groups,key}){
 store.context(ctx,true);validateData('layout',{positions,viewport,...(groups===undefined?{}:{groups})});if(typeof key!=='string'||!key.trim())throw new DomainError('INVALID','保存需要同一次请求');const id=layoutId(view),old=readLayout(store,ctx,view);
 if(!Number.isInteger(revision)||revision<0)throw new DomainError('INVALID','布局版本无效');
 const previous=store.receipt(ctx,key);if(previous){const match=previous.after?.find(e=>e.id===id);if(!match||JSON.stringify(match.data)!==JSON.stringify({positions,viewport,...(groups===undefined?{}:{groups})}))throw new DomainError('CONFLICT','保存键已用于其他内容');return previous;}
 if((old?.revision??0)!==revision)throw new DomainError('CONFLICT','布局已被其他窗口修改');
 // 分组引用也必须是真实存在的对象：视图数据不能把不存在的 ID 存进来。
 for(const group of groups??[])for(const nodeId of group.nodeIds){const node=store.get(ctx,nodeId);if(!node||node.archived)throw new DomainError('INVALID','分组引用了不存在或已归档的对象：'+nodeId);}
 for(const nodeId of Object.keys(positions??{})){const node=store.get(ctx,nodeId);if(!node||node.archived||['layout','relation'].includes(node.kind))throw new DomainError('REFERENCE','布局节点不可用');}
 const data={positions,viewport,...(groups===undefined?{}:{groups})};const changes=[old?{op:'update',id,expectedRevision:revision,data}:{op:'create',id,kind:'layout',data}];
 const b=store.draft(ctx,{title:'保存画布布局',changes,source:{view}});return store.commit(ctx,{batchId:b.id,revision:b.revision,key});
}
