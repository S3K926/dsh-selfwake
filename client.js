/**
 * `dsh-selfwake` · Client 半边：把「（自唤醒…」那条用户消息**收起来**。
 *
 * 为什么需要它：叫醒 agent 只有一条路 —— 投一条 user 消息（`agent.followup`）；
 * 而那条消息在界面上会显示成"使用者自己发的"，看着很怪。
 * 手机版的 `dsha-selfwake` 就是加了客户端半边把它藏掉，这里照做（同一套判据）。
 *
 * 三条自我约束（都是踩出来的）：
 *   ① 入口必须是 `window.__ModuleLoader__.load({id, factory})` 形态 ——
 *      裸 ESM（export/import）会让**整个前端 bundle 语法错、App 进不去**（手机版栽过一次）；
 *   ② 加载与回调全部 try/catch：客户端半边抛错的代价是"那块 UI 白掉"，不是"功能没生效"；
 *   ③ **只藏**「（自唤醒」开头的那些用户消息，别的 DOM 一律不碰。
 */
window.__ModuleLoader__.load({
  id: 'dsh-selfwake',
  factory() {
    return {
      inject: [],
      apply(ctx) {
        try {
          const MARK = '（自唤醒';
          const hide = () => {
            try {
              const nodes = document.querySelectorAll('[data-chat-flow-kind="user"]');
              for (let i = 0; i < nodes.length; i++) {
                const node = nodes[i];
                const text = String(node.textContent || '').replace(/\s+/g, '');
                if (text.indexOf(MARK) === 0) node.style.display = 'none';
              }
            } catch (error) {
              /* 单条失败不影响页面 */
            }
          };
          hide();
          const observer = new MutationObserver(hide);
          observer.observe(document.body, { childList: true, subtree: true });
          ctx.effect(() => () => observer.disconnect());
          console.info('[selfwake] 客户端半边已挂上：会收起「（自唤醒」那条消息');
        } catch (error) {
          console.info('[selfwake] 客户端半边挂载失败（不影响页面）：' + String((error && error.message) || error));
        }
      },
    };
  },
});
