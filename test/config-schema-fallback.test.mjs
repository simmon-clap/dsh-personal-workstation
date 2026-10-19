import {test} from 'node:test';
import assert from 'node:assert/strict';

// P0-4：脱离宿主 @deepseek-ai/schemastery 时，Config 必须能构建（旧的降级实现没有 number()，
// 一调用 schema.number() 就崩，第三方环境整插件启用失败）。
test('config schema builds without the host schemastery package', async () => {
  globalThis.__DSH_FORCE_CONFIG_FALLBACK__ = true;
  try {
    const module = await import('../src/config-schema.mjs?fallback=1');
    assert.equal(typeof module.Config, 'object', '降级实现也要产出可用的 Config 结构');
    assert(module.Config.shape, 'Config 应有 shape');
    assert(module.Config.shape.heartbeat, '心跳配置必须在 schema 里（含 number 字段）');
    assert(module.Config.shape.appleCalendar.shape.futureDays, '日历 futureDays（number）不能被跳过');
    assert(module.Config.shape.heartbeat.shape.intervalMinutes, '心跳 intervalMinutes（number）不能被跳过');
  } finally {
    delete globalThis.__DSH_FORCE_CONFIG_FALLBACK__;
  }
});
