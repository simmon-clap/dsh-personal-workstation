/** 同批新建项目的自动关联（体检 A2）。
 *
 *  用户的真实痛点：「会议纪要归档 · 示例科技」这一批里新建了项目，也新建了材料，但材料的
 *  `projectId` 是空的——只能再单独补一批「把会议资料挂到示例科技项目上」。根因是同一批内
 *  「新建项目 + 新建材料」没有自动关联。
 *
 *  这里只做一件事：本批**恰好新建 1 个项目**时，把本批新建、且自己没带 `projectId` 的材料
 *  指向它。三条边界都是有意的，不是遗漏：
 *  · 0 个新建项目 → 不动（没有可指向的对象）；
 *  · ≥2 个新建项目 → 不动（指向哪个是用户的决定，服务端不猜；预览会如实显示「未归属」，
 *    用户可在同一批草稿里一键指定）；
 *  · 材料自己带了 `projectId`（Agent 或界面明确写的）→ 绝不覆盖。
 *  范围只覆盖**资料记录（artifact）**：体检报告说的「材料」就是知识页「文件与资料」里的资料记录
 *  （会议纪要、录音原件）。研究议题、任务、日程等的归属由 Agent/界面显式写 `projectId`，
 *  不在这里替用户决定；要扩大范围只需改下面的 materialKinds。
 *
 *  自动补的归属不是暗箱：`sources.projectId` 如实写「同批新建项目自动关联」，预览的
 *  「归属核对」块会显示它，并可在同一批草稿内改回未归属或换项目（走既有 draft 修订，不绕过批次）。
 *  ⚠️ 调用方必须**只在批次第一次生成草稿时**调用它（见 store.writeDraft 的 `old` 判断）：
 *  否则用户改回「未归属」后，下一次修订会被再次自动挂回，撤销就成了假的。
 */
const materialKinds=new Set(['artifact']);
export const AUTO_LINK_SOURCE='同批新建项目自动关联';
/** @returns {{changes:Array,linked:string[]}} linked 是本批被自动补上归属的对象 id（无 id 时为 null）。 */
export function linkBatchChanges(changes){
 if(!Array.isArray(changes)||!changes.length)return {changes,linked:[]};
 const created=changes.filter(change=>change?.op==='create'&&change.kind==='project'&&change.id);
 if(created.length!==1)return {changes,linked:[]};
 const projectId=created[0].id;
 const linked=[];
 const next=changes.map(change=>{
  if(!change||change.op!=='create'||!materialKinds.has(change.kind))return change;
  const data=change.data;
  if(!data||typeof data!=='object'||Array.isArray(data))return change;
  // 已经有归属就不动它——包括 Agent 显式给的、以及指向本批之外既有项目的。
  if(typeof data.projectId==='string'&&data.projectId.trim())return change;
  linked.push(change.id??null);
  const sources={...(change.sources??{})};
  if(!sources.projectId)sources.projectId=AUTO_LINK_SOURCE;
  return {...change,data:{...data,projectId},sources};
 });
 return {changes:next,linked};
}
