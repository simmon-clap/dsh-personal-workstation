/** 数据作用域：**全部跟着根目录走**（用户 2026-10-12 的定义）。
 *
 *  用户原话：「整个项目有个根目录，这个根目录应该是我定义的，比如就是 DSH。
 *  工作区不应该做选择；工作区只是相应的产出和交付跟着项目走。」
 *
 *  规则（v3）：
 *   · 全部业务对象（项目/任务/事务/议题/资料/记忆引用/简报/组织/联系人/关系/画布布局）
 *     → 根作用域：整库一份，换会话、换目录打开都看到同一套数据；
 *   · 批次与回执 → 根作用域：收件箱是全局的；
 *   · **文件**才是跟项目走的：资料记录通过 `path`/`folder` 指向根目录下项目文件夹里的文件，
 *     实际读写仍由**授权目录**（fileGrants）与项目文件夹共同决定。
 *
 *  `WORKSPACE_SCOPED_KINDS` 保留为空集：将来若真出现"必须按工作区隔离"的类型，在这里登记即可，
 *  但工作台的用户可见行为已经不再随工作区变化。 */

/** 根作用域的固定标识：与工作区无关，所以数据跟着安装/根目录走。 */
export const ROOT_SCOPE='root';
/** 只有这些类型按工作区隔离（其余全部全局）。 */
export const WORKSPACE_SCOPED_KINDS=new Set();
/** 频道作用域前缀：IM 会话来源按频道区分（feishu/slack…），目前用于标注而不是切分数据。 */
export const CHANNEL_SCOPE_PREFIX='channel:';

export function isWorkspaceScopedKind(kind){return WORKSPACE_SCOPED_KINDS.has(kind)}

/** 一条记录应当写进哪个作用域。 */
export function scopeForKind(ctx,kind){
 if(!ctx||!ctx.workspace)throw new Error('缺少可信上下文');
 return isWorkspaceScopedKind(kind)?ctx.workspace:ROOT_SCOPE;
}

/** 读取时要并集的作用域（根在前：全局数据优先被找到）。 */
export function readScopes(ctx){return ctx?.workspace?[ROOT_SCOPE,ctx.workspace]:[ROOT_SCOPE]}

/** 频道作用域名（用于把 IM 来源标注清楚；数据本身仍写在根作用域）。 */
export function channelScope(channelId){return CHANNEL_SCOPE_PREFIX+String(channelId??'unknown')}
