/** 引用字段的中文名解析：记录里存的是稳定 ID（partnerId / ownerId / dependsOn / attendees），
 *  展示时需要真实名称。**只显示真实存在的记录**；查不到就如实写"已删除或不可见"，
 *  不把 ID 当名字显示，也不猜。 */

const cache=new Map();

export function refLabels(send){
 return {
  /** @returns {Promise<Map<string,string>>} id → 名称 */
  async resolve(kind,ids){
   const wanted=[...new Set((ids??[]).filter(id=>typeof id==='string'&&id))];
   if(!wanted.length)return new Map();
   const key=kind;
   if(!cache.has(key)){
    try{
     const result=await send('list',{kind,limit:500,includeArchived:true});
     cache.set(key,new Map((result.items??[]).map(item=>[item.id,item.data?.title||item.id])));
    }catch{cache.set(key,new Map())}
   }
   const table=cache.get(key);
   return new Map(wanted.map(id=>[id,table.get(id)??'已删除或不可见']));
  },
  /** 生成一行 "标签：名称、名称"。为空时不生成。 */
  async line(kind,ids,label){
   const names=await this.resolve(kind,ids);
   const list=[...names.values()];
   return list.length?`${label}：${list.join('、')}`:'';
  },
  clear(){cache.clear()},
 };
}
