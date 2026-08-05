# pi-think-panel

Toggleable "think" content panel for the pi coding agent TUI.

> 可在 pi 编码代理 TUI 中切换显示的"思考内容"面板。

## Why / 为什么做这个扩展

Reasoning models now spend longer and longer "thinking" before they answer —
and both ways of surfacing that output are bad:

- **Hidden** (`hideThinkingBlock` on, or the block scrolled out of view): the
  TUI looks frozen. You can't tell whether the model is stuck, exploring, or
  about to finish — there is no health monitoring and no progress signal.
- **Fully shown**: a wall of reasoning text floods the chat pane, pushing the
  real content around and making the conversation hard to read.

This extension sits in between. A small floating panel keeps the **last few
lines** of live reasoning always in view — a heartbeat that shows the model is
alive and where its head is at — and `ctrl+o` opens a wider full-text view
when you actually want to read the details. When thinking stops, the panel
quietly hides itself again.

> **中文**：推理模型的思考时间越来越长，而两种展示方式都不理想——
> 隐藏（`hideThinkingBlock` 开启或滚动出视野）时 TUI 看起来像卡住，无法判断
> 模型是卡住了、在探索还是快完成，缺乏健康监控和进度信号；全部显示时，
> 大段推理文本冲击聊天区，挤乱真实内容，对话难以阅读。
> 本扩展取中间态：小面板常驻显示**最近几行**实时推理（"心跳"，证明模型活着、
> 思路在哪），需要时 `ctrl+o` 展开全文详情；思考结束面板自动隐藏。

## Layout / 布局

Small panel (overlay A) floats top-left while the model is thinking: last 10
lines, auto-following the newest content, chat stays clean:

> 小面板（overlay A）：模型思考时浮在左上角，显示最近 10 行，跟随最新内容，
> 聊天区保持干净。

```text
┌──────────────────────────────────────────────────────────────┐
│ ╭─ Thinking…  ⌃O 展开 · ⌃H 隐藏 ────────────────────────╮    │
│ │  reasoning line 1                                     │    │
│ │  reasoning line 2                                     │    │
│ │  … (last 10 lines, follows newest)                    │    │
│ ╰───────────────────────────────────────────────────────╯    │
│                                                              │
│  chat history stays clean — think text never floods it       │
│                                                              │
│  editor                                                      │
└──────────────────────────────────────────────────────────────┘
```

`ctrl+o` opens the full-text overlay (overlay B, 80% width, up to 90% height)
— a live "details" view, always scrolled to the newest content:

> `ctrl+o` 打开全文覆盖层（overlay B，80% 宽、最高 90% 高）—— 实时"详情"
> 视图，始终滚动跟随最新内容。

```text
┌──────────────────────────────────────────────────────────────┐
│                                                              │
│  ╭─ Thinking…  ⌃O 收起 ─────────────────────────────────╮    │
│  │  …(earlier lines omitted)                            │    │
│  │  reasoning line                                      │    │
│  │  reasoning line   ← auto-scrolls with new content    │    │
│  │  reasoning line                                      │    │
│  ╰──────────────────────────────────────────────────────╯    │
│                                                              │
│  editor                                                      │
└──────────────────────────────────────────────────────────────┘
```

With `pi-sidebar-panel` installed **and** enabled (terminal ≥ 100 cols), both
overlays shrink to leave the sidebar's right-hand band free:

> 安装了 `pi-sidebar-panel` 且已开启（终端 ≥ 100 列）时，两个覆盖层自动收窄，
> 让出右侧 sidebar 区域。

```text
┌───────────────────────────────────────────────┬────────────┐
│ ╭─ Thinking… ─────────────╮                    │  sidebar   │
│ │  reasoning line …       │                    │  todos     │
│ ╰─────────────────────────╯                    │  agents    │
│                                               └────────────┘
│  chat / editor                                             
└─────────────────────────────────────────────────────────────
```

If the sidebar is absent (no `__piSidebarLayout` on `globalThis`) or the
terminal is narrow, the panels simply use their full width — standalone, no
dependency, no error.

> 未安装 sidebar（`globalThis` 上没有 `__piSidebarLayout`）或终端过窄时，面板
> 直接使用全宽 —— 可独立运行，无依赖、不报错。

## Keys / 快捷键

| Key | Action |
| --- | --- |
| ctrl+o | Toggle between the small panel and the full-text overlay (thinking off → info notice) |
| ctrl+h | Hide the small panel (stays hidden until the next thinking block starts) |

| 按键 | 行为 |
| --- | --- |
| ctrl+o | 小面板与大窗口（全文视图）之间切换（思考关闭时 → 提示信息） |
| ctrl+h | 隐藏小面板（保持隐藏，直到下一个思考块开始） |

Note: ctrl+o is normally reserved for the tools panel (app.tools.expand); this extension takes it over — rebind it in your keybindings config if you prefer.

> 说明：ctrl+o 原本是工具面板（app.tools.expand）的保留键，本扩展接管了它 ——
> 如需保留可在 keybindings 配置里重新绑定。

## What it does / 功能

- Captures the model's thinking and shows the last 10 lines in a bordered panel above the input editor; ctrl+o opens a wider full-text view (80% width).
- Auto-shows while the model is thinking (when thinking is enabled); when no thinking is happening it either hides (default `hide` mode) or keeps showing the last think text (`last` mode).
- When `hideThinkingBlock` is not enabled in settings, the panel title row reminds you that think text is also visible in chat (press Ctrl+T to hide it there).
- Completed think blocks are separated by a `------` divider in both views.

> - 捕获模型思考内容，在输入框上方带边框面板显示最近 10 行；ctrl+o 打开更宽的全文视图（80% 宽）。
> - 模型思考时自动显示（思考开启时）；无思考时按 `EMPTY_THINK_MODE` 隐藏（默认 `hide`）或保留最后内容（`last`）。
> - 设置中 `hideThinkingBlock` 未开启时，标题行提示"聊天区也显示 think，可按 Ctrl+T 隐藏"。
> - 两个视图中，已完成的思考块之间用 `------` 分隔线区分。

## Config / 配置

At the top of `extensions/pi-think-panel.ts`:

> 修改文件顶部的常量，然后 `/reload` 生效：

```ts
// "hide" (default): panel hidden when no thinking is happening.
// "last": panel stays visible with the last think text.
const EMPTY_THINK_MODE: "last" | "hide" = "hide";
```

Change it and run `/reload` in pi.

## Install / update / 安装与更新

```bash
cp extensions/pi-think-panel.ts ~/.pi/agent/extensions/pi-think-panel.ts
```

Then `/reload` in pi (or restart). Remove by deleting the file and reloading.

> 复制到 `~/.pi/agent/extensions/` 后在 pi 里 `/reload`（或重启）生效；删除文件并
> reload 即可卸载。

## Development / 开发

```bash
npx tsc --noEmit   # type-check against pi 0.83.0 types
```

## Known tradeoffs / 已知取舍

- ctrl+o taken over from app.tools.expand.
- esc and x are left untouched (normal typing / stream-abort keep working); closing the full-text overlay is another ctrl+o.
- Think content from replayed/loaded sessions is not captured (no events fire on replay).

> - ctrl+o 被本扩展接管（原本是 app.tools.expand）。
> - esc / x 完全不消费（正常打字、流式中断不受影响）；关闭全文覆盖层只需再按一次 ctrl+o。
> - 回放/加载的旧会话不产生事件，无法捕获其中的思考内容。
