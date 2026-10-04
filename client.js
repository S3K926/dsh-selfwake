/**
 * `dsh-selfwake` · Client 半边：做两件事 ——
 *   ① **把排队里的自唤醒消息自动发出去**（等于替用户按"插话发送"）
 *   ② 消息进对话后，**把注入原文收起来**（只留我"自己开口"说的话）
 *
 * 🔴 2026-10-01 为什么需要 ①（这一晚踩透了）：
 *   DSH 对"插件投递的消息"一律先放进**输入框上方的排队区**（预览＋编辑/删除/插话发送三个按钮）；
 *   实测不管宿主侧用 `followup` / `send` / `steer`、来源写 `user` 还是 `selfwake`——**都在排队**。
 *   实测结构：
 *     LI._7yHdaG_row > SPAN._7yHdaG_preview        （消息预览）
 *                     > DIV._7yHdaG_actions > BUTTON[title="插话发送"]
 *   所以「自动发」只能在前端做：**认出带自唤醒前缀的那几行，点它们的"插话发送"**。
 *
 * 🔴 为什么需要 ②：注入原文（"（自己开口）现在 08:39…想说的意思往这上面靠…"）是给模型看的，
 *   给人看很出戏；而模型说的话（我那一侧的气泡）要留着。
 *
 * ⚠ 三条安全约束（被前面两次事故教出来的）：
 *   ① **只认文本前缀**（`（自己开口）` / `（自唤醒`），绝不按 class 一刀切
 *      （`.dsh-recall-bubble` 那类 class 不专属本插件，同页 18 条里 16 条是用户的正常消息）；
 *   ② **只点 title 正好是"插话发送"的按钮**，编辑/删除一律不碰；
 *   ③ 全程 try/catch ＋ 每轮最多发 4 条（防死循环刷屏）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-selfwake',
  factory() {
    return {
      inject: [],
      apply(ctx) {
        try {
          // 注入标记：**零宽空格**（肉眼看不见；2026-10-01 换的，见 index.js 里的说明）。
          // 旧前缀保留做兼容（历史消息还带着「（自己开口）」）。
          const ZW = '\u200B';
          const MARKERS = ['（自己开口）', '（自唤醒'];
          const compact = (s) => String(s || '').replace(/\s+/g, '');
          const isInject = (text) => {
            const raw = String(text || '');
            if (raw.indexOf(ZW) === 0) return true;
            const c = compact(raw);
            return MARKERS.some((m) => c.indexOf(compact(m)) === 0);
          };

          // ① 把排队区里的自唤醒消息发出去
          const flushQueue = () => {
            try {
              let sent = 0;
              const rows = document.querySelectorAll('li[class*="row"]');
              for (let i = 0; i < rows.length && sent < 4; i += 1) {
                const row = rows[i];
                const preview = row.querySelector('[class*="preview"]');
                const text = preview ? preview.textContent : row.textContent;
                if (!isInject(text)) continue;
                const btns = row.querySelectorAll('button');
                for (let k = 0; k < btns.length; k += 1) {
                  // ⚠ 实测：这三个按钮的身份写在 **aria-label** 上（不是 title）——
                  //   "编辑排队消息" / "删除排队消息" / "插话发送"。用 includes 防文案微调。
                  const label = btns[k].getAttribute('aria-label') || btns[k].getAttribute('title') || '';
                  if (label.indexOf('插话发送') >= 0) {
                    btns[k].click();
                    sent += 1;
                    console.info('[selfwake] 自动发送了一条排队中的自唤醒消息');
                    break;
                  }
                }
              }
            } catch (error) {
              /* 单条失败不影响页面 */
            }
          };

          // ② 进对话之后，把注入原文收起来（只认前缀；找不到"只有它"的外层行就只收这一个节点）
          const hideInject = () => {
            try {
              const nodes = document.querySelectorAll('.dsh-recall-bubble, [data-chat-flow-kind="user"]');
              for (let i = 0; i < nodes.length; i += 1) {
                const node = nodes[i];
                if (!isInject(node.textContent)) continue;
                const row = node.closest ? node.closest('.dsh-recall-row') : null;
                if (row) {
                  const inside = row.querySelectorAll('.dsh-recall-bubble');
                  let others = 0;
                  for (let k = 0; k < inside.length; k += 1) if (!isInject(inside[k].textContent)) others += 1;
                  if (others === 0) { row.style.display = 'none'; continue; }
                }
                node.style.display = 'none';
              }
            } catch (error) {
              /* 单条失败不影响页面 */
            }
          };

          // ③ 一次生成（deliverMode: 'once'）时：模型把整个回合**一次写完**，句间用 ⟪分段⟫ 隔开。
          //    这个标记是给插件看的，给人看就是乱码 —— 这里把它**显示成分段**（每段独立一行）。
          //    ⚠ 只改**文本节点**，不动元素结构（React 树动不得，动错就 removeChild 报错／白屏）；
          //      只碰**确实含这个标记**的节点；全程 try/catch；改完打标记，不重复处理。
          const SEG = '⟪分段⟫';
          const splitSegmentsInBubbles = () => {
            try {
              const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
              const hits = [];
              while (walker.nextNode()) {
                const node = walker.currentNode;
                if (node.nodeValue && node.nodeValue.indexOf(SEG) >= 0 && !node.__selfwakeSplit) hits.push(node);
              }
              for (let i = 0; i < hits.length; i += 1) {
                const node = hits[i];
                // ⚠ 代码块／行内代码里的标记是**内容**（比如我们自己在对话里讨论这个标记本身），
                //   不能被吃掉 —— 只处理正文里的那些。
                if (node.parentElement && node.parentElement.closest('code, pre')) continue;
                const parts = String(node.nodeValue).split(SEG).map((s) => s.trim()).filter((s) => s !== '');
                // ⚠⚠ 2026-10-04 修（她报「问题是我能看到」）：
                //   markdown 会把 `⟪分段⟫` **单独渲染成一个段落**（它前后都是换行）→ 那种文本节点
                //   **整个就是标记**，split 完只剩空串（parts.length === 0）。旧写法对这种情况直接
                //   `continue`，标记就永久留在页面上 —— 而且 `__selfwakeSplit` 是在 continue **之前**
                //   置位的，等于这一条再也不会被处理（她自己看到了那个标记，就是这一支漏的）。
                //   → 这种"只剩标记"的节点：清空它，并且把它那个空段落一起藏掉（免得留一条空行）。
                if (parts.length === 0) {
                  node.nodeValue = '';
                  const block = node.parentElement;
                  if (block && block.textContent.trim() === '' && block.style) block.style.display = 'none';
                  node.__selfwakeSplit = true;
                  console.info('[selfwake] 清掉了一处露在页面上的分段标记');
                  continue;
                }
                // 标记在开头／结尾（拆完只剩一段）：把标记吃掉就好。
                if (parts.length === 1) {
                  node.nodeValue = parts[0];
                  node.__selfwakeSplit = true;
                  continue;
                }
                node.__selfwakeSplit = true;
                // 用父节点的 white-space 保住换行：分段之间显示成空一行
                const parent = node.parentNode;
                if (parent && parent.style) parent.style.whiteSpace = 'pre-wrap';
                node.nodeValue = parts.join('\n\n');
                console.info('[selfwake] 把一次生成的回复按段显示了（共 ' + parts.length + ' 段）');
              }
            } catch (error) {
              /* 显示层失败不影响对话本身：最坏只是看到那个标记 */
            }
          };

          // ④ （2026-10-01 用户改主意）：**不藏思考了**。
          //  用户原话：「3 能不能让你的思考接近这种但是不能公式：22:22了，用户还没理我」
          //   —— 要的不是"把思考藏起来"，而是让思考**有角色感**。
          //   而思考的腔调是被"注入文本"带出来的（注入写成任务单 → 思考就是工作腔），
          //   所以这件事归 `index.js` 的 composeSituation / composePrompt 管，这里不动 DOM。

          const run = () => { flushQueue(); hideInject(); splitSegmentsInBubbles(); };
          run();
          const observer = new MutationObserver(run);
          observer.observe(document.body, { childList: true, subtree: true });
          ctx.effect(() => () => observer.disconnect());
          console.info('[selfwake] client 半边已挂上：自动发送排队消息 ＋ 收起注入原文');
        } catch (error) {
          console.info('[selfwake] client 半边挂载失败（不影响页面）：' + String((error && error.message) || error));
        }
      },
    };
  },
});
