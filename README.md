# pi-think-panel

Toggleable "think" content panel for the pi coding agent TUI.

## What it does

- Captures the model's thinking and shows the last 10 lines in a bordered panel above the input editor; ctrl+o opens a wider full-text view (80% width).
- Auto-shows while the model is thinking (when thinking is enabled); when no thinking is happening it either hides (default `hide` mode) or keeps showing the last think text (`last` mode).
- When `hideThinkingBlock` is not enabled in settings, the panel title row reminds you that think text is also visible in chat (press Ctrl+T to hide it there).
- Completed think blocks are separated by a `------` divider in both views.

## Keys

| Key | Action |
| --- | --- |
| ctrl+o | Toggle between the small panel and the full-text overlay (thinking off → info notice) |
| h | Hide the small panel (stays hidden until the next thinking block starts) |

Note: ctrl+o is normally reserved for the tools panel (app.tools.expand); this extension takes it over — rebind it in your keybindings config if you prefer.

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
