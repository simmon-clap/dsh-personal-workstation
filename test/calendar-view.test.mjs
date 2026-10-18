import {test} from 'node:test';import assert from 'node:assert/strict';
import {monthMatrix,monthTitle,bucketByDay,weekLayout,weekTitle,startOfWeek,eventDay,eventTime,isAllDay,dayKey} from '../prototype/calendar-view.mjs';

const event=(id,title,startDate,endDate)=>({id,kind:'event',archived:false,data:{title,startDate,...(endDate?{endDate}:{})}});

test('月网格：周一起始、覆盖整月、跨月补位',()=>{
 const weeks=monthMatrix(2026,9); // 2026 年 10 月
 assert.equal(weeks.length,6);
 assert.equal(weeks[0].length,7);
 assert.equal(dayKey(weeks[0][0]),'2026-09-28','10 月 1 日是周四 → 第一行从 9 月 28 日（周一）开始');
 assert.equal(dayKey(weeks[0][3]),'2026-10-01');
 assert.equal(dayKey(weeks[5][6]),'2026-11-08','最后一行补到 11 月 8 日');
 assert.equal(monthTitle(2026,9),'2026 年 10 月');
 assert.equal(dayKey(startOfWeek(new Date(2026,9,12))),'2026-10-12','10-12 是周一');
 assert.equal(dayKey(startOfWeek(new Date(2026,9,18))),'2026-10-12','10-18 周日也归到同一周');
});

test('按天分桶：全天在前、定时按时间排序；没有日期的事件不出现',()=>{
 const items=[
  event('e1','下午会','2026-10-12T15:00+08:00','2026-10-12T16:00+08:00'),
  event('e2','全天安排','2026-10-12'),
  event('e3','早上会','2026-10-12T09:00+08:00','2026-10-12T10:00+08:00'),
  event('e4','没有日期',''),
 ];
 const map=bucketByDay(items);
 assert.deepEqual(map.get('2026-10-12').map(item=>item.id),['e2','e3','e1'],'全天在前，其余按时间');
 assert.equal(map.size,1,'没有日期的记录不进日历');
 assert.equal(eventDay(items[0]),'2026-10-12');
 assert.equal(eventTime(items[0]),'15:00');
 assert.equal(isAllDay(items[1]),true);
 assert.equal(isAllDay(items[0]),false);
});

test('周布局：定时事件换算成百分比位置，全天单独一行',()=>{
 const weekStart=new Date(2026,9,12);
 const {days}=weekLayout([
  event('e1','早上会','2026-10-13T09:00+08:00','2026-10-13T10:30+08:00'),
  event('e2','全天安排','2026-10-14'),
 ],weekStart);
 assert.equal(days.length,7);
 const tuesday=days.find(day=>day.key==='2026-10-13');
 assert.equal(tuesday.timed.length,1);
 assert.equal(Number(tuesday.timed[0].top.toFixed(2)),37.5,'09:00 = 540/1440 = 37.5%');
 assert.equal(Number(tuesday.timed[0].height.toFixed(2)),6.25,'90 分钟 = 6.25%');
 const wednesday=days.find(day=>day.key==='2026-10-14');
 assert.equal(wednesday.allDay.length,1);
 assert.equal(wednesday.timed.length,0);
 assert.equal(weekTitle(weekStart),'2026 年 10 月 12 日 – 18 日');
});
