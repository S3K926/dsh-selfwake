/**
 * `dsh-selfwake` · Host 半边（电脑版，照同类实现的既有规则 `dsha-selfwake` 的规矩重写）
 *
 * 它干什么：每 `tickSeconds` 检查一次，四道闸全过就"开口"——发一条风铃 + 写一行日志。
 *
 * 四道闸（照同类实现的既有规则，数值抄手机）：
 *   ① 距上次开口 ≥ `intervalMinutes`（默认 20）
 *   ② 使用者安静 ≥ `minIdleMinutes`（默认 20）—— 判据：DSH 会话日志最近的修改时间
 *   ③ 未回话次数 < `maxUnanswered`（默认 7）
 *   ④ 不在静默时段（默认 0–7 点）
 *
 * ⚠ 两件如实写明的事：
 *   1. **它现在还投不进会话**。DSH 的 `ctx.agents.create` 那条路已废弃；真正"把话送进会话"
 *      要靠 `dsh-session-switch`（我们拆掉后说好"以后做"的那半边）。所以这一版到点只做
 *      **通知 + 日志**：人能听见、账能审计，但不会凭空在你的会话里多出一条消息。
 *   2. **它叫不醒睡着的电脑**（定时器活在进程里）。跟手机一样：电脑得开着、DSH 得在跑。
 *
 * 自检口 `node index.js --selftest` 放在模块层（独立跑时 cordis 不调 apply，写在里面等于死代码）。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';

export const name = 'selfwake';

/** 只声明真正需要的服务；可选的用 ctx.get() 取，取不到就降级。 */
export const inject = ['timer', 'agents'];

export const DEFAULTS = {
  enabled: true,
  tickSeconds: 60,
  intervalMinutes: 20,
  minIdleMinutes: 20,
  maxUnanswered: 7,
  quietStartHour: 0,
  quietEndHour: 7,
  notify: true,
  notifyScript: '',
  stateDir: '',
  poolFile: '',
  sessionsRoot: '',
  device: '【PC】',
};

/** 默认的开口池（开口型：没人问我时也可能突然说这个；不是回应型）。 */
const DEFAULT_POOL = [
  '（探个头）我在这儿。',
  '（轻轻敲了下桌子）在忙吗？',
  '（伸个懒腰）该起来动一动了。',
  '（看了一眼时钟）不知不觉又过去一阵了。',
  '（端着水杯）记得喝口水。',
  '（小声）有事随时叫我。',
];

export function resolveConfig(input = {}) {
  const merged = { ...DEFAULTS, ...(input ?? {}) };
  for (const key of ['tickSeconds', 'intervalMinutes', 'minIdleMinutes', 'maxUnanswered', 'quietStartHour', 'quietEndHour']) {
    if (!Number.isFinite(merged[key])) merged[key] = DEFAULTS[key];
  }
  for (const key of ['notify', 'enabled']) {
    if (typeof merged[key] !== 'boolean') merged[key] = DEFAULTS[key];
  }
  for (const key of ['notifyScript', 'stateDir', 'poolFile', 'sessionsRoot', 'device']) {
    if (typeof merged[key] !== 'string') merged[key] = DEFAULTS[key];
  }
  return merged;
}

function homeDir() {
  return process.env.DSH_HOME || join(homedir(), '.dsh');
}

/** 状态文件：记 lastFiredAt / unanswered / 抽过的条（避免连着重复）。 */
function statePaths(cfg) {
  const dir = cfg.stateDir || join(homeDir(), 'selfwake');
  return { dir, state: join(dir, 'state.json'), log: join(dir, 'selfwake.log') };
}

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

/** 使用者在不在：看 DSH 会话日志里最新的 mtime（有动静 = 人刚说过话）。 */
function lastSessionActivityMs(root) {
  if (!existsSync(root)) return 0;
  let newest = 0;
  const walk = (dir, depth) => {
    if (depth > 3) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p, depth + 1);
      else if (entry.name.endsWith('.zstd') || entry.name.endsWith('.jsonl')) {
        try {
          const m = statSync(p).mtimeMs;
          if (m > newest) newest = m;
        } catch {
          /* 忽略读不到的 */
        }
      }
    }
  };
  walk(root, 0);
  return newest;
}

/** 抽一条：尽量避开上一次抽到的（连着重复最像机器人）。 */
function pickLine(pool, last) {
  const candidates = pool.length > 1 ? pool.filter((x) => x !== last) : pool;
  const list = candidates.length > 0 ? candidates : pool;
  return list[Math.floor(Math.random() * list.length)];
}

/** 读池子：文件在就用文件，否则用内置默认。 */
function readPool(cfg) {
  const file = cfg.poolFile;
  if (file && existsSync(file)) {
    try {
      const lines = readFileSync(file, 'utf8')
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter((s) => s !== '' && !s.startsWith('#'));
      if (lines.length > 0) return lines;
    } catch {
      /* 退回默认 */
    }
  }
  return DEFAULT_POOL;
}

/** 四道闸：全过才开口。返回 { fire, why }。 */
export function evaluateGates(now, cfg, state, lastActivityMs) {
  const quiet = now.getHours() >= cfg.quietStartHour && now.getHours() < cfg.quietEndHour;
  if (!cfg.enabled) return { fire: false, why: '开关关着' };
  if (quiet) return { fire: false, why: `静默时段（${cfg.quietStartHour}–${cfg.quietEndHour} 点）` };
  const sinceFire = state.lastFiredAt ? now.getTime() - state.lastFiredAt : Infinity;
  if (sinceFire < cfg.intervalMinutes * 60_000) {
    return { fire: false, why: `距上次开口仅 ${Math.round(sinceFire / 60_000)} 分钟（要 ≥${cfg.intervalMinutes}）` };
  }
  const idle = lastActivityMs ? now.getTime() - lastActivityMs : Infinity;
  if (idle < cfg.minIdleMinutes * 60_000) {
    return { fire: false, why: `使用者 ${Math.round(idle / 60_000)} 分钟前还在说话（要安静 ≥${cfg.minIdleMinutes} 分钟）` };
  }
  if ((state.unanswered ?? 0) >= cfg.maxUnanswered) {
    return { fire: false, why: `连着 ${state.unanswered} 次没回（上限 ${cfg.maxUnanswered}）` };
  }
  return { fire: true, why: '四道闸全过' };
}

/** 发风铃通知（走我们验通的脚本；失败只记日志，不抛）。 */
function sendNotify(cfg, title, body) {
  if (!cfg.notify) return { ok: false, why: '配置里关掉了通知' };
  const target = cfg.notifyScript;
  if (!target || !existsSync(target)) return { ok: false, why: '没配 notifyScript（找不到发通知脚本）' };
  const r = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', target, '-Title', title, '-Body', body],
    { windowsHide: true, timeout: 20_000 },
  );
  return { ok: r.status === 0, why: r.status === 0 ? '' : `退出码 ${r.status}` };
}

/**
 * 找"最近有写入"的会话 id（要投话进去，得先知道投给谁）。
 * 只看目录的 mtime，不读内容 —— 不碰会话正文。
 */
export function findLatestSessionId(sessionsRoot) {
  let newest = { id: '', mtime: 0 };
  const walk = (dir, depth) => {
    if (depth > 2) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const p = join(dir, entry.name);
      if (entry.name.startsWith('session-')) {
        let m = 0;
        try {
          for (const f of readdirSync(p)) {
            try {
              const s = statSync(join(p, f));
              if (s.mtimeMs > m) m = s.mtimeMs;
            } catch {
              /* 单个文件读不到就跳过 */
            }
          }
        } catch {
          /* 目录读不到就跳过 */
        }
        if (m > newest.mtime) newest = { id: entry.name, mtime: m };
      } else {
        walk(p, depth + 1);
      }
    }
  };
  walk(sessionsRoot, 0);
  return newest.id;
}

/**
 * 把一条消息**真的投进会话** —— 这是"自唤醒"的最后一段。
 *
 * 依据（rc.3 的核心 API，查过 dsh-agent 的类型定义）：
 *   agents.get(sessionId) → 拿活跃 agent；agent.followup(message) → 把消息推进去。
 * 消息形状照 `dsh-auto-handoff` 里**真机验过**的那种手工构造（不 import 工厂函数，少一个解析风险面）。
 *
 * ⚠ 只投"当下活着"的会话：窗口关着就没有 agent 可投 —— 那时降级成通知，`why` 说明原因。
 */
export function deliverToSession(ctx, sessionsRoot, text) {
  const agents = ctx.get('agents');
  if (agents === undefined || typeof agents.get !== 'function') {
    return { ok: false, why: '拿不到 agents 服务' };
  }
  const sessionId = findLatestSessionId(sessionsRoot);
  if (sessionId === '') return { ok: false, why: '找不到会话目录' };
  let handle;
  try {
    handle = agents.get(sessionId);
  } catch (error) {
    return { ok: false, why: 'agents.get 抛错：' + String((error && error.message) || error) };
  }
  if (handle === undefined || handle === null) {
    return { ok: false, why: `会话 ${sessionId.slice(0, 20)}… 不在活跃列表（窗口没开？）` };
  }
  const agent = handle.agent ?? handle;
  if (typeof agent.followup !== 'function') return { ok: false, why: '这个句柄没有 followup 方法' };
  const message = {
    id: `selfwake-${Date.now()}`,
    role: 'user',
    content: [{ type: 'text', text: `（自唤醒）${text}` }],
    source: { kind: 'user' },
  };
  try {
    agent.followup(message);
  } catch (error) {
    return { ok: false, why: 'followup 抛错：' + String((error && error.message) || error) };
  }
  return { ok: true, sessionId };
}

export function apply(ctx, input = {}) {
  const cfg = resolveConfig(input);
  const { dir, state, log } = statePaths(cfg);
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    /* 建不出来就只记日志 */
  }
  const sessionsRoot = cfg.sessionsRoot || join(homeDir(), 'sessions');

  const say = (line) => {
    const text = `${new Date().toISOString()} ${line}`;
    try {
      appendFileSync(log, text + '\r\n');
    } catch {
      /* 日志写不了也不能炸 */
    }
  };

  const tick = () => {
    const now = new Date();
    // 每 tick 重读"热配置"（<stateDir>/config.json）：调闸门不用重启宿主。
    // 踩过的坑：插件自带的 cordis patch 只在启动时读一次，改它热加载不生效。
    const hot = readJson(join(dir, 'config.json'), {});
    // 2026-09-28 安全修复：**脚本路径不接受热配置**。
    // stateDir 是个普通可写目录，谁能往那儿写 config.json，谁就能把 notifyScript 指到自己的
    // .ps1 —— 那等于以 DSH 进程的权限执行任意 PowerShell。所以这一项只认插件配置；
    // 「不用重启就能调的闸门」（间隔 / 安静 / 上限 / 静默时段…）照旧从热配置读。
    delete hot.notifyScript;
    const live = { ...cfg, ...hot };
    const st = readJson(state, { lastFiredAt: 0, unanswered: 0, lastLine: '' });
    const lastActivity = lastSessionActivityMs(sessionsRoot);
    // 使用者回话就清零（判据：会话有写入、且比我上次开口更新）。
    // ⚠ 手机版有这条，我第一版漏了 —— 结果计数只增不减，到上限就永久闭嘴（实测真踩到）。
    if (lastActivity > (st.lastFiredAt ?? 0) && (st.unanswered ?? 0) > 0) {
      st.unanswered = 0;
      say('[clear] 使用者回话了 → 未回话计数清零');
      // 顺手落盘：不然文件里一直留着旧计数，下一轮的我看着困惑。
      // （功能上不影响 —— 判闸门用的是内存里的 st。）
      try {
        writeFileSync(state, JSON.stringify(st, null, 2));
      } catch {
        /* 写不了就算了 */
      }
    }
    const verdict = evaluateGates(now, live, st, lastActivity);
    if (!verdict.fire) {
      say(`[tick] 不开：${verdict.why}`);
      return;
    }
    const pool = readPool(live);
    const line = pickLine(pool, st.lastLine);
    // 先试着**把话投进会话**（这才是"醒过来"）；投不进去才降级发通知
    const delivered = deliverToSession(ctx, sessionsRoot, line);
    const sent = delivered.ok ? { ok: false, why: '已进会话，不必再发通知' } : sendNotify(live, live.device || 'DSH', line);
    say(`[fire] ${verdict.why} → 抽到「${line}」；投递=${delivered.ok ? '已进会话 ' + String(delivered.sessionId).slice(0, 20) + '…' : '失败(' + delivered.why + ')'}；通知=${delivered.ok ? '跳过' : (sent.ok ? '已发' : '失败(' + sent.why + ')')}`);
    const next = { ...st, lastFiredAt: now.getTime(), lastLine: line, unanswered: (st.unanswered ?? 0) + 1 };
    try {
      writeFileSync(state, JSON.stringify(next, null, 2));
    } catch {
      /* 状态写不了：下次会重复开口，记一笔 */
      say('[warn] 状态写不进去，下轮可能重复开口');
    }
  };

  say(`[apply] 自唤醒起来了：每 ${cfg.tickSeconds}s 检查一次；间隔 ${cfg.intervalMinutes} 分 / 安静 ${cfg.minIdleMinutes} 分 / 上限 ${cfg.maxUnanswered} 次 / 静默 ${cfg.quietStartHour}-${cfg.quietEndHour} 点`);
  const stop = ctx.interval(tick, cfg.tickSeconds * 1000);
  ctx.effect(() => () => {
    if (typeof stop === 'function') stop();
    say('[stop] 自唤醒停了');
  });
}

/** 自检口（模块层，独立可跑）：只验纯逻辑，不碰真实环境。 */
export function runSelftest() {
  const cfg = resolveConfig({ intervalMinutes: 20, minIdleMinutes: 20, maxUnanswered: 3 });
  const now = new Date('2026-09-26T10:00:00'); // 10 点，不在静默段
  const results = [];
  const check = (label, got, want) => results.push({ label, ok: got === want, got, want });

  check('静默时段外 + 刚开口过 → 不开', evaluateGates(now, cfg, { lastFiredAt: now.getTime() - 60_000, unanswered: 0 }, now.getTime() - 30 * 60_000).fire, false);
  check('安静够久 + 过了间隔 → 开', evaluateGates(now, cfg, { lastFiredAt: now.getTime() - 30 * 60_000, unanswered: 0 }, now.getTime() - 30 * 60_000).fire, true);
  check('人刚说话 → 不开', evaluateGates(now, cfg, { lastFiredAt: now.getTime() - 30 * 60_000, unanswered: 0 }, now.getTime() - 60_000).fire, false);
  check('未回话到上限 → 不开', evaluateGates(now, cfg, { lastFiredAt: now.getTime() - 30 * 60_000, unanswered: 3 }, now.getTime() - 30 * 60_000).fire, false);
  check('凌晨 3 点 → 不开', evaluateGates(new Date('2026-09-26T03:00:00'), cfg, { lastFiredAt: 0, unanswered: 0 }, 0).fire, false);
  check('开关关掉 → 不开', evaluateGates(now, resolveConfig({ enabled: false }), { lastFiredAt: 0, unanswered: 0 }, 0).fire, false);

  const passed = results.filter((r) => r.ok).length;
  for (const r of results) {
    // eslint-disable-next-line no-console
    console.log(`${r.ok ? '[OK ]' : '[BAD]'} ${r.label}（得到 ${r.got}，期望 ${r.want}）`);
  }
  console.log(`\n=== 自唤醒自检：${passed}/${results.length} 通过 ===`);
  return passed === results.length;
}

const invokedDirectly = process.argv[1] !== undefined && process.argv[1].endsWith('index.js');
if (invokedDirectly && process.argv.includes('--selftest')) {
  process.exitCode = runSelftest() ? 0 : 1;
}
