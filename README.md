# pi-think-panel

Toggleable "think" content panel for the pi coding agent TUI.

## Why

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

## Layout

Small panel (overlay A) floats top-left while the model is thinking: last 10
lines, auto-following the newest content, chat stays clean:

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

## Keys

| Key | Action |
| --- | --- |
| ctrl+o | Toggle between the small panel and the full-text overlay (thinking off → info notice) |
| ctrl+h | Hide the small panel (stays hidden until the next thinking block starts) |

Note: ctrl+o is normally reserved for the tools panel (app.tools.expand); this extension takes it over — rebind it in your keybindings config if you prefer.

## What it does

- Captures the model's thinking and shows the last 10 lines in a bordered panel above the input editor; ctrl+o opens a wider full-text view (80% width).
- Auto-shows while the model is thinking (when thinking is enabled); when no thinking is happening it either hides (default `hide` mode) or keeps showing the last think text (`last` mode).
- When `hideThinkingBlock` is not enabled in settings, the panel title row reminds you that think text is also visible in chat (press Ctrl+T to hide it there).
- Completed think blocks are separated by a `------` divider in both views.

## Config

At the top of `extensions/pi-think-panel.ts`:

```ts
// "hide" (default): panel hidden when no thinking is happening.
// "last": panel stays visible with the last think text.
const EMPTY_THINK_MODE: "last" | "hide" = "hide";
```

Change it and run `/reload` in pi.

## Install / update

```bash
cp extensions/pi-think-panel.ts ~/.pi/agent/extensions/pi-think-panel.ts
```

Then `/reload` in pi (or restart). Remove by deleting the file and reloading.

## Development

```bash
npx tsc --noEmit   # type-check against pi 0.83.0 types
```

## Known tradeoffs

- ctrl+o taken over from app.tools.expand.
- esc and x are left untouched (normal typing / stream-abort keep working); closing the full-text overlay is another ctrl+o.
- Think content from replayed/loaded sessions is not captured (no events fire on replay).
