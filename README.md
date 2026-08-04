# pi-think-panel

Toggleable "think" content panel for the pi coding agent TUI.

## What it does
- Captures the model's thinking and shows the last 5 lines in a bordered panel above the input editor.
- Auto-shows while the model is thinking (when thinking is enabled); when no thinking is happening it either hides (default `hide` mode) or keeps showing the last think text (`last` mode).
- When `hideThinkingBlock` is not enabled in settings, the panel title row reminds you that think text is also visible in chat (press Ctrl+T to hide it there).

## Keys
| Key | Action |
|---|---|
| ctrl+o | Toggle panel open/closed (thinking off → info notice) |
| esc | Close panel (only while the model is idle — never blocks stream abort) |
| x | Close panel (consumed while the panel is open) |

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
- Escape is never consumed while the model is streaming, so during a run the panel cannot be closed with esc — use ctrl+o or x.
- Think content from replayed/loaded sessions is not captured (no events fire on replay).
