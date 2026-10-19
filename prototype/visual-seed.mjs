// 仅供视觉/控件验收使用：与原型相同形状的演示数据，写入内存库，绝不进入发布包或生产数据库。
export const visualSeedChanges=()=>{
 const deliverables=(done,total,prefix)=>Array.from({length:total},(_,index)=>({id:prefix+index,title:prefix+'交付项 '+(index+1),done:index<done}));
 const steps=(done,total,prefix)=>Array.from({length:total},(_,index)=>({id:prefix+index,title:prefix+'步骤 '+(index+1),done:index<done}));
 return [
  {op:'create',id:'o-a',kind:'organization',data:{title:'伙伴 A',description:'芯片生态'}},
  {op:'create',id:'o-b',kind:'organization',data:{title:'伙伴 B',description:'部署与成本'}},
  {op:'create',id:'o-c',kind:'organization',data:{title:'伙伴 C',description:'推理框架'}},
  {op:'create',id:'o-d',kind:'organization',data:{title:'伙伴 D',description:'应用需求'}},
  {op:'create',id:'p-a',kind:'project',data:{title:'联合验证',goal:'验证联合方案可行性',stage:'验证',partnerId:'o-a',startDate:'2026-10-05',dueDate:'2026-11-15',deliverables:deliverables(6,8,'a')}},
  {op:'create',id:'p-b',kind:'project',data:{title:'云服务合作',goal:'确认部署与成本边界',stage:'方案',partnerId:'o-b',startDate:'2026-10-12',dueDate:'2026-11-20',deliverables:deliverables(3,8,'b')}},
  {op:'create',id:'p-c',kind:'project',data:{title:'技术适配',goal:'完成推理框架适配',stage:'验证',partnerId:'o-c',startDate:'2026-10-05',dueDate:'2026-11-02',deliverables:deliverables(5,10,'c')}},
  {op:'create',id:'p-d',kind:'project',data:{title:'场景探索',goal:'梳理应用需求',stage:'需求',partnerId:'o-d',startDate:'2026-10-19',dueDate:'2026-11-15',deliverables:deliverables(1,5,'d')}},
  {op:'create',id:'t-1',kind:'task',data:{title:'伙伴背景研究',projectId:'p-a',status:'in_progress',executionTarget:'local',steps:steps(3,5,'t1')}},
  {op:'create',id:'t-2',kind:'task',data:{title:'试点方案整理',projectId:'p-b',status:'waiting',steps:steps(1,4,'t2')}},
  {op:'create',id:'t-3',kind:'task',data:{title:'适配资料检索',projectId:'p-c',status:'in_progress',steps:steps(2,6,'t3')}},
  {op:'create',id:'t-4',kind:'task',data:{title:'会前资料归集',projectId:'p-a',status:'done',steps:steps(4,4,'t4')}},
  {op:'create',id:'e-1',kind:'event',data:{title:'联合验证方案交流',startDate:'2026-10-12T10:30:00+08:00',endDate:'2026-10-12T11:30:00+08:00',location:'线上会议',eventType:'meeting'}},
  {op:'create',id:'k-1',kind:'topic',data:{title:'推理框架：需要验证哪些收益？',description:'关联 2 个项目',content:'需要验证收益与成本口径。'}},
  {op:'create',id:'k-2',kind:'topic',data:{title:'异构算力适配的合作切入点',description:'关联技术伙伴',content:'比较合作切入点。'}},
  {op:'create',id:'a-1',kind:'artifact',data:{title:'推理评测方法',projectId:'p-c',description:'固定硬件与模型版本，记录延迟与成本。',path:'benchmark.md'}},
  {op:'create',id:'a-2',kind:'artifact',data:{title:'伙伴背景资料',projectId:'p-a',description:'生态与合作背景摘要。',path:'partner-a.md'}},
  {op:'create',id:'a-3',kind:'artifact',data:{title:'部署架构笔记',projectId:'p-b',description:'部署边界与同步范围待确认。',path:'deploy.md'}},
  {op:'create',id:'m-1',kind:'memoryRef',data:{title:'过往试点经验',provider:'Mnemon',reference:'trial-lessons',content:'先统一基准测试条件，再比较性能。'}},
  {op:'create',id:'r-1',kind:'relation',data:{title:'建议复用评测方法',from:'a-1',to:'p-b',status:'suggested',evidence:'项目 B 需要验证延迟与成本，资料覆盖延迟指标。'}},
 ];
};
export function seedVisualStore(store,workspace='w'){
 const ctx={workspace,actor:'visual-check',canWrite:true};
 const batch=store.draft(ctx,{title:'visual-seed',changes:visualSeedChanges()});
 return store.commit(ctx,{batchId:batch.id,revision:1,key:'visual-seed'});
}
