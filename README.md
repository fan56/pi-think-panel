# pi-think-panel

Thinking viewport widget for the pi coding agent TUI — a todo-style widget
above the editor that live-scrolls the model's reasoning.

> pi 编码代理 TUI 的思考视口 widget——像 todo widget 一样挂在输入框上方，
> 实时滚动显示模型推理内容。

## Why / 为什么做这个扩展

Reasoning models now spend longer and longer "thinking" before they answer —
and both ways of surfacing that output are bad:

- **Hidden** (`hideThinkingBlock` on, or the block scrolled out of view): the
  TUI looks frozen. You can't tell whether the model is stuck, exploring, or
  about to finish — there is no health monitoring and no progress signal.
- **Fully shown**: a wall of reasoning text floods the chat pane, pushing the
  real content around and making the conversation hard to read.

This extension sits in between. A one-to-seven-line viewport sits right above
the editor and live-scrolls the **latest** reasoning — a heartbeat that shows
the model is alive and where its head is at — while the chat pane stays clean.

> **中文**：推理模型的思考时间越来越长，而两种展示方式都不理想——
> 隐藏（`hideThinkingBlock` 开启或滚动出视野）时 TUI 看起来像卡住，缺乏健康
> 监控和进度信号；全部显示时，大段推理文本冲击聊天区，对话难以阅读。
> 本扩展取中间态：输入框上方挂一个 1–7 行的滚动视口，始终跟随**最新**推理
> （"心跳"，证明模型活着、思路在哪），聊天区保持干净。

## Layout / 布局

The widget occupies the extension widget slot above the editor (same slot the
todo widget uses). It shows the latest N wrapped lines of thinking; when the
stream grows past N lines it scrolls up, so the newest content is always in
view. No thinking → zero rows, no space taken.

> widget 位于输入框上方的扩展 widget 槽位（与 todo widget 同槽位），显示最近
> N 行思考内容；超过 N 行向上滚动，最新内容始终可见。没有思考时 0 行不占位。

```text
┌──────────────────────────────────────────────────────────┐
│  chat history                                            │
│  …                                                       │
├──────────────────────────────────────────────────────────┤
│  🧠Thinking: 先确认 widget 槽位的宽度约束，再决定 wrap 策略  │   ← widget (N lines,
│  终端宽度变化时按新宽度重排，始终显示窗口尾部最新内容          │      scrolls up)
├──────────────────────────────────────────────────────────┤
│  ❯ editor input                                          │
└──────────────────────────────────────────────────────────┘
```

- Default height is **1 line**: `🧠Thinking: <latest text>` — tail-truncated
  to terminal width.
- Heights **3 / 5 / 7** show more of the latest reasoning; row 0 keeps the
  `🧠Thinking:` prefix, rows below are pure continuation lines.
- Every row is painted with a theme background key (default
  `customMessageBg`) and padded to full width — the viewport reads as one
  solid band, light/dark adaptive.

> 默认 **1 行**：`🧠Thinking: <最新思考>`，超出终端宽度尾部截断。
> **3 / 5 / 7 行**显示更多最新推理；首行保留 `🧠Thinking:` 前缀，其余为纯内容行。

## Command / 命令

```bash
/think-panel           # show current settings / 查看当前配置
/think-panel 3         # switch to 3 lines / 切换 3 行
/think-panel 7         # switch to 7 lines / 切换 7 行
/think-panel off       # disable the widget (0 rows) / 关闭 widget
/think-panel bg toolPendingBg   # switch background theme key / 换底色
```

The settings are persisted to `~/.pi/agent/think-panel.json` as
`{"lines": N, "bg": "customMessageBg"}` and survive restarts.

> 设置持久化到 `~/.pi/agent/think-panel.json`，重启后保持。

## What it does / 功能

- Captures live thinking from `message_update` events and renders it in the
  editor-adjacent widget slot — no overlays, no key grabbing. `ctrl+o`
  (expand tool output) and `ctrl+h` remain pi-native.
- Lines are **visual lines** after ANSI-aware wrapping to the current terminal
  width — the view reflows on resize.
- Shows while the model is thinking; the viewport **auto-hides the moment
  thinking stops** (`thinking_end`) and clears again on turn settle
  (`agent_settled`, safety net) or when thinking is switched off.
- Completed think blocks within a turn are separated by a blank line.

> - 从 `message_update` 事件捕获实时思考，渲染在输入框上方 widget 槽位——
>   无浮层、不抢键。`ctrl+o`（展开工具输出）与 `ctrl+h` 保持 pi 原生行为。
> - 行 = 按当前终端宽度 ANSI 感知换行后的**视觉行**，终端缩放自动重排。
> - 模型思考期间显示；回合结束（`agent_settled`）或思考关闭后清空。
> - 同一回合内多个思考块之间用空行分隔。

## Config / 配置

`~/.pi/agent/think-panel.json`:

```json
{ "lines": 1, "bg": "customMessageBg" }
```

- `lines`: `1 | 3 | 5 | 7 | 0` (`0` = off)
- `bg`: any pi theme bg key — `selectedBg` / `searchMatchBg` /
  `userMessageBg` / `customMessageBg` (default) / `toolPendingBg` /
  `toolSuccessBg` / `toolErrorBg`. Light/dark adaptive.

Prefer the `/think-panel` command — it validates and writes the same file.

> 推荐用 `/think-panel` 命令切换，会校验参数并写同一文件。底色为语义主题键，
> 明暗主题自适应。

## Install / update / 安装与更新

From npm (recommended / 推荐):

```bash
pi install npm:@aiwayds/pi-think-panel
```

Or copy the single file (same loader, no build step / 单文件直载，无构建):

```bash
cp extensions/pi-think-panel.ts ~/.pi/agent/extensions/pi-think-panel.ts
```

Then `/reload` in pi (or restart). Remove by deleting the entry/file and
reloading.

> 在 pi 里 `/reload`（或重启）生效；删除对应包/文件并 reload 即可卸载。

## Development / 开发

```bash
npm run typecheck   # type-check against installed pi types
npm run smoke       # jiti-loads the entry, verifies the factory shape
```

## Known tradeoffs / 已知取舍

- Think content from replayed/loaded sessions is not captured (no events fire
  on replay).
- Hiding the native thinking block in chat is pi's own `hideThinkingBlock`
  setting (recommended companion). This extension never writes user settings.
- The widget only surfaces thinking. Native tool rendering is intentionally
  untouched — pi has no official API to suppress it.

> - 回放/加载的旧会话不产生事件，无法捕获其中的思考内容。
> - 隐藏聊天区原生思考块请配合 pi 自带的 `hideThinkingBlock` 设置（推荐同开）；
>   本扩展绝不改写用户设置。
> - widget 只承载思考内容。原生工具渲染刻意不动——pi 没有官方 API 可以关掉它。
