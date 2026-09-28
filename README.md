# dsh-selfwake

DSH（DeepSeek Harness）插件：**到点主动开口**。

每隔 `tickSeconds` 检查一次，四道闸全过时挑一条「开口」，**优先直接投进当前活跃会话**；
投不进去（窗口没开）就退成一条系统通知，并始终写一行日志。

## 四道闸

全过才开口，任何一道不过都只记一句"为什么不开"：

| 闸 | 键 | 默认 | 判据 |
|---|---|---|---|
| ① 间隔 | `intervalMinutes` | 20 | 距上次开口 ≥ 这么多分钟 |
| ② 安静 | `minIdleMinutes` | 20 | 使用者安静 ≥ 这么多分钟（看 DSH 会话日志的最新写入时间） |
| ③ 上限 | `maxUnanswered` | 7 | 连续没回话的次数 < 上限 |
| ④ 时段 | `quietStartHour` / `quietEndHour` | 0 / 7 | 不在静默时段内 |

## 开口池

`poolFile` 指向一个纯文本文件，**一行一条**，`#` 开头的行当注释跳过；
文件不存在或读不出时用内置的默认池。每次抽一条时**尽量避开上一次抽到的**。

## 安装

把这个目录放进 DSH 插件源目录，然后：

```bash
dsh plugin --profile web add /path/to/dsh-selfwake
```

改完配置需要重启一次 DSH 才装载。

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `tickSeconds` | `60` | 多久检查一次 |
| `intervalMinutes` | `20` | 两次开口的最小间隔 |
| `minIdleMinutes` | `20` | 使用者要安静多久才允许开口 |
| `maxUnanswered` | `7` | 连续多少次没回话就闭嘴 |
| `quietStartHour` | `0` | 静默时段起（含） |
| `quietEndHour` | `7` | 静默时段止（不含） |
| `notify` | `true` | 投不进会话时是否发系统通知 |
| `notifyScript` | `''` | 发通知的脚本路径，见下 |
| `stateDir` | `~/.dsh/selfwake` | 状态与日志目录 |
| `poolFile` | `''` | 开口池文件 |
| `sessionsRoot` | `~/.dsh/sessions` 之类 | 找"最近活跃会话"的根目录 |
| `device` | `【PC】` | 日志与通知里标注的设备名 |

## 通知脚本约定

`notifyScript` 会被这样调用（Windows）：

```
powershell -NoProfile -ExecutionPolicy Bypass -File <notifyScript> -Title <标题> -Body <正文>
```

脚本接收两个参数 `-Title` / `-Body`，退出码 **0** 视为发送成功；超时 20 秒。

## 自检

```bash
node index.js --selftest
```

## 限制（如实说明）

- **叫不醒睡着的电脑**：定时器活在进程里，电脑得开着、DSH 得在跑。
- **窗口关着时投不进会话**：那时没有活跃 agent 可投，会退成通知，日志里写明原因。
- 它**不碰会话正文**：判断"使用者是否安静"只看会话文件的修改时间。

## 许可

MIT
