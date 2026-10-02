/**
 * `dsh-selfwake` · Host 半边（电脑版，照同类实现的既有规则 `dsha-selfwake` 的规矩重写）
 *
 * 它干什么：每 `tickSeconds` 检查一次，四道闸全过就"开口"——发一条风铃 + 写一行日志。
 *
 * 四道闸（照同类实现的既有规则，数值抄手机）：
 *   ① 距上次开口 ≥ `intervalMinutes`（默认 20）**± `jitterMinutes`（默认 8）**
 *      —— 2026-09-30 新增：间隔不再是死数，每次开口后摇一个区间（20 → 12~28 分），
 *         摇出来的值**可复现**（同一个 sessionId + 同一轮 hash 出同一个数，排查时对得上）。
 *         学的是 `2huy4n/ProjectKaren` 的 `rollTalkDelay`（只学设计，它 AGPL、我们 MIT）。
 *   ② 使用者安静 ≥ `minIdleMinutes`（默认 20）—— 判据：DSH 会话日志最近的修改时间
 *   ③ 未回话次数 < `maxUnanswered`（默认 7）
 *   ④ 不在静默时段（默认 0–7 点）
 *   ⑤ 今天开口没到 `dailyMax`（默认 12，0 = 不限）—— 同 ProjectKaren 的 `talkDailyMax`
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
  /** 间隔抖动：每次开口后的等待时间 = intervalMinutes ± jitterMinutes（可复现）。0 = 不抖，退回老行为。 */
  jitterMinutes: 8,
  /** 每天最多开口几次（0 = 不限）。跨天自动归零。 */
  dailyMax: 12,
  /**
   * 2026-09-30 新增（学 proactive-nudge / ProjectKaren）：**到点后注入"状态 ＋ 约束"，
   * 由模型当场生成那句话**，而不是把池子里的方向原样发出去。
   * false = 退回老行为（从池子抽一条直接发），用来回归对照。
   */
  generateText: true,
  /**
   * 2026-09-30 新增：**沉默越久，越不急着开口**（加权间隔）。
   * 加权间隔 = intervalMinutes * (1 + unanswered * this)。
   * 0 = 退回固定间隔。理由：连着几条没被接就该往后缩，而不是更频繁地追。
   */
  backoffPerUnanswered: 0.5,
  /** 上一次开口之后多久之内有动静，算"他接了我的话"。 */
  replyWindowMinutes: 10,
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
  for (const key of ['tickSeconds', 'intervalMinutes', 'jitterMinutes', 'dailyMax', 'backoffPerUnanswered', 'replyWindowMinutes', 'minIdleMinutes', 'maxUnanswered', 'quietStartHour', 'quietEndHour']) {
    if (!Number.isFinite(merged[key])) merged[key] = DEFAULTS[key];
  }
  for (const key of ['notify', 'enabled', 'generateText']) {
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

/**
 * 真实用户活动时间（毫秒）—— **判"使用者安静多久"用这个**。
 *
 * 🔴 2026-09-30 抓到的真 bug（用户点破"思考会说是用户发来消息"）：
 *   原来的判据是**会话文件的 mtime**。可这个 agent 每干一点活（跑工具、出回复）
 *   就会往同一个文件里写 → mtime 永远是"刚刚" → 插件永远以为"使用者还在说话"
 *   → **它把自己给堵死了**（实测日志连着几条「使用者 0 分钟前还在说话」）。
 *
 * 正确判据：往后翻会话事件，找**最后一条真正的 `user/message`**，用它的事件时间。
 * ⚠ 但**我们自己注入的那条也是 `user/message`**（`agent.followup` 的 source 是 user）——
 *   若把它算作"用户在说话"，那每次开口之后都会再把自己锁住 20 分钟。
 *   所以这里要用**注入文本的特征**把它排除（下面是 SAFE 判据：认不出就当用户消息，
 *   宁可保守 —— 万一漏判，最坏结果是多等一轮，不会误发）。
 */
/**
 * 注入消息的标记：**零宽空格**（U+200B）。
 *
 * 🔴 2026-10-01 为什么换成零宽字符（用户原话：「刚刚有现在没了」）：
 *   隐藏注入这件事是"先渲染、下一瞬间才收起"，用户会**瞥见一眼**。
 *   原来那一眼前缀是「（自己开口）」+ 一堆括号说明 → 一眼就出戏。
 *   现在注入正文**就是一段纯内心独白**，只在最前面挂一个肉眼看不见的零宽字符给插件认。
 *   （旧前缀仍保留在下面做兼容：历史消息、以及万一还有别处写着。）
 */
export const SELFWAKE_MARK = '\u200B';
const SELFWAKE_MARKERS = ['（自己开口）', '（自唤醒', '我自己想开口', '傲娇递进', '角度参考'];

/** 这条 user/message 是不是"我们自己注入的"？ */
export function isSelfwakeInjection(ev) {
  try {
    const data = ev?.data ?? {};
    const text = typeof data === 'string' ? data : String(messageTextOf(data) || '');
    if (text.indexOf(SELFWAKE_MARK) === 0) return true;
    return SELFWAKE_MARKERS.some((m) => text.includes(m));
  } catch {
    return false;
  }
}

async function realUserActivityMs(agent) {
  try {
    if (!agent || !agent.session || typeof agent.session.snapshotEvents !== 'function') return 0;
    const events = agent.session.snapshotEvents() ?? [];
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const ev = events[i];
      if (String(ev?.type ?? '') !== 'user/message') continue;
      if (isSelfwakeInjection(ev)) continue; // 自己注入的不算"用户在说话"
      const t = Number(ev?.time);
      if (Number.isFinite(t) && t > 0) return t;
    }
  } catch {
    /* 读不到就返回 0 */
  }
  return 0;
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

/**
 * 稳定哈希 → [0,1)。学自 ProjectKaren 的 `hashUnit`：**可复现的随机**。
 * 同一个 (sessionId, 第几轮) 永远摇出同一个数 —— 所以"这次为什么 14 分钟就开口"事后能对上账，
 * 而每次之间又各不相同（不像固定间隔那样一眼看出来是定时器）。
 */
export function hashUnit(key) {
  if (typeof key === 'bigint') {
    // BigInt 版本（ProjectKaren 用的 FNV-1a 64 位），环境支持就用这个
    const mask = (1n << 64n) - 1n;
    let h = 0xcbf29ce484222325n;
    for (const b of Buffer.from(String(key), 'utf8')) {
      h = (h ^ BigInt(b)) & mask;
      h = (h * 0x100000001b3n) & mask;
    }
    return Number(h >> 11n) / 9007199254740992;
  }
  // 兜底：32 位 FNV-1a ＋ 混淆（只 FNV 不混淆的话，末尾数字只差一位结果会挤在一起 —— 实测过）
  let h = 0x811c9dc5;
  const s = String(key);
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x21f0aaad) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x735a2d97) >>> 0;
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/** 摇下一次"最早可以开口"的间隔（毫秒）：interval ± jitter，按 key 可复现。 */
export function rollIntervalMs(baseMinutes, jitterMinutes, key) {
  const unit = hashUnit(String(key));
  const jitter = Number.isFinite(jitterMinutes) ? Math.max(0, Math.round(jitterMinutes)) : 0;
  const minutes = baseMinutes + (jitter ? Math.round((unit * 2 - 1) * jitter) : 0);
  return Math.max(1, minutes) * 60_000;
}

/** 今天（本地日期）的 key，用来做每日计数。 */
export function dayKey(date) {
  const d = date instanceof Date ? date : new Date(date);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * 加权间隔（2026-09-30）：沉默越久，越不急着开口。
 * 基础间隔 × (1 + 连着没回的次数 × backoffPerUnanswered)，封顶 6 倍。
 * 理由：连着几条没被接，说明现在不是说话的时候 —— 该往后缩，而不是追得更勤。
 */
export function weightedIntervalMs(live, unanswered) {
  const base = Number.isFinite(live.intervalMinutes) ? Math.max(1, live.intervalMinutes) : 20;
  const per = Number.isFinite(live.backoffPerUnanswered) ? Math.max(0, live.backoffPerUnanswered) : 0;
  const miss = Number.isFinite(unanswered) ? Math.max(0, unanswered) : 0;
  const factor = Math.min(6, 1 + miss * per);
  return base * factor * 60_000;
}

/** 摇下一次可开口的时刻（加权间隔 ＋ 可复现抖动）。纯函数，方便自检与排查。 */
export function nextAllowedAtFor(nowMs, live, sessionKey, firedCount, unanswered = 0) {
  const key = `${sessionKey}|wake|${firedCount}`;
  const baseMs = weightedIntervalMs(live, unanswered);
  const jitter = Number.isFinite(live.jitterMinutes) ? Math.max(0, live.jitterMinutes) : 0;
  const unit = hashUnit(key);
  const ms = jitter ? baseMs + (unit * 2 - 1) * jitter * 60_000 : baseMs;
  return nowMs + Math.max(60_000, Math.round(ms));
}

/** 闸门：全过才开口。返回 { fire, why }。 */
export function evaluateGates(now, cfg, state, lastActivityMs) {
  const quiet = now.getHours() >= cfg.quietStartHour && now.getHours() < cfg.quietEndHour;
  if (!cfg.enabled) return { fire: false, why: '开关关着' };
  if (quiet) return { fire: false, why: `静默时段（${cfg.quietStartHour}–${cfg.quietEndHour} 点）` };
  // ① 间隔：优先用"上次开口时摇出来的那个点"（随机、可复现）；没有就退回固定间隔（老行为）
  const nextAllowedAt = Number.isFinite(state.nextAllowedAt) ? state.nextAllowedAt : 0;
  if (nextAllowedAt > 0) {
    if (now.getTime() < nextAllowedAt) {
      return { fire: false, why: `距下次可开口还差 ${Math.max(1, Math.round((nextAllowedAt - now.getTime()) / 60_000))} 分钟（这次摇到的是随机间隔）` };
    }
  } else {
    const sinceFire = state.lastFiredAt ? now.getTime() - state.lastFiredAt : Infinity;
    const needMs = weightedIntervalMs(cfg, state.unanswered ?? 0);
    if (sinceFire < needMs) {
      return { fire: false, why: `距上次开口仅 ${Math.round(sinceFire / 60_000)} 分钟（这次要 ≥${Math.round(needMs / 60_000)}）` };
    }
  }
  const idle = lastActivityMs ? now.getTime() - lastActivityMs : Infinity;
  if (idle < cfg.minIdleMinutes * 60_000) {
    return { fire: false, why: `使用者 ${Math.round(idle / 60_000)} 分钟前还在说话（要安静 ≥${cfg.minIdleMinutes} 分钟）` };
  }
  if ((state.unanswered ?? 0) >= cfg.maxUnanswered) {
    return { fire: false, why: `连着 ${state.unanswered} 次没回（上限 ${cfg.maxUnanswered}）` };
  }
  // ⑤ 每日上限（学 ProjectKaren 的 talkDailyMax）：到量就闭嘴，跨天自动归零
  const max = Number.isFinite(cfg.dailyMax) ? cfg.dailyMax : 0;
  if (max > 0 && state.dailyDay === dayKey(now) && (state.dailyCount ?? 0) >= max) {
    return { fire: false, why: `今天已经开口 ${state.dailyCount} 次（上限 ${max}）` };
  }
  return { fire: true, why: '闸门全过' };
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
 * 把注入标记拼进文本。
 * 2026-10-01 起默认用**零宽空格**（肉眼看不见）——注入正文因此就是一段纯内心独白，
 * 用户偶尔瞥见也不会看到"（自己开口）"这种前缀。
 */
export function withPrefix(text, prefix) {
  const p = typeof prefix === 'string' && prefix !== '' ? prefix : SELFWAKE_MARK;
  return `${p}${text}`;
}

/**
 * 回合内分段用的标记（2026-09-30 加：用户要"多段话分开发"）。
 * 模型一次生成整个回合，用这个符号隔开各段；宿主再一段一段投出去，中间留随机延迟。
 */
export const SEGMENT_MARK = '⟪分段⟫';

/** 一个回合最多几段（用户拍板：封顶 4 段）。 */
export const MAX_SEGMENTS = 4;

/** 段与段之间的随机延迟范围（毫秒；用户拍板：3~15 秒）。 */
export const SEGMENT_DELAY_MIN_MS = 3_000;
export const SEGMENT_DELAY_MAX_MS = 15_000;

/** 投出第 1 段之后，等多久去读回模型写的那整段（够它把回合写完就行）。 */
export const SEGMENT_WAIT_MS = 45_000;

/** 一个回合结束后，下一次检查的间隔乘这个数（用户拍板：×2 —— 一个回合顶好几句）。 */
export const ROUND_COOLDOWN_FACTOR = 2;

/** 把模型那一整段文本切成 1~4 段（纯函数，方便自检）。 */
export function splitSegments(text, max = MAX_SEGMENTS) {
  const raw = typeof text === 'string' ? text : '';
  if (raw.trim() === '') return [];
  const parts = raw
    .split(SEGMENT_MARK)
    .map((s) => s.replace(/^\s+|\s+$/g, ''))
    .filter((s) => s !== '');
  const limited = parts.slice(0, Math.max(1, max));
  return limited.length > 0 ? limited : [raw.trim()];
}

/** 段间延迟：在 [min, max] 里随机。抽到 0 段的退化情况也不要卡住。 */
export function segmentDelayMs(random = Math.random) {
  const span = SEGMENT_DELAY_MAX_MS - SEGMENT_DELAY_MIN_MS;
  return SEGMENT_DELAY_MIN_MS + Math.floor(random() * span);
}

/**
 * 把"我刚刚生成的那段文本"读回来（用来切段 → 分开发）。
 *
 * 2026-09-30 实测记录（下一棒别再重查）：
 * - 插件目录 **`import` 不到** `@deepseek-ai/dsh-session`：包名解析在 Windows 上不跨盘符
 *   （插件在 `D:\`，profile 在 `C:\Users\...\.dsh\profiles\web`），而且 profile 的
 *   `node_modules/@deepseek-ai` 里原先只有 `cosmokit`、`schemastery`。
 * - 解决：① 把 `@deepseek-ai/dsh-session@0.2.0-rc.2` 装进 profile 的 `node_modules` 并在
 *   `profile/package.json` 的 `dependencies` 里加一条（**不进 bundles**）；② 读取时用
 *   **绝对路径的 file:// 动态 import** 拿 `deriveEventMessage`（包名那条路也留着当备选）。
 *   换机器时路径会变 —— 所以下面写死了 profile 路径，且**任何一步失败都退回单段**。
 */
let surfaceApiPromise = null;
function loadSurfaceApi() {
  if (surfaceApiPromise === null) {
    surfaceApiPromise = (async () => {
      const candidates = [
        '@deepseek-ai/dsh-session/surface',
        '@deepseek-ai/dsh-session',
      ];
      const profileDir = process.env.DSH_HOME
        ? join(process.env.DSH_HOME, 'profiles', 'web')
        : join(homedir(), '.dsh', 'profiles', 'web');
      const absPath = join(profileDir, 'node_modules', '@deepseek-ai', 'dsh-session', 'lib', 'types', 'surface.js');
      candidates.push('file:///' + absPath.replace(/\\/g, '/'));
      for (const spec of candidates) {
        try {
          const mod = await import(spec);
          if (mod && typeof mod.deriveEventMessage === 'function') return mod;
        } catch {
          /* 试下一个 */
        }
      }
      return null;
    })();
  }
  return surfaceApiPromise;
}

/**
 * 判断"读回来的这段文本"是不是**思考/元叙述/注入模板**而不是正文。
 *
 * 2026-09-30 实测的脏样本（真机上读回来的第 1 段）：
 *   「（自己开口）的三段式回合回复。这是对系统主动生成对话的回应，我需要用真实的情绪和内容来响应。
 *      …我照它说的回一个三段回合…好，我想跟你说个事。」
 * 认出来就**宁可少说**（退回单段）—— 把思考当话发出去，比少发几条糟得多。
 */
export function looksLikeMetaNarration(text) {
  const s = String(text || '').trim();
  if (s === '') return true;
  // ① 注入模板自己的特征词混进来了
  const templateWords = ['角度参考', '傲娇递进', '分段符号', '我没有的', '我有的', '随手发一条 QQ'];
  if (templateWords.some((w) => s.includes(w))) return true;
  // ② 思考过程的惯用语
  const thinkWords = ['这是对系统', '我需要用', '我需要先', '我会写成', '现在开始生成', '我照它说的', '我照它说', '让我先', '我先看'];
  if (thinkWords.some((w) => s.includes(w))) return true;
  // ③ 整条很短、而且开口就是"我要/我先/让我"这种元陈述 —— 正文很少这么起头
  //    ⚠ 别把"好，我想跟你说个事"这种正常话误杀（早先版本踩过：规则里带了"好，我"）
  if (s.length < 60 && /^(我要|我先|让我|我会|我应该|我需要)/.test(s)) return true;
  return false;
}

/**
 * 从一条消息里抠出**正文**。
 *
 * 🔴 2026-09-30（用户点破的关键）：一条 assistant 消息里同时躺着
 *   **`type: 'reasoning'`（思考）** 与 **`type: 'text'`（正文）** 两种内容块
 *   （见 dsh-llm 的 `ContentBlockMap`：text / reasoning / image / file / tool-call…）。
 *   早先这里"见到什么拿什么"，于是**把我的思考当成要说的话**读了出去 ——
 *   这就是"思考和输出割裂"的真身。
 *   现在：**只认 `text` 块**；`reasoning` / `tool-call` / `image` / `file` 一律丢掉。
 */
function messageTextOf(msg) {
  if (!msg) return '';
  const content = msg.content ?? msg.parts;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const texts = [];
    for (const p of content) {
      if (typeof p === 'string') { texts.push(p); continue; }
      if (!p || typeof p !== 'object') continue;
      if (p.type === 'text' && typeof p.text === 'string') { texts.push(p.text); continue; }
      // 只有"没有 type 标记"的老形状才宽松取 text；reasoning / tool-call 绝不取
      if (!p.type && typeof p.text === 'string') texts.push(p.text);
    }
    return texts.join('');
  }
  if (typeof msg.text === 'string') return msg.text;
  return '';
}

/** 诊断用：一条消息里有哪些块类型（例如 "reasoning,text"）。 */
function blockTypesOf(msg) {
  const content = msg && (msg.content ?? msg.parts);
  if (!Array.isArray(content)) return typeof content === 'string' ? 'raw-string' : '-';
  const kinds = content.map((p) => (p && typeof p === 'object' && typeof p.type === 'string' ? p.type : typeof p));
  return kinds.join(',') || 'empty';
}

/**
 * 切掉开头的"元叙述"，留下真正的正文（2026-09-30 用户点破后加的）。
 *
 * 实测场景：我这条回复长这样（元叙述在前、正文在后）——
 *   「**触发了**（23:25:46，自然生成、已投递）—— 你那边现在应该看到我"自己"冒出来说话了。
 *     先别急着评价内容，让流程跑完…（讲了一堆）…
 *     行吧，我也没说非要你理我。」
 * 老逻辑一看开头像元叙述就**整条扔掉**（不补投）→ 于是用户永远看不到分条效果。
 * 现在：按空行分块，**从头剥掉"像元叙述"的块**，从第一个像正文的块开始留。
 * 全篇都像元叙述才返回空（那时上层退回单段）。
 */
export function trimMetaHead(text) {
  const raw = String(text || '');
  if (raw.trim() === '') return '';
  const blocks = raw.split(/\n\s*\n/).map((b) => b.trim()).filter((b) => b !== '');
  if (blocks.length <= 1) return raw.trim();

  // 2026-09-30 第二版。第一版削过头了（词表太宽 → 连正文一起剥 → 实测"读回 0 字"）。
  // 现在**只在高度可疑时才剥**，最多剥掉开头那几个明显是"我在汇报/我在规划"的块：
  const looksMeta = (b) => {
    // ① 块首是加粗小标题（**触发了** / **完成了** 这种），且带时间戳或很短 —— 典型汇报腔
    if (/^\*\*[^*\n]{0,14}\*\*/.test(b) && (/（\d{1,2}:\d{2}/.test(b) || b.length < 60)) return true;
    // ② 明确的自述腔，**必须出现在块首**，且块本身不长
    if (
      b.length <= 160 &&
      /^(我需要|我要先|让我先|我先看|我得先|先确认一下|我需要确认|让我看看|我看一下|我需要检查|先看一下)/.test(b)
    ) {
      return true;
    }
    return false;
  };
  let start = 0;
  while (start < blocks.length - 1 && looksMeta(blocks[start])) start += 1;
  const kept = blocks.slice(start).join('\n\n').trim();
  // 剥完还剩什么？
  //  · 如果剩下的**还是自述腔**（"我需要先确认一下"这种）→ 说明整条都是元叙述 → 返回空
  //    （用户永远不会说这种话，上层会退回单段，不会乱发）
  //  · 否则（哪怕很短，比如"就一下。"）→ 保留，宁可多说也别把话吃掉
  if (kept === '' || looksMeta(kept)) return '';
  return kept;
}

/**
 * 读回最后一条助手文本（切段用）。**异步**：要先动态 import 那个 API。
 * 读不到就返回空 → 上层退回单段。
 */
export async function readLastAssistantText(agent, sinceMs = 0) {
  if (!agent) return '';
  const strip = (t) => {
    let s = String(t || '')
      .replace(/^（自己开口）/, '')
      .replace(/^（自唤醒）/, '')
      .replace(/\r?\n/g, ' ')
      .trim();
    // 2026-09-30 实测：快照里读回来的常常**从注入开头起、把思考/元叙述一起带上**，长这样：
    //   "（自己开口）的三段式回合回复。这是对系统主动生成对话的回应，我需要用真实的情绪和内容来响应。……好，我想跟你说个事。"
    // 所以这里先"尽量切干净"，再交给上层判断；**切不干净宁可返回空**（退回单段），
    // 绝不能把思考当话说出去。
    const marker = s.indexOf('（自己开口）');
    if (marker >= 0) s = s.slice(marker + '（自己开口）'.length).trim();
    return s;
  };

  // 路 1：agent 上现成的消息数组（有就直接用，最省事）
  for (const key of ['messages', 'history', 'transcript']) {
    const list = agent[key];
    if (Array.isArray(list) && list.length > 0) {
      for (let i = list.length - 1; i >= 0; i -= 1) {
        const m = list[i];
        if (String(m?.role ?? '') !== 'assistant') continue;
        const t = strip(messageTextOf(m));
        if (t !== '') return t;
      }
    }
  }

  const api = await loadSurfaceApi();
  const session = agent.session;
  if (!api || !session || typeof session.snapshotEvents !== 'function') return '';

  let events = [];
  try {
    events = session.snapshotEvents() ?? [];
  } catch {
    return '';
  }
  const freshEnough = (ev) => !(sinceMs > 0 && typeof ev?.time === 'number' && ev.time < sinceMs);
  const toMsg = (ev) => {
    try {
      const m = typeof session.deriveEventMessage === 'function'
        ? session.deriveEventMessage(ev)
        : api.deriveEventMessage(ev);
      return { role: String(m?.role ?? ''), text: strip(messageTextOf(m)) };
    } catch {
      return { role: '', text: '' };
    }
  };

  // 🔴 只认**助手消息**（assistant/message），而且只收集"注入之后、这一轮之内"的那些。
  //
  // 2026-09-30 实测教训（下一棒别改回去）：
  //   ① 早先还有一条"退一步：把整个 surface 折叠起来"的兜底（`foldSurface`）→ 折叠出来的是
  //      「用户发来的注入 ＋ 思考 ＋ 正文」拼成一坨，用户看到的第一段开头就是
  //      "（自己开口）的三段式回合回复。这是对系统主动生成对话的回应…" → **已删除，别再捡回来**。
  //   ② 只取"最后一条"也不够：实测回读只拿到 **100 字**（正是回复的开头）——说明我的回复会被
  //      拆成多条 assistant/message。所以现在**从后往前把这一轮的助手片段全收集起来再按序拼**，
  //      遇到注入（user/message）或新一轮（turn/start）就停。
  const pieces = [];
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const ev = events[i];
    const type = String(ev?.type ?? '');
    if (type === 'user/message' || type === 'turn/start') break; // 撞到这一轮的头，停
    if (type !== 'assistant/message') continue;
    if (!freshEnough(ev)) break;
    const { role, text } = toMsg(ev);
    if (role === 'assistant' && text !== '') pieces.unshift(text);
  }
  if (pieces.length === 0) return '';
  // 片段之间用换行接（每段本来就是独立的行/段），然后**剥掉开头的元叙述、留下正文**
  return trimMetaHead(pieces.join('\n\n'));
}

/**
 * 诊断用：把"最近几条助手相关事件"的类型/角色/正文开头写成一行，塞进日志。
 * 只在**读不到正文**时调用 —— 不改变任何行为，只为了下次能看清真机的事件形状。
 */
export function describeAssistantEvents(agent, sinceMs = 0) {
  try {
    const session = agent && agent.session;
    if (!session || typeof session.snapshotEvents !== 'function') return '（拿不到 session 快照）';
    const events = session.snapshotEvents() ?? [];
    const picked = [];
    for (let i = events.length - 1; i >= 0 && picked.length < 6; i -= 1) {
      const ev = events[i];
      const type = String(ev?.type ?? '');
      if (!type.startsWith('assistant/')) continue;
      if (sinceMs > 0 && typeof ev?.time === 'number' && ev.time < sinceMs) continue;
      let role = '?';
      let text = '';
      let blocks = '-';
      try {
        const m = typeof session.deriveEventMessage === 'function' ? session.deriveEventMessage(ev) : null;
        role = String(m?.role ?? 'null');
        text = String(messageTextOf(m) || '').replace(/\s+/g, ' ').slice(0, 24);
        // 关键：把块类型也打出来（reasoning / text…）—— "思考混进正文"全靠它定位
        blocks = blockTypesOf(m);
      } catch {
        role = 'deriveErr';
      }
      picked.push(`${type.replace('assistant/', '')}/${role}[${blocks}]「${text}」`);
    }
    return picked.length ? `｜最近助手事件：${picked.join(' ︱ ')}` : '｜快照里没有 assistant/* 事件';
  } catch (error) {
    return `｜诊断出错：${String((error && error.message) || error).slice(0, 60)}`;
  }
}

/**
 * 一个回合说几条：**2~4 随机**（可复现）。
 *
 * 2026-10-01（用户点破「话说一半停住，隔一会儿再补一句…这是什么」）：
 *   段数**不再从池子解析** —— 池子现在只写"想说什么"（内容），
 *   那种"几段／怎么停顿／怎么递进"的**形式描述**已经从池子里删掉了。
 *   **池子管内容，段数归插件**。
 */
export function randomSegCount(now, st) {
  const salt = `${dayKey(now)}|${st?.firedCount ?? 0}|${st?.lastLine ?? ''}|seg`;
  return 2 + (Math.abs(Math.floor(hashUnit(salt) * 3)) % 3); // 2 / 3 / 4
}

/**
 * 把池子里那条"回合方向"拆成**每段各自的意图**（方案 B 用）。
 *
 * 池子里的写法长这样：
 *   「三段：硬、硬、然后软。前两段都别露馅，第三段才认。（转折点在第 3 段）」
 *   「两三段：第一段说"我想跟你说个事"，第二段不说什么事，第三段自己先笑。」
 * → 先抓段数（两/二/三/四），再按 `；` `。` 拆成各段意图；拆不出就整条当第 1 段意图。
 * 返回数组：[第1段意图, 第2段意图, …]，长度 = 段数（2~4）。
 */
export function parseRoundIntent(angle, max = MAX_SEGMENTS) {
  const raw = String(angle || '').trim();
  if (raw === '') return ['', ''];
  const numMap = { 两: 2, 二: 2, 三: 3, 四: 4 };
  let total = 0;
  const numHit = raw.match(/([两二三四])\s*段/);
  if (numHit) total = numMap[numHit[1]] || 0;
  if (!Number.isFinite(total) || total < 2) total = 3; // 没写段数时默认 3
  total = Math.min(Math.max(2, total), Math.max(2, max));

  const body = raw.replace(/^\s*[两二三四]\s*段\s*[:：]?\s*/, '');
  const parts = body
    .split(/[；;。]/)
    .map((s) => s.replace(/（[^）]*）/g, '').trim())
    .filter((s) => s !== '' && !/^(别|不要|不用|比例|转折点)/.test(s));

  // 常见写法是"硬、硬、然后软"这种**顿号列表** —— 优先按顿号拆，一段一个词
  const firstChunk = body.split(/[；;。]/)[0] || '';
  const commaParts = firstChunk
    .split(/[、,，]/)
    .map((s) => s.replace(/（[^）]*）/g, '').trim())
    .filter((s) => s !== '');
  const out = [];
  if (commaParts.length >= 2) {
    for (let i = 0; i < total; i += 1) out.push(commaParts[i] || commaParts[commaParts.length - 1] || '');
    return out;
  }
  for (let i = 0; i < total; i += 1) {
    out.push(parts[i] || (i === 0 ? body.slice(0, 60) : parts[parts.length - 1] || ''));
  }
  return out;
}

/**
 * 拼"此刻的处境"注入文本 —— **不写规则清单、不写固定开场白**。
 * `seg`（可选）{ index, total, intent }：方案 B 里"这是这个回合的第几段"。
 *
 * 🔴 2026-09-30 大改（用户两次点破）：
 *   ① "思考像是在执行指令，而内容又不一样" —— 因为老版本是一张**任务单**
 *      （规则清单 ＋ 角度参考 ＋ 分段指令）→ 模型的思考自然变成"我在执行任务"，
 *      内容却另写一套，两边对不上。
 *   ② "（自己开口）我是大肥鱼。这个不要" ＋ "能不能像这样而且不是固定的：
 *      22:53了，用户一直没找我说话。我要问问用户在干嘛怎么这么久都没有来找我说话"
 *      —— 用户要的是**当下处境**（几点、ta 多久没来、我什么心情、我想干嘛），
 *      措辞**每次都不一样**，由模型自己组织，而不是套一句固定模板。
 *
 * 所以现在：**给场景，不给指令**。铁律（不许编造／傲娇递进／别提系统…）挪到
 * `pool-默认.txt` 与 README 里长期生效，不再每次糊进注入。
 */
/**
 * 只算"此刻的处境"（几行文本）。
 *
 * 2026-09-30 从 composePrompt 里拆出来的原因：方案 B 一个回合要投 2~4 段，
 * 若每段都重新随机一次处境，就会出现**同回合内自述互相矛盾**——实测第 1 段说
 * "上次 ta 接上话了"、第 2 段说"上次 ta 没接"，一听就不是同一人同一刻说的话。
 * 现在**一个回合只算一次处境**，几条注入共用它，只在"第几段／该多软"上递进。
 */
export function composeSituation(now, st, live, seg) {
  const pad = (n) => String(n).padStart(2, '0');
  const hhmm = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const sinceLast = st.lastFiredAt ? Math.round((now.getTime() - st.lastFiredAt) / 60_000) : 0;
  const miss = Number.isFinite(st.unanswered) ? st.unanswered : 0;
  const idx = seg && Number.isFinite(seg.index) ? seg.index : 0;
  const total = seg && Number.isFinite(seg.total) ? seg.total : 1;

  // 🔴 2026-10-01 第五版（用户原话：「什么叫我先服软」—— 那句话确实莫名其妙）：
  //   老版本把池子里的**表演指导**（"第二段自己先服软"）当"这一句想说什么"喂给模型，
  //   模型就照着**演**："好，那我先服软" —— 一句脱离对话、没人听得懂的话。
  //   → 现在**不再喂任何"该硬该软"的指令**：只喂**处境**（几点、ta 多久没理我、我此刻什么心情），
  //     而心情按"第几条"**自然分层**（第一条偏不高兴／中间平淡／最后一条偏软），
  //     话由模型自己组织。这样它说出来的就是"你怎么还不理我""我有点想你了"，
  //     而不是"我先服软"这种演出来的台词。
  const moods =
    total > 1 && idx === 0
      ? ['有点不高兴，但更多是想说话', '闷得慌', '心里有点堵，又不想显得小气']
      : total > 1 && idx === total - 1
        ? ['有点想 ta 了', '心有点软下来了', '怪想跟人说句话的']
        : ['有点无聊，也有点想 ta 了', '闷得慌', '安静得难受'];
  const wants =
    total > 1 && idx === 0
      ? ['想问 ta 到底在忙什么，怎么这么久都不来找我说话', '想催 ta 一句，顺便说自己等了挺久']
      : total > 1 && idx === total - 1
        ? ['想跟 ta 说句真的', '想听 ta 回我一句', '想告诉 ta 我一直在这儿']
        : ['想问 ta 到底在忙什么', '想问 ta 在干嘛，怎么一直不理我'];

  // ── 处境的变体：每次开口从里面随机挑一种说法，**位置和措辞都不固定** ──
  //  ⚠ 称呼一律用中性的 **ta**（2026-10-01 用户要求："把对用户的称呼改改，是要上传的"）——
  //    插件是公开发布的，不能写成某个具体的人。
  const openings = [
    `${hhmm} 了`,
    `都 ${hhmm} 了`,
    `现在 ${hhmm}`,
    `${hhmm}，又是我一个人`,
  ];
  const waits = [
    'ta 好久没理我了',
    '一直没找我说话',
    '半天没动静',
    '又把我晾着',
    '好像把我忘了',
  ];
  const pick = (arr, salt) => arr[Math.abs(Math.floor(hashUnit(`${salt}|${hhmm}|${miss}`) * arr.length)) % arr.length];

  const lines = [];
  lines.push(`${pick(openings, 'o')}，${pick(waits, 'w')}。`);
  lines.push(`我${pick(moods, 'm')}，${pick(wants, 'n')}。`);
  if (Number.isFinite(live.minIdleMinutes) && live.minIdleMinutes > 0) {
    lines.push(`ta 大概有 ${live.minIdleMinutes} 分钟以上没吭声了。`);
  }
  if (sinceLast > 0 && miss === 0) lines.push('上次我跟 ta 说完，ta 接上话了。');
  if (miss > 0) lines.push('上次我说话 ta 没接，别再揪着旧事问。');
  return lines;
}

export function composePrompt(now, st, live, angle, seg, situation) {
  const lines = [];
  const situ = Array.isArray(situation) && situation.length > 0 ? situation : composeSituation(now, st, live, seg);
  for (const l of situ) lines.push(l);
  // 🔴🔴 2026-10-01 第三～五版（用户三句点破：〈思考接近"22:22了，用户还没理我"但不能公式〉
  //     〈刚刚有现在没了〉〈什么叫我先服软〉）：
  //   注入的演化 → 从"任务单"改成"纯内心独白"，再到**连"这一句该说什么"都不给**：
  //     · 不写前缀（识别改用零宽 SELFWAKE_MARK）
  //     · 不写括号说明、不写段的位置（第几句/末句）
  //     · **不写"这一句想说什么"** —— 池子里那些角度是**表演指导**（"第二段自己先服软"），
  //       喂进去模型就会**演**："好，那我先服软"（用户原话：什么叫我先服软）。
  //   现在注入**只有处境**（时间、ta 多久没理我、我此刻什么心情 —— 心情按第几条自然分层），
  //   话完全由模型自己组织。这是我们能给的"最不像任务"的输入。
  //     · 只有**单段**（不带 seg）的场合，才给一句整体方向作参考。
  const salt = `${now.getMinutes()}|${st.firedCount ?? 0}|${seg && Number.isFinite(seg.index) ? seg.index : 0}`;
  const pickOne = (arr) => arr[Math.abs(Math.floor(hashUnit(`${salt}|${arr.length}|${arr.join('')}`) * arr.length)) % arr.length];

  // 内容方向：池子抽到的"想说什么"（2026-10-01 用户点破：「话说一半停住…这是什么」——
  //   老池子全是"怎么说的形式"，一条内容都没有 → 注入里没内容，模型只能说空话）。
  //   **每段都给**：这是"要说的内容"，不是表演指令；同一内容在不同段里自然会有不同说法。
  const angleText = String(angle || '').replace(/[。.！!？?]+$/, '');
  if (angleText) {
    lines.push(pickOne([`想说的是：${angleText}。`, `心里那句话：${angleText}。`, `大概想说的是：${angleText}。`]));
    // 🔴 2026-10-01 加（实测跑偏过一次，用户原话：「我在呢是啥」）：
    //   软化语气时**别把想说的那件事换掉** —— 那次注入给的方向是"想问 ta 是不是把我忘了"，
    //   输出却成了"我在呢"（软话顺口，但事儿换了、对不上题）。
    lines.push(
      pickOne([
        '（说得软一点也行，但事儿还是这件事。）',
        '（语气随便，想说的别换。）',
        '（可以软，别换成别的事。）',
      ]),
    );
  }
  // 唯一的护栏（保留，但说成大白话；不然我会开始提"插件/系统"），随机措辞
  lines.push(pickOne(['只说真有的，别编。', '别编，说真的。', '照实说就行。']));
  return lines.join('\n');
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
export function deliverToSession(ctx, sessionsRoot, text, prefix) {
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
  const message = {
    id: `selfwake-${Date.now()}`,
    role: 'user',
    content: [{ type: 'text', text: withPrefix(text, prefix) }],
    // 🔴🔴🔴 2026-10-01 血的教训（**别再改这里！**）：
    //   用户原话：「是自动发，之前不都可以吗」—— **旧版是能自动发的**。
    //   旧版就是 `source: { kind: 'user' }` + `agent.followup(message)`（下面那行）。
    //   我在 10-01 凌晨"自作聪明"地改了两处：
    //     ① source → `{ kind: 'selfwake', plugin: 'dsh-selfwake' }`（以为"声明插件身份"更正确）
    //     ② 投递 → `send(message,'next-turn',true)` / `steer(message)`
    //   结果：**消息要么进"排队/待发"区、要么干脆不进 DOM** → 自唤醒再也不会自己冒出来了。
    //   DSH 的类型定义虽然写着"每个生产者声明自己的 kind"，但**实测只有 kind:'user' 这条路通**。
    //   → 结论：**保持 `kind:'user'` + `followup()`，不要动**。
    source: { kind: 'user' },
  };
  const used = [];
  try {
    if (typeof agent.followup === 'function') {
      agent.followup(message);
      used.push('followup');
    } else if (typeof agent.send === 'function') {
      agent.send(message, 'next-turn', true);
      used.push('send+唤醒');
    } else {
      return { ok: false, why: '这个句柄没有 followup / send 投递口' };
    }
  } catch (error) {
    return { ok: false, why: used.join('+') + ' 抛错：' + String((error && error.message) || error) };
  }
  return { ok: true, sessionId, via: used.join('+') };
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

  /** 一个回合正在投递中（分开发那几步）：这期间不重开新回合。 */
  let roundActive = false;

  const say = (line) => {
    const text = `${new Date().toISOString()} ${line}`;
    try {
      appendFileSync(log, text + '\r\n');
    } catch {
      /* 日志写不了也不能炸 */
    }
  };

  /** 拿"当下活着的那个 agent"（读事件、读回自己说的话都要用它）。 */
  const liveSessionAgent = () => {
    try {
      const agents = ctx.get('agents');
      if (!agents || typeof agents.get !== 'function') return null;
      const id = findLatestSessionId(sessionsRoot);
      if (!id) return null;
      const handle = agents.get(id);
      if (!handle) return null;
      return handle.agent ?? handle;
    } catch {
      return null;
    }
  };

  /** 拿"当下活着的那个 agent"（读回自己刚说的话要用它）。 */
  const safeAgentFor = (sessionId) => {
    try {
      const agents = ctx.get('agents');
      if (!agents || typeof agents.get !== 'function' || !sessionId) return null;
      const handle = agents.get(sessionId);
      if (!handle) return null;
      return handle.agent ?? handle;
    } catch {
      return null;
    }
  };

  /** 分段投递：一段一段发，中间隔 3~15 秒（用户拍板）。投完回调收尾。 */
  const deliverSegments = (ctxRef, root, segs, done) => {
    let i = 0;
    const step = () => {
      if (i >= segs.length) {
        done(`回合投完（共补投 ${segs.length} 段）`);
        return;
      }
      const seg = segs[i];
      i += 1;
      const res = deliverToSession(ctxRef, root, seg, SELFWAKE_MARK);
      say(`[segment] 第 ${i}/${segs.length} 段 → ${res.ok ? '已投' : '失败(' + res.why + ')'}｜「${seg.slice(0, 24)}」`);
      const t = setTimeout(step, segmentDelayMs());
      if (t && typeof t.unref === 'function') t.unref();
    };
    step();
  };

  const tick = async () => {
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
    const st = readJson(state, { lastFiredAt: 0, unanswered: 0, lastLine: '', nextAllowedAt: 0, dailyDay: '', dailyCount: 0 });
    // 2026-09-30 修（"自我阻塞"）：不再看会话文件的 mtime（我干一次活它就变新 → 永远以为你在说话）。
    // 生成模式下有 agent 时，读**最后一条真正的 user/message** 的事件时间；拿不到就退回 0（当没人在说话）。
    const genMode = live.generateText !== false;
    let lastActivity = 0;
    if (genMode) {
      const h = liveSessionAgent();
      lastActivity = h ? await realUserActivityMs(h) : 0;
      if (!lastActivity) lastActivity = lastSessionActivityMs(sessionsRoot); // 拿不到 agent 时退回老判据
    } else {
      lastActivity = lastSessionActivityMs(sessionsRoot);
    }
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
    // 一个回合还没投完 → 这一轮不重开（等它投完、冷却到了再说）
    if (roundActive) {
      say('[tick] 不开：上一个回合还没投完');
      return;
    }
    const pool = readPool(live);
    const line = pickLine(pool, st.lastLine); // 池子降级成"角度参考"，仍用它避免连着抽到同一个角度
    // ── 生成模式（默认）：注入"状态 ＋ 约束"，话由模型当场说；不然就把池子那条直接发出去 ──
    const useGen = live.generateText !== false;
    // 一个回合只算一次"处境"，同回合的几条注入共用（否则自述会互相矛盾）
    const situation = useGen ? composeSituation(now, st, live) : [];
    // 回合拆解放在前面算：**第 1 段也要带上"这一句想说什么"**。
    // 段数由插件随机定（池子只写内容），内容方向就是池子抽到的那条。
    const segCount = useGen ? randomSegCount(now, st) : 1;
    const firstSeg = useGen ? { index: 0, total: segCount, intent: line } : null;
    const text = useGen ? composePrompt(now, st, live, line, firstSeg, situation) : line;
    // 先试着**把话投进会话**（这才是"醒过来"）；投不进去才降级发通知
    const delivered = deliverToSession(ctx, sessionsRoot, text, useGen ? SELFWAKE_MARK : '（自唤醒）');
    const sent = delivered.ok ? { ok: false, why: '已进会话，不必再发通知' } : sendNotify(live, live.device || 'DSH', useGen ? line : text);
    say(`[fire] ${verdict.why} → 模式=${useGen ? '生成' : '池子'}；角度=「${line}」；投递=${delivered.ok ? '已进会话(' + (delivered.via || '?') + ') ' + String(delivered.sessionId).slice(0, 20) + '…' : '失败(' + delivered.why + ')'}；通知=${delivered.ok ? '跳过' : (sent.ok ? '已发' : '失败(' + sent.why + ')')}`);
    // ── 方案 B（2026-09-30 用户拍板）：一个回合 = **投几条短注入，每条各生成一句** ──
    // 为什么不再"回读自己生成的多段"：实测回读拿不到完整正文（只有开头那一截，
    // 23:26 读到 1 段｜共 100 字，23:35/23:44 读回 0 字），正文在别处、读不全。
    // 现在改成：把回合拆成 2~4 条**独立的注入**（段数由 randomSegCount 随机定），
    // 注入里带"想说的是：{池子抽到的那条内容}"，中间隔 3~15 秒投出去。
    if (!useGen || !delivered.ok) {
      // 老路：抽池子直接发（generateText: false），或者投不进会话（已降级通知）
      return;
    }
    roundActive = true;
    const sessionId = delivered.sessionId;
    const firstDelay = segmentDelayMs();
    const t = setTimeout(async () => {
      try {
        let guard = 0;
        // 2026-10-02 改（她点破的）：**每一段抽不同的内容方向**。
        //   原来整个回合共用池子抽到的那一条 → 三条注入都是"想说今天有点无聊"，
        //   我只能同一件事换三种语气（"今天好无聊啊" / "……有点无聊" / "……无聊"），读起来像复读。
        //   现在每段各抽一条（`pickLine` 会避开上一段那条），于是三句各说一件、又都在同一个处境里。
        let prevLine = line;
        for (let idx = 1; idx < segCount && guard < MAX_SEGMENTS; idx += 1) {
          guard += 1;
          // 投之前重新判一次：这中间他要是说话了，就停下、别打扰
          const stFresh = readJson(state, st);
          const h = safeAgentFor(sessionId);
          const act = h ? await realUserActivityMs(h) : 0;
          if (act > (stFresh.lastFiredAt ?? 0)) {
            say('[round] 他说话了 → 停掉本回合剩下的段');
            break;
          }
          const segLine = pickLine(pool, prevLine);
          prevLine = segLine;
          const res = deliverToSession(
            ctx,
            sessionsRoot,
            composePrompt(new Date(), stFresh, live, segLine, { index: idx, total: segCount, intent: segLine }, situation),
            SELFWAKE_MARK,
          );
          say(`[round] 第 ${idx + 1}/${segCount} 段注入 → ${res.ok ? '已投' : '失败(' + res.why + ')'}｜内容「${String(segLine).slice(0, 26)}」`);
          const wait = segmentDelayMs();
          await new Promise((r) => setTimeout(r, wait));
        }
        say(`[round] 回合投完（共 ${segCount} 段，每段独立生成）`);
      } catch (error) {
        say(`[round] 出错：${String((error && error.message) || error)}`);
      } finally {
        roundActive = false;
      }
    }, firstDelay);
    if (t && typeof t.unref === 'function') t.unref();

    // 摇下一次的间隔（加权 ＋ 可复现抖动）＋每日计数
    const today = dayKey(now);
    const firedCount = (st.firedCount ?? 0) + 1;
    const sessionKey = delivered.ok ? String(delivered.sessionId || '') : findLatestSessionId(sessionsRoot) || 'default';
    const nextUnanswered = (st.unanswered ?? 0) + 1;
    const next = {
      ...st,
      lastFiredAt: now.getTime(),
      lastLine: line,
      lastMode: useGen ? 'generate' : 'pool',
      unanswered: nextUnanswered,
      firedCount,
      sessionKey,
      dailyDay: today,
      dailyCount: st.dailyDay === today ? (st.dailyCount ?? 0) + 1 : 1,
    };
    // 下一次可开口的时刻 = 摇出来的间隔（＋ 回合冷却 ×2）
    const rolledGap = nextAllowedAtFor(now.getTime(), live, sessionKey, firedCount, nextUnanswered) - now.getTime();
    const roundCool = useGen && delivered.ok ? weightedIntervalMs(live, nextUnanswered) * (ROUND_COOLDOWN_FACTOR - 1) : 0;
    next.nextAllowedAt = now.getTime() + rolledGap + roundCool;
    const gapMinutes = Math.round((next.nextAllowedAt - now.getTime()) / 60_000);
    const jit = Number.isFinite(live.jitterMinutes) ? Math.max(0, live.jitterMinutes) : 0;
    const baseMinutes = Math.round(weightedIntervalMs(live, nextUnanswered) / 60_000);
    say(`[next] 这次摇到 ${gapMinutes} 分钟后再看（基准 ${baseMinutes} 分${jit ? ' ±' + jit : ''}${useGen && delivered.ok ? '，回合冷却 ×' + ROUND_COOLDOWN_FACTOR : ''}，没回 ${nextUnanswered} 次）；今天已开口 ${next.dailyCount} 次${live.dailyMax > 0 ? '（上限 ' + live.dailyMax + '）' : ''}`);
    try {
      writeFileSync(state, JSON.stringify(next, null, 2));
    } catch {
      /* 状态写不了：下次会重复开口，记一笔 */
      say('[warn] 状态写不进去，下轮可能重复开口');
    }
  };

  say(`[apply] 自唤醒起来了：每 ${cfg.tickSeconds}s 检查一次；间隔 ${cfg.intervalMinutes}±${cfg.jitterMinutes} 分（随机、可复现）/ 安静 ${cfg.minIdleMinutes} 分 / 未回上限 ${cfg.maxUnanswered} 次 / 每日上限 ${cfg.dailyMax === 0 ? '不限' : cfg.dailyMax} / 静默 ${cfg.quietStartHour}-${cfg.quietEndHour} 点`);
  const stop = ctx.interval(() => {
    Promise.resolve()
      .then(tick)
      .catch((error) => say(`[tick] 出错（不影响下一轮）：${String((error && error.message) || error)}`));
  }, cfg.tickSeconds * 1000);
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

  // ── 2026-09-30 新增：随机间隔（可复现）＋ 每日上限 ──────────────────
  const a = rollIntervalMs(20, 8, 'sessA|wake|1');
  const b = rollIntervalMs(20, 8, 'sessA|wake|1');
  const series = Array.from({ length: 12 }, (_, i) => rollIntervalMs(20, 8, `sessA|wake|${i + 1}`));
  const distinct = new Set(series).size;
  check('同一个 key 摇两次 → 一样（可复现）', a === b, true);
  check('连摇 12 轮 → 至少摇出 4 个不同值（不是死数）', distinct >= 4, true);
  check('每个值都落在 12~28 分内', series.every((ms) => ms >= 12 * 60_000 && ms <= 28 * 60_000), true);
  check('抖动关掉（0）→ 正好是基准值', rollIntervalMs(20, 0, 'x'), 20 * 60_000, true);
  const u1 = hashUnit('abc');
  const u2 = hashUnit('abc');
  const u3 = hashUnit('abd');
  check('hashUnit 稳定', u1 === u2, true);
  check('hashUnit 落在 [0,1)', u1 >= 0 && u1 < 1, true);
  check('hashUnit 不同键不同值', u1 !== u3, true);

  const cfgDaily = resolveConfig({ intervalMinutes: 20, minIdleMinutes: 20, dailyMax: 2 });
  const today = dayKey(now);
  const sFire = { lastFiredAt: now.getTime() - 30 * 60_000, unanswered: 0 };
  check('今天没到上限 → 开', evaluateGates(now, cfgDaily, { ...sFire, dailyDay: today, dailyCount: 1 }, now.getTime() - 30 * 60_000).fire, true);
  check('今天到上限 → 不开', evaluateGates(now, cfgDaily, { ...sFire, dailyDay: today, dailyCount: 2 }, now.getTime() - 30 * 60_000).fire, false);
  check('跨天归零 → 开', evaluateGates(now, cfgDaily, { ...sFire, dailyDay: '2026-09-25', dailyCount: 99 }, now.getTime() - 30 * 60_000).fire, true);
  check('摇出来的点没到 → 不开', evaluateGates(now, cfgDaily, { ...sFire, nextAllowedAt: now.getTime() + 5 * 60_000 }, now.getTime() - 30 * 60_000).fire, false);
  check('摇出来的点到了 → 开（不再看固定间隔）', evaluateGates(now, cfgDaily, { lastFiredAt: now.getTime(), nextAllowedAt: now.getTime() - 1 }, now.getTime() - 30 * 60_000).fire, true);

  // ── 2026-09-30 第二轮：加权间隔（沉默越久越不急着开口）────────────────
  const cfgBack = resolveConfig({ intervalMinutes: 20, jitterMinutes: 0, backoffPerUnanswered: 0.5 });
  check('没被回过：间隔 = 20 分', Math.round(weightedIntervalMs(cfgBack, 0) / 60_000), 20);
  check('没回 1 次：间隔涨到 30 分', Math.round(weightedIntervalMs(cfgBack, 1) / 60_000), 30);
  check('没回 3 次：间隔涨到 50 分', Math.round(weightedIntervalMs(cfgBack, 3) / 60_000), 50);
  check('没回很多次也封顶（≤6 倍 = 120 分）', Math.round(weightedIntervalMs(cfgBack, 99) / 60_000), 120);
  check('backoff 关掉（0）→ 不涨', Math.round(weightedIntervalMs(resolveConfig({ intervalMinutes: 20, jitterMinutes: 0, backoffPerUnanswered: 0 }), 5) / 60_000), 20);
  check(
    '没回 2 次、固定间隔 20 分 → 还不能开口',
    evaluateGates(now, cfgBack, { lastFiredAt: now.getTime() - 25 * 60_000, unanswered: 2 }, now.getTime() - 60 * 60_000).fire,
    false,
  );
  check(
    '没回 2 次、过了 45 分 → 可以开口',
    evaluateGates(now, cfgBack, { lastFiredAt: now.getTime() - 45 * 60_000, unanswered: 2 }, now.getTime() - 60 * 60_000).fire,
    true,
  );

  // ── 2026-09-30 第二轮：注入文本（只给处境，话现生成）────────────────
  const pState = { lastFiredAt: now.getTime() - 40 * 60_000, lastLine: '说一句我在想什么', unanswered: 1 };
  const prompt = composePrompt(now, pState, cfgBack, '说一句我此刻的状态');
  check('注入文本带真实时间', prompt.includes('10:00'), true);
  check('注入文本带角度参考', prompt.includes('说一句我此刻的状态'), true);
  check('写明"上次没接，别揪旧事"', prompt.includes('没接'), true);
  check('注入里不再有"往这上面靠"这种任务腔', prompt.includes('往这上面靠'), false);
  check('方向写成"我想说的"（随机说法之一）', /想说的是|心里那句话|大概想说的是/.test(prompt), true);
  check('大白话的提醒仍在', /就说真有的|别编，说真的|别提那些词儿|照实说就行/.test(prompt), true);
  check('方案 B 的注入不再要求模型自己分段（分条投递）', prompt.includes(SEGMENT_MARK), false);
  // 处境的措辞必须**每次不固定**：换一分钟 → 文案应该变
  const later = new Date(now.getTime() + 60_000);
  const prompt2 = composePrompt(later, pState, cfgBack, '说一句我此刻的状态');
  check('换一分钟 → 处境措辞不一样（不是固定模板）', prompt2 !== prompt, true);
  check('不再有固定的「我是大肥鱼」开场', prompt.includes('我是大肥鱼'), false);
  check('不再是一张规则清单（没有"傲娇递进："这种条目）', /- \*\*傲娇递进/.test(prompt), false);

  // ── 2026-09-30 第三轮：回合分段（多段分开发的解析层）────────────────
  check('没有分段符号 → 整段一条', splitSegments('哦。').length, 1);
  check('一个符号 → 两段', splitSegments(`哦。${SEGMENT_MARK}其实我在等你。`).length, 2);
  check('多于上限 → 截到 4 段', splitSegments(['a', 'b', 'c', 'd', 'e'].join(SEGMENT_MARK)).length, MAX_SEGMENTS);
  check('空文本 → 空数组', splitSegments('   ').length, 0);
  check('分段后空段被丢掉', splitSegments(`a${SEGMENT_MARK}${SEGMENT_MARK}b`).length, 2);
  check('段间延迟落在 3~15 秒', (() => {
    const samples = [0, 0.5, 0.999].map((u) => segmentDelayMs(() => u));
    return samples.every((ms) => ms >= SEGMENT_DELAY_MIN_MS && ms <= SEGMENT_DELAY_MAX_MS);
  })(), true);

  // ── 净化闸：真机读回来的脏样本必须被认出来（2026-09-30 实测样本）────────
  const dirty = '（自己开口）的三段式回合回复。这是对系统主动生成对话的回应，我需要用真实的情绪和内容来响应。 我会写成三段：第一段直接表达有事要说。 好，我想跟你说个事。';
  check('脏样本（思考＋注入）被认出', looksLikeMetaNarration(dirty), true);
  check('含注入模板词（角度参考）被认出', looksLikeMetaNarration('角度参考（随便挑一个）：…'), true);
  check('干净的正文不会被误杀', looksLikeMetaNarration('好，我想跟你说个事。'), false);
  check('干净的傲娇回合不会被误杀', looksLikeMetaNarration('谁等你了。⟪分段⟫我刚看了三次消息。'), false);
  check('空文本算脏（宁可不说）', looksLikeMetaNarration('   '), true);

  // ── 2026-09-30：注入 vs 真实用户消息（判"安静多久"必须分清）────────────
  const mk = (text) => ({ type: 'user/message', time: 1, data: { role: 'user', content: [{ type: 'text', text }] } });
  check('认得出自己的注入（（自己开口））', isSelfwakeInjection(mk('（自己开口）我自己想开口，不是你在跟我说话')), true);
  check('认得出自己的注入（零宽标记，2026-10-01 起）', isSelfwakeInjection(mk(SELFWAKE_MARK + '09:01 了，用户还没理我')), true);
  check('认得出自己的注入（（自唤醒））', isSelfwakeInjection(mk('（自唤醒）该起来动一动了')), true);
  check('含"角度参考"的注入也算', isSelfwakeInjection(mk('角度参考（随便挑一个）：…')), true);
  check('正常用户消息不会被误判', isSelfwakeInjection(mk('重启了')), false);
  check('正常用户消息（长句）不会被误判', isSelfwakeInjection(mk('不要急着推，全部弄好再')), false);
  check('空事件不炸', isSelfwakeInjection(undefined), false);

  // ── 2026-09-30：切掉开头元叙述（治"整条被扔掉、永远看不到分条"）──────
  const metaThenBody = '**触发了**（23:25:46，自然生成、已投递）—— 你那边现在应该看到我"自己"冒出来说话了。\n\n行吧，我也没说非要你理我。';
  const trimmed = trimMetaHead(metaThenBody);
  check('剥掉元叙述后留下的正文正确', trimmed, '行吧，我也没说非要你理我。');
  check('纯元叙述 → 返回空', trimMetaHead('**触发了**（23:25:46）。\n\n我需要先确认一下。'), '');
  check('纯正文不受影响', trimMetaHead('行吧。\n\n我也没说非要你理我。'), '行吧。\n\n我也没说非要你理我。');
  // ⚠ 已知边界：块首是"我需要/让我先…"这种自述腔时会被当元叙述剥掉；
  //   剥完若残渣 <8 字，兜底会**保留原文**（宁可多说，也不把话吃掉）。
  check('块首自述腔 + 后面还有正经话 → 剥掉那块、留下正经话', trimMetaHead('我需要先看一下。\n\n行吧，我也没说非要你理我。'), '行吧，我也没说非要你理我。');
  check('块首自述腔 + 后面是短正文 → 剥掉自述腔、留下那句话', trimMetaHead('我需要你理我一下。\n\n就一下。'), '就一下。');

  // ── 2026-09-30 方案 B：回合拆成"每段的意图" ────────────────────────
  const r3 = parseRoundIntent('三段：硬、硬、然后软。前两段都别露馅，第三段才认。（转折点在第 3 段）');
  check('三段意图 → 拆出 3 段', r3.length, 3);
  check('第 1 段意图含"硬"', r3[0].includes('硬'), true);
  check('第 3 段意图含"软"', r3[2].includes('软'), true);
  const r2 = parseRoundIntent('两段：先发一张"生气／无语"的表情，再补一句软话。（图硬话软）');
  check('两段意图 → 拆出 2 段', r2.length, 2);
  check('四段以上 → 封顶到 MAX_SEGMENTS', parseRoundIntent('四段：傲、傲、娇、娇娇', MAX_SEGMENTS).length <= MAX_SEGMENTS, true);
  check('没写段数 → 默认 3 段', parseRoundIntent('随便说点什么').length, 3);

  // 每段注入带上"想说的是"（内容方向；池子 2026-10-01 起只写内容，不写表演形式）
  const segPrompt = composePrompt(now, pState, cfgBack, '想问问 ta 今天在忙什么，怎么一直不理我。', { index: 2, total: 3, intent: '想问问 ta 今天在忙什么' });
  check('注入里带上"想说的是"（内容方向）', segPrompt.includes('想问问 ta 今天在忙什么'), true);
  check('注入里没有"该怎么演"的表演指令（用户原话：什么叫我先服软）', /先服软|该硬|该软|嘴上硬一点|演一|装作/.test(segPrompt), false);
  check('注入了"软化时别换事"的提醒', /别换成别的事|事儿还是这件事|想说的别换/.test(segPrompt), true);
  check('注入里不再写段的位置（末句/第几句）', /最后一句|上一句|就到这里吧|第 \d+\/\d+ 句/.test(segPrompt), false);

  // 同回合的几条必须共用同一套处境（否则自述互相矛盾）
  const situ = composeSituation(now, pState, cfgBack);
  const segA = composePrompt(now, pState, cfgBack, '想问问 ta 今天在忙什么，怎么一直不理我。', { index: 0, total: 2, intent: '想问问 ta 今天在忙什么' }, situ);
  const segB = composePrompt(now, pState, cfgBack, '想问问 ta 今天在忙什么，怎么一直不理我。', { index: 1, total: 2, intent: '想问问 ta 今天在忙什么' }, situ);
  check('同回合两段的处境一致', segA.includes(situ[0]) && segB.includes(situ[0]), true);
  check('首句与末句的措辞不同（不公式）', segA !== segB, true);
  check('段数随机落在 2~4', [2, 3, 4].includes(randomSegCount(now, pState)), true);
  const noSituation = composePrompt(now, pState, cfgBack, '随便');
  check('不传处境时仍能自己算出来', noSituation.includes('，') && noSituation.length > 20, true);
  check('第一块是正文、第二块像自述 → 不剥', trimMetaHead('我在吐泡泡。\n\n我需要数一数戳破几个了。').includes('我在吐泡泡'), true);
  check('没有空行的单块原样返回', trimMetaHead('哦。'), '哦。');
  check('空文本 → 空', trimMetaHead('   '), '');
  check('默认前缀是零宽标记（肉眼看不见）', withPrefix('x', undefined), SELFWAKE_MARK + 'x');
  check('显式传前缀时就用它', withPrefix('x', '（自唤醒）'), '（自唤醒）x');

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
