/**
 * 验「一次想完再说」这条路（2026-10-03 加）：
 *   ① 模型一次写完整个回合 → 切出多段 → **不补投**（省掉每段一次完整上下文调用）
 *   ② 回读拿不到 → **降级**，跟没开这个功能时一样继续分条补投（不能开不了口）
 *
 * 跑法：node test/once-mode.test.mjs
 * 全程假会话，不碰真环境。
 */
import assert from 'node:assert/strict';
import { tryDeliverOnce, SEGMENT_MARK } from '../index.js';

const asst = (text, time) => ({ type: 'assistant/message', time, data: { message: { role: 'assistant', content: [{ type: 'text', text }] } } });
const fakeAgent = (events) => ({
  session: {
    snapshotEvents: typeof events === 'function' ? events : () => events,
    deriveEventMessage: (ev) => ({ role: 'assistant', content: ev.data?.message?.content ?? ev.data?.content }),
  },
});

// ① 模型把整回合写完了（含 ⟪分段⟫）→ 成功，不补投
{
  const t = Date.now();
  let step = 0;
  const agent = fakeAgent(() => {
    step += 1;
    return step === 1 ? [asst('你怎么还不理我。', t + 500)] : [asst(`你怎么还不理我。${SEGMENT_MARK}我有点想你了。`, t + 1000)];
  });
  const logs = [];
  const out = await tryDeliverOnce({
    sessionId: 's',
    injectAt: t,
    live: { deliverMode: 'once' },
    agentOf: () => agent,
    say: (l) => logs.push(l),
    sleep: async () => {},
  });
  assert.equal(out.ok, true, '拿到整回合就该成功');
  assert.equal(out.segs.length, 2, '切成 2 段');
  assert.ok(logs.some((l) => l.includes('不补投')), '日志里要写明不补投');
  console.log('[OK ] 一次生成 → 切 2 段、不补投');
}

// ② 一直读不到（模型没写 / 消息还在排队区）→ 降级，不能开不了口
{
  const logs = [];
  const out = await tryDeliverOnce({
    sessionId: 's',
    injectAt: Date.now(),
    live: { deliverMode: 'once' },
    agentOf: () => fakeAgent([]),
    say: (l) => logs.push(l),
    sleep: async () => {},
  });
  assert.equal(out.ok, false, '读不到就该降级');
  assert.ok(logs.some((l) => l.includes('降级')), '日志里要写明降级');
  console.log('[OK ] 读不到 → 降级（照旧分条补投）');
}

// ③ 只读到一段（没分段标记）→ 也算没拿到整回合 → 降级
{
  const t = Date.now();
  const out = await tryDeliverOnce({
    sessionId: 's',
    injectAt: t,
    live: { deliverMode: 'once' },
    agentOf: () => fakeAgent([asst('就一句。', t + 500)]),
    say: () => {},
    sleep: async () => {},
  });
  assert.equal(out.ok, false, '只有一段时不该算成功（否则省不了）');
  console.log('[OK ] 只一句 → 也降级');
}

console.log('\n=== 一次想完自检：3/3 通过 ===');
