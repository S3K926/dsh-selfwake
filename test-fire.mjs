// 离线实跑自唤醒：用假 ctx（真的 interval，但短触发）+ 真通知脚本，验一遍"到点会开口"。
// 用法: node test-fire.mjs [秒数]
import { apply } from './index.js';

const seconds = Number(process.argv[2] ?? 5);
const fired = [];

const ctx = {
  interval(fn, ms) {
    const t = setInterval(fn, ms);
    return () => clearInterval(t);
  },
  effect(fn) {
    return fn();
  },
};

const cfg = {
  enabled: true,
  tickSeconds: seconds,          // 短 tick，方便看
  intervalMinutes: 0,            // 不卡"间隔"
  minIdleMinutes: 0,             // 不卡"安静"
  maxUnanswered: 2,              // 第 3 次该停
  quietStartHour: 0,
  quietEndHour: 0,               // 关掉静默段（0-0 等于没有）
  notify: true,
  // 本机路径不进仓库：要用真脚本／真池子就设这两个环境变量
  notifyScript: process.env.SELFTEST_NOTIFY_SCRIPT ?? '',
  poolFile: process.env.SELFTEST_POOL_FILE ?? '',
  stateDir: process.env.TEMP + '\\selfwake-test',
};

apply(ctx, cfg);
console.log(`[test] 已启动：每 ${seconds}s 一 tick，上限 ${cfg.maxUnanswered} 次；等 ${seconds * 4}s 看结果…`);

setTimeout(() => {
  console.log('[test] 结束（进程退出后看日志文件里 fire 了几次）');
  process.exit(0);
}, seconds * 4 * 1000);
