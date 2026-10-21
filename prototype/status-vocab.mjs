/** 状态词表（唯一事实源；spec/56 §4 状态 / 02 VI §7 / spec/54 §3.1 状态统一）。
 *
 *  为什么要有这张表：同一个状态原来在四处各写一套——画布说「运行中」、任务页说「运行中」、
 *  编辑器说「进行中」、执行记录也说「运行中」。用户每换一个地方都要重新认一遍词。
 *  现在统一口径（VI §7）：
 *   · **业务状态**统一用「进行中」；
 *   · 「运行中」只留给**执行记录**（执行器真的在跑），与业务完成状态分开；
 *   · 收件箱/判断/交付项的状态词也只从这里取，不再各写一份。
 *  改词只能改这一处；任一处再写死映射就是"同一事实两个说法"（17 C4）。 */

/** 业务任务状态：待办 / 等待中 / 进行中 / 已完成 / 已取消。 */
export const taskStatusLabels = Object.freeze({todo:'待办',waiting:'等待中',in_progress:'进行中',done:'已完成',cancelled:'已取消'});
/** 项目阶段（与 PRD PJ-03 一致，顺序即推进顺序）。 */
export const projectStages = Object.freeze(['接触','需求','方案','验证','复盘']);
/** 交付项 / 步骤的状态。 */
export const itemStatusLabels = Object.freeze({todo:'待办',doing:'进行中',done:'已完成',blocked:'受阻'});
/** 执行记录状态：「运行中」只在这里出现（执行器视角，不是业务完成状态）。 */
export const executionStatusLabels = Object.freeze({reserved:'已预留',queued:'排队中',running:'运行中',cancelling:'取消中',completed:'执行结束',failed:'失败',cancelled:'已取消',interrupted:'已中断',incomplete:'输出未完成',refused:'已拒绝'});
/** 收件箱里一次改动的状态（不是"审批"，只是它现在处在哪一步）。 */
export const batchStates = Object.freeze({draft:'待确认',committed:'已生效',cancelled:'已取消'});
/** 判断状态（宪章第三条）。 */
export const judgmentStates = Object.freeze({current:'当前有效',checking:'待核对',overturned:'已被推翻'});
/** AI 来源的固定文字（颜色不得单独承担判断：VI §8 V1）。 */
export const AI_LABEL='AI 判断';

/** 取词；没有映射就如实说「未设置」，不把内部枚举端给用户。 */
export const labelOf=(labels,value,fallback='未设置')=>labels[value]??fallback;
