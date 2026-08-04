---
date: 2026-08-04T15:44:56+0800
author: fliu56
commit: no-commit
branch: main
repository: pi-think-panel
topic: "pi think panel extension"
tags: [plan, pi-extension, tui, think-panel]
status: ready
parent: .rpiv/artifacts/research/2026-08-04_pi-think-panel-extension.md
phase_count: 3
unresolved_phase_count: 0
phases:
  - { n: 1, title: Scaffold + Think Capture, files: [tsconfig.json, node_modules/@earendil-works/pi-coding-agent, node_modules/@earendil-works/pi-tui, node_modules/@types/node, .gitignore, extensions/pi-think-panel.ts], depends_on: [] }
  - { n: 2, title: Panel Rendering, files: [extensions/pi-think-panel.ts], depends_on: [1] }
  - { n: 3, title: Keys + Lifecycle + Deploy, files: [extensions/pi-think-panel.ts, README.md, ~/.pi/agent/extensions/pi-think-panel.ts], depends_on: [2] }
last_updated: 2026-08-04T15:44:56+0800
last_updated_by: fliu56
---

# pi-think-panel Extension Implementation Plan

## Overview

Single-file pi extension (`extensions/pi-think-panel.ts`) that captures the model's think content from `message_update` events and renders a toggleable 5-line bordered panel in the `aboveEditor` widget band. Panel is **open by default** when thinking is enabled, closed when thinking is off. Keys via `ctx.ui.onTerminalInput`: `ctrl+o` toggles, `escape` (only while idle, never during streaming) and `x` close. When the user has not enabled `hideThinkingBlock`, the widget shows a persistent reminder that think text is also visible in chat (Ctrl+T hides it). Extension is deployed by `cp` to `~/.pi/agent/extensions/pi-think-panel.ts`; the git repo at `~/github/pi-think-panel/` is the source of truth.

## Requirements

- Capture full think text from `message_update` events (filtered to `thinking_*` assistant event types); the event carries the complete accumulated `content[i].thinking` text — no delta accumulation needed.
- Render the last 5 lines of think text in a bordered box in the `aboveEditor` widget band (factory form: `{ render(width), invalidate() }`, height = rows returned).
- Panel **open by default** when thinking is enabled (`ctx.thinkingLevel !== "off"`), closed when thinking is off. `ctrl+o` toggles open/close (consumed always — reserved `app.tools.expand`); `escape` closes only while idle (never swallow stream-abort); `x` closes while open (consumed).
- When thinking is off, `ctrl+o` shows an info notify ("thinking is off") instead of opening.
- If `hideThinkingBlock` is not enabled in `~/.pi/agent/settings.json`, the widget shows a persistent reminder row (e.g. "chat shows think — Ctrl+T hides"). **Notify-only, never write user settings.**
- All event handlers guarded with `if (ctx?.mode !== "tui") return;` — extensions load into sub-agent "print" sessions too.
- Module state reset on `session_start`, torn down on `session_shutdown`; widget re-registered on `session_start` (reload wipes extension widgets).
- Think text NOT dumped into the TUI chat area by this extension (chat hiding itself is the user's `hideThinkingBlock`/Ctrl+T decision; we only remind).

## Current State Analysis

Pi 0.83.0 at `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent`. Extension API exposed through `createExtensionAPI` (loader.js:188-309); extension module must `export default function (pi)` (loader.js:318-341, called at 361-373). User's fleet of extensions live in `~/.pi/agent/extensions/` (`pi-powerline-footer` is the fully-typed model; `orca-agent-status.ts` et al. are untyped).

### Key Discoveries

- **Capture**: `message_update` fires per provider stream event with `message: AgentMessage` (growing partial) + `assistantMessageEvent` (types.d.ts:567-571, agent-session.js:460-466). Thinking content lives at `message.content[i].thinking` (`ThinkingContent` — pi-ai types.d.ts:239-245); filter with `event.assistantMessageEvent.type.startsWith("thinking_")` — variants: `thinking_start|thinking_delta|thinking_end` (pi-ai types.d.ts:393-405).
- **Widget**: `ctx.ui.setWidget(key, content, options)` — factory form `(tui: TUI, theme: Theme) => Component & { dispose?() }` (types.d.ts:96-100); component = `{ render(width): string[], invalidate(): void, handleInput? }` (pi-tui tui.d.ts:10-31). Height = rows `render()` returns (factory form uncapped — interactive-mode.js:1501; array form capped at MAX_WIDGET_LINES=10, interactive-mode.js:1546). Rendered in the fixed band between chat and editor (interactive-mode.js:484-493). `setWidget(key, undefined)` removes (interactive-mode.js:1483-1486).
- **Keys**: `registerShortcut` silently skips reserved keys (runner.js:6-24: ctrl+o=app.tools.expand, ctrl+x=app.message.copy, escape=interrupt+select.cancel; single-letter `x` can never register). The zero-config path is `ctx.ui.onTerminalInput(handler)` (types.d.ts:78; interactive-mode.js:1643-1650 → tui.js:443). Handler: `(data: string) => { consume?: boolean; data?: string } | undefined` (types.d.ts:50-53); listeners run before the editor (tui.js:559-570, 613-618); `{ consume: true }` swallows the key globally. Compare keys with `matchesKey(data, keyId)` from `@earendil-works/pi-tui` (barrel export; keys.js:633; escape = `\x1b` legacy or kitty CSI-u).
- **Streaming guard**: swallowing escape during streaming kills the interrupt (interactive-mode.js:2013-2038, custom-editor.js:36-47). Track streaming via `agent_start`/`agent_settled` extension events (types.d.ts:536-547) — module-level flag (fleet pattern), not `ctx.isIdle()`.
- **Thinking level**: `ctx.thinkingLevel` is a live getter in handler contexts (runner.js:493-496; types.d.ts:229-230), not in event payloads. `thinking_level_select` event carries `{ level }` (types.d.ts:609-613; agent-session.js:1287-1292). `"off"` = disabled. User settings: `defaultThinkingLevel: "max"`, `hideThinkingBlock: false`.
- **Settings**: no settings API on ExtensionAPI/ExtensionContext — read `~/.pi/agent/settings.json` directly via fs (settings-manager.js:46-50; keys `hideThinkingBlock` at 581-583, `defaultThinkingLevel` at 493-495). Agent dir = `PI_AGENT_DIR` env override, else `~/.pi/agent`.
- **Lifecycle**: module state survives in-process session switches (jiti cache) → reset in `session_start`, tear down in `session_shutdown` (powerline index.ts:21-29, 319-327; sidebar guards at index.ts:572-581/638-647). `session_start` payload: `{ reason: "startup"|"reload"|"new"|"resume"|"fork" }` (types.d.ts:414-421). `/reload` → session_shutdown{reload} → resetExtensionUI → factory re-runs → session_start{reload}.
- **Notify**: `ctx.ui.notify(message, type?)` (types.d.ts:76; interactive-mode.js:1909-1917). No `pi.notify`.

## Desired End State

- Session starts with thinking on (`max`) → panel visible by default above the editor, showing last 5 think lines in a bordered box; hint row present when `hideThinkingBlock` is false.
- `ctrl+o` toggles panel; `escape` closes (idle only); `x` closes (consumed); keys do nothing when thinking is off except `ctrl+o` → info notify.
- Typing/message flow unaffected: keys consumed only for panel semantics; escape passes through while streaming so interrupt keeps working.
- `/reload`, new sessions, fork/resume all work; sub-agent (print) sessions are completely inert; no crash, no ghost widget.
- `npx tsc --noEmit` passes against the real pi 0.83.0 types.

## What We're NOT Doing

- Not hiding think from the chat transcript — that is `hideThinkingBlock`/Ctrl+T (user setting); the extension only reminds when it is off.
- Not writing any user configuration (settings.json untouched).
- Not capturing think from replay/load (no events fire on replay — impossible via extension API).
- Not accumulating history across turns — `thinkText` holds only the current message's think; truncated at render to last 5 lines.
- Not auto-opening on first thinking event (default open at session start when level ≠ off; ctrl+o still toggles).
- Not unit tests (TUI extension; jiti runtime doesn't type-check) — verification is `tsc --noEmit` + a manual TUI checklist.
- Not using overlay/ghost rows (widget band only — avoids overlay quirks).
- Not rebinding `ctrl+o`'s lost `app.tools.expand` — accepted tradeoff (user can rebind in their keybindings config).

## Decisions

### D1: Think capture via `message_update` + `thinking_*` filter
The event carries the complete accumulated thinking text on every thinking event (`message.content[i].thinking` shared reference to the live partial). `extractThinking` reads all `thinking`-typed content parts and joins with `\n`; guard on `assistantMessageEvent.type.startsWith("thinking_")` to repaint only on think events. Evidence: pi-ai types.d.ts:239-245, 375-406; agent-session.js:460-466.

### D2: Widget via `setWidget` factory form, `aboveEditor` placement
Factory `(tui, theme) => Component` — `render(width)` returns the full bordered box (rows = height); `invalidate()` → `tui.requestRender()`. Captures the `tui` ref for repaint from message_update. Evidence: types.d.ts:96-100; interactive-mode.js:1473-1506; custom-footer.ts:24-30; plan-mode/index.ts:80.

### D3: Keys via `onTerminalInput` + `matchesKey` (all three keys are reserved)
`registerShortcut` silently ignores reserved keys. `onTerminalInput` runs before the editor and can `consume`. Semantics (user-confirmed): ctrl+o always consumed (toggle; notify when thinking off); `x` consumed when panel open (close); `escape` consumed only when panel open AND not streaming (never block stream-abort). Evidence: runner.js:6-24; types.d.ts:50-53; tui.js:559-570, 613-618; custom-editor.js:36-47; interactive-mode.js:2013-2038.

### D4: Default-open panel (user decision, overrides earlier "manual open")
`session_start`: `thinkingEnabled = ctx.thinkingLevel !== "off"`; `panelOpen = thinkingEnabled`. `thinking_level_select` re-syncs: off → close; on → reopen. `ctrl+o` still toggles. Evidence: runner.js:493-496; types.d.ts:609-613.

### D5: hideThinkingBlock reminder in-widget (user decision, replaces one-shot toast)
`readHideThinkingBlock()` reads `~/.pi/agent/settings.json` (PI_AGENT_DIR override) once per session; when `hideThinkingBlock` is false and thinking is on, the widget's title row appends a dim hint (e.g. `[chat shows think — Ctrl+T hides]`, truncated to width). No toast, no settings writes. Evidence: settings-manager.js:46-50, 581-583.

### D6: Lifecycle discipline — module state + full teardown/rebuild
Reset module state and re-register the widget + input listener on `session_start` (unsubscribing the previous listener first); on `session_shutdown` unsubscribe input listener and `setWidget(key, undefined)`. Every handler guarded `if (ctx?.mode !== "tui") return;`. Evidence: powerline index.ts:21-29, 319-327; sidebar index.ts:572-581, 638-647.

### D7: Type/import surface
Types from `@earendil-works/pi-coding-agent` (barrel `dist/index.d.ts`), runtime helpers `matchesKey`/`truncateToWidth` from `@earendil-works/pi-tui` (barrel). Node built-ins via `@types/node` (symlinked from `~/.pi/agent/node_modules`). Strict TS via repo-local `tsconfig.json` + node_modules symlinks (global npm install has no @types/node). Evidence: powerline index.ts:8-18; pi-tui dist/index.d.ts.

### D8: Empty-think state configurable via file-top constant (user decision)

When no thinking is happening, two modes (user-specified; default = hide): `EMPTY_THINK_MODE: "last" | "hide" = "hide"` at file top — `"hide"` hides the widget until the next thinking turn starts; `"last"` keeps it visible with the last think text. Change the constant + `/reload` applies. Never writes user settings (user-confirmed location). During active thinking the panel auto-shows (D4 default-open); `ctrl+o` manual toggle always works. Auto-show on `thinking_start`; empty-think handling on `agent_settled` (hide mode + not manually opened).

## Phase 1: Scaffold + Think Capture

### Overview

Repo scaffolding (tsconfig, node_modules symlinks, .gitignore) plus the extension's foundation: imports, module state, think extraction/settings helpers, factory skeleton, and the capture/sync handlers (`agent_start`, `agent_settled`, `thinking_level_select`, `message_update`). Delivers a complete, type-checkable file. Depends on nothing (foundation).

### Changes Required:

#### 1. tsconfig.json

**File**: tsconfig.json
**Changes**: NEW — strict noEmit TS config for type-checking the extension against real pi 0.83.0 types

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "esnext",
    "moduleResolution": "bundler",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "lib": ["ES2022"],
    "noUnusedLocals": false,
    "noUnusedParameters": false
  },
  "include": ["extensions/**/*.ts"]
}
```

#### 2. node_modules/@earendil-works/pi-coding-agent

**File**: node_modules/@earendil-works/pi-coding-agent
**Changes**: NEW — symlink to /opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent (type resolution for tsc)

```bash
mkdir -p node_modules/@earendil-works
ln -sfn /opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent node_modules/@earendil-works/pi-coding-agent
```

#### 3. node_modules/@earendil-works/pi-tui

**File**: node_modules/@earendil-works/pi-tui
**Changes**: NEW — symlink to the pi-tui nested under pi-coding-agent's node_modules

```bash
ln -sfn /opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui node_modules/@earendil-works/pi-tui
```

#### 4. node_modules/@types/node

**File**: node_modules/@types/node
**Changes**: NEW — symlink to ~/.pi/agent/node_modules/@types/node (node built-in types)

```bash
ln -sfn ~/.pi/agent/node_modules/@types/node node_modules/@types/node
```

#### 5. .gitignore

**File**: .gitignore
**Changes**: NEW — ignore node_modules/ (symlinks are machine-specific)

```gitignore
node_modules/
```

#### 6. extensions/pi-think-panel.ts

**File**: extensions/pi-think-panel.ts
**Changes**: NEW — extension foundation: imports, module state, extractThinking, readHideThinkingBlock, factory skeleton with capture + level + streaming handlers

```ts
/**
 * pi-think-panel — toggleable "think" content panel above the editor.
 *
 * Captures the model's thinking from message_update events and renders the
 * last MAX_LINES lines in a bordered box via ctx.ui.setWidget({placement:"aboveEditor"}).
 * Keys (ctx.ui.onTerminalInput — ctrl+o / escape / x are reserved keys):
 *   ctrl+o  toggle open/close (thinking off → info notify)
 *   x       close (consumed)
 *   escape  close while idle only (never blocks stream-abort)
 * Panel is open by default while thinking is enabled. If hideThinkingBlock is
 * not enabled in settings, the widget shows a reminder that think text is also
 * visible in chat (Ctrl+T hides it). Never writes user settings.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const WIDGET_KEY = "think-panel";
const MAX_LINES = 5;

// Module-level state — survives in-process session switches (jiti cache).
let panelOpen = false;
let streaming = false;
let thinkingEnabled = false;
let hideThinkingBlock = false;
let thinkText = "";
let tui: TUI | undefined;
let inputUnsub: (() => void) | null = null;

/** Extract the complete accumulated thinking text from an assistant message. */
function extractThinking(message: { content?: unknown }): string {
  const parts = (message.content ?? []) as Array<{ type?: string; thinking?: string }>;
  return parts
    .filter((c) => c.type === "thinking")
    .map((c) => c.thinking ?? "")
    .join("\n");
}

/** Read hideThinkingBlock from ~/.pi/agent/settings.json (never write). */
function readHideThinkingBlock(): boolean {
  try {
    const agentDir = process.env.PI_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
    const raw = JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8")) as {
      hideThinkingBlock?: boolean;
    };
    return raw.hideThinkingBlock ?? false;
  } catch {
    return false;
  }
}

export default function (pi: ExtensionAPI): void {
  // Streaming flag — guards escape consumption (never block stream-abort).
  pi.on("agent_start", (_event, ctx) => {
    if (ctx?.mode !== "tui") return;
    streaming = true;
  });
  pi.on("agent_settled", (_event, ctx) => {
    if (ctx?.mode !== "tui") return;
    streaming = false;
  });

  // Keep thinking-enabled in sync with every level change (top-level subscription).
  pi.on("thinking_level_select", (event, ctx) => {
    if (ctx?.mode !== "tui") return;
    thinkingEnabled = event.level !== "off";
    if (!thinkingEnabled) {
      panelOpen = false;
    } else if (!panelOpen) {
      panelOpen = true; // default open
    }
    tui?.requestRender();
  });

  // Capture: message_update always carries the COMPLETE thinking text.
  pi.on("message_update", (event, ctx) => {
    if (ctx?.mode !== "tui") return;
    if (!event.assistantMessageEvent.type.startsWith("thinking_")) return;
    thinkText = extractThinking(event.message);
    if (panelOpen) tui?.requestRender();
  });
}
```

### Success Criteria:

#### Automated Verification:
- [ ] Type checking passes: `npx tsc --noEmit` (exit 0, from repo root)
- [ ] Symlinks resolve: `test -L node_modules/@earendil-works/pi-coding-agent && test -L node_modules/@earendil-works/pi-tui && test -L node_modules/@types/node`
- [ ] thinking_ filter present: `grep -c 'startsWith("thinking_")' extensions/pi-think-panel.ts` returns 1
- [ ] Mode guards on all 4 handlers: `grep -c 'mode !== "tui"' extensions/pi-think-panel.ts` returns 4

#### Manual Verification:
- [ ] Phase 1 is foundation-only — no user-visible behavior yet; verify `extensions/pi-think-panel.ts` exists with imports, module state, and 4 guarded handlers

## Phase 2: Panel Rendering

### Overview

The `mountPanel` widget: `setWidget` factory form drawing a bordered box with title row (incl. hideThinkingBlock hint), the last 5 think lines (truncated/padded to width), and a "(no thinking yet)" placeholder. Captures the `tui` ref for repaints. Adds the `EMPTY_THINK_MODE` file-top constant (D8), `thinkingActive` state tracked from `thinking_start`/`thinking_end`, and the `truncateToWidth` import. Visibility transitions (auto-open/hide, toggle keys, lifecycle) are Phase 3's territory — this phase only tracks state and renders. Depends on Phase 1.

### Changes Required:

#### 1. extensions/pi-think-panel.ts

**File**: extensions/pi-think-panel.ts
**Changes**: MODIFY — add truncateToWidth import, EMPTY_THINK_MODE constant (D8), thinkingActive state, replace message_update handler (thinkingActive tracking), add mountPanel() widget factory

```ts
--- Change 1: add import to the existing import block ---
import { truncateToWidth } from "@earendil-works/pi-tui";

--- Change 2: add constant after MAX_LINES ---
// What to do when no thinking is happening: "last" keeps the widget visible
// with the last think text; "hide" (default) hides the widget until the next
// thinking turn starts. Change this and /reload to apply.
const EMPTY_THINK_MODE: "last" | "hide" = "hide";

--- Change 3: add state declaration to the module-state block ---
let thinkingActive = false;

--- Change 4: replace the message_update handler body (Phase 1 version) ---
  pi.on("message_update", (event, ctx) => {
    if (ctx?.mode !== "tui") return;
    const t = event.assistantMessageEvent.type;
    if (!t.startsWith("thinking_")) return;
    if (t === "thinking_start") thinkingActive = true;
    else if (t === "thinking_end") thinkingActive = false;
    thinkText = extractThinking(event.message);
    if (panelOpen) tui?.requestRender();
  });

--- Change 5: add mountPanel inside the default export, after the message_update handler ---
  // Widget factory: called ONCE per setWidget with (tui, theme).
  // Component = { render(width): string[], invalidate(), dispose? } — height = rows returned.
  function mountPanel(ctx: ExtensionContext): void {
    ctx.ui.setWidget(WIDGET_KEY, (t, theme) => {
      tui = t;
      return {
        dispose() {},
        invalidate() {
          t.requestRender();
        },
        render(width: number): string[] {
          const innerW = Math.max(1, width - 2);
          const border = (c: string) => theme.fg("border", c);
          const pad = (s: string) => truncateToWidth(s, innerW, "...", true);
          const rows: string[] = [];
          rows.push(border("┌" + "─".repeat(innerW) + "┐"));
          const title = theme.fg("accent", " Think");
          const hint = hideThinkingBlock ? "" : theme.fg("dim", "  chat shows think · Ctrl+T hides");
          rows.push(border("│") + truncateToWidth(title + hint, innerW, "...", true) + border("│"));
          rows.push(border("├" + "─".repeat(innerW) + "┤"));
          const lines = thinkText ? thinkText.split(/\r?\n/).slice(-MAX_LINES) : [];
          if (lines.length === 0) {
            rows.push(border("│") + pad(theme.fg("dim", " (no thinking yet)")) + border("│"));
          } else {
            for (const l of lines) rows.push(border("│") + pad(l) + border("│"));
          }
          rows.push(border("└" + "─".repeat(innerW) + "┘"));
          return rows;
        },
      };
    });
  }
```

### Success Criteria:

#### Automated Verification:
- [ ] Type checking passes: `npx tsc --noEmit` (exit 0, from repo root)
- [ ] Widget factory present: `grep -c 'setWidget(WIDGET_KEY' extensions/pi-think-panel.ts` returns 1
- [ ] EMPTY_THINK_MODE constant present: `grep -c 'EMPTY_THINK_MODE: "last" | "hide" = "hide"' extensions/pi-think-panel.ts` returns 1
- [ ] thinkingActive tracked: `grep -c 't === "thinking_start"' extensions/pi-think-panel.ts` returns 1
- [ ] Placeholder reachable: `grep -c 'thinkText ? thinkText.split' extensions/pi-think-panel.ts` returns 1

#### Manual Verification:
- [ ] Phase 2 is render-only — no user-visible behavior yet; verify `mountPanel` exists but is not yet called (Phase 3 wires it)

## Phase 3: Keys + Lifecycle + Deploy

### Overview

Wire `session_start` (module-state reset, hideThinkingBlock/settings read, input-listener registration with the ctrl+o / esc / x handler, last-mode mount) and `session_shutdown` (input unsubscribe + widget removal); extend `agent_settled` (empty-think-mode hide), `thinking_level_select` (off → close+unmount+reset manuallyOpened; on → last-mode mount) and `message_update` (thinking_start auto-show); write README; deploy the install copy to `~/.pi/agent/extensions/pi-think-panel.ts`. Depends on Phase 2.

### Changes Required:

#### 1. extensions/pi-think-panel.ts

**File**: extensions/pi-think-panel.ts
**Changes**: MODIFY — matchesKey import, manuallyOpened state, replace agent_start/agent_settled + thinking_level_select + message_update handlers, add session_start/session_shutdown handlers

```ts
--- Change 1: modify the pi-tui import line (Phase 2 added it) ---
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

--- Change 2: add state to module-state block ---
let manuallyOpened = false;

--- Change 3: replace the agent_start/agent_settled handlers (Phase 1 versions) ---
  pi.on("agent_start", (_event, ctx) => {
    if (ctx?.mode !== "tui") return;
    streaming = true;
  });
  pi.on("agent_settled", (_event, ctx) => {
    if (ctx?.mode !== "tui") return;
    streaming = false;
    thinkingActive = false;
    // Empty-think mode: hide the panel once the turn is fully done.
    if (EMPTY_THINK_MODE === "hide" && !manuallyOpened) {
      panelOpen = false;
      ctx.ui.setWidget(WIDGET_KEY, undefined);
    }
  });

--- Change 4: replace the thinking_level_select handler (Phase 1 version) ---
  pi.on("thinking_level_select", (event, ctx) => {
    if (ctx?.mode !== "tui") return;
    thinkingEnabled = event.level !== "off";
    if (!thinkingEnabled) {
      panelOpen = false;
      manuallyOpened = false;
      ctx.ui.setWidget(WIDGET_KEY, undefined);
    } else if (!panelOpen && EMPTY_THINK_MODE === "last") {
      panelOpen = true;
      mountPanel(ctx);
    }
    tui?.requestRender();
  });

--- Change 5: replace the message_update handler (Phase 2 version) ---
  pi.on("message_update", (event, ctx) => {
    if (ctx?.mode !== "tui") return;
    const t = event.assistantMessageEvent.type;
    if (!t.startsWith("thinking_")) return;
    if (t === "thinking_start") {
      thinkingActive = true;
      // Auto-show while thinking (default-open).
      if (thinkingEnabled && !panelOpen) {
        panelOpen = true;
        mountPanel(ctx);
      }
    } else if (t === "thinking_end") {
      thinkingActive = false;
    }
    thinkText = extractThinking(event.message);
    if (panelOpen) tui?.requestRender();
  });

--- Change 6: add session_start handler inside the default export ---
  pi.on("session_start", (_event, ctx) => {
    if (ctx?.mode !== "tui") return;

    // Reset module state that survived the previous in-process session.
    panelOpen = false;
    streaming = false;
    thinkingActive = false;
    manuallyOpened = false;
    thinkText = "";
    hideThinkingBlock = readHideThinkingBlock();
    thinkingEnabled = (ctx.thinkingLevel ?? "off") !== "off";

    // (Re)register the key listener; tear down the previous session's one.
    if (inputUnsub) {
      inputUnsub();
      inputUnsub = null;
    }
    inputUnsub = ctx.ui.onTerminalInput((data) => {
      if (matchesKey(data, "ctrl+o")) {
        if (!thinkingEnabled) {
          ctx.ui.notify("Think panel: thinking is off", "info");
          return { consume: true };
        }
        panelOpen = !panelOpen;
        manuallyOpened = panelOpen;
        if (panelOpen) mountPanel(ctx);
        else ctx.ui.setWidget(WIDGET_KEY, undefined);
        return { consume: true };
      }
      if (panelOpen && (matchesKey(data, "x") || (matchesKey(data, "escape") && !streaming))) {
        panelOpen = false;
        manuallyOpened = false;
        ctx.ui.setWidget(WIDGET_KEY, undefined);
        return { consume: true };
      }
      return undefined;
    });

    // Default open: with "last" mode show the panel from session start.
    if (thinkingEnabled && EMPTY_THINK_MODE === "last") {
      panelOpen = true;
      mountPanel(ctx);
    }
  });

--- Change 7: add session_shutdown handler ---
  pi.on("session_shutdown", (_event, ctx) => {
    if (ctx?.mode !== "tui") return;
    if (inputUnsub) {
      inputUnsub();
      inputUnsub = null;
    }
    ctx.ui.setWidget(WIDGET_KEY, undefined);
    panelOpen = false;
  });
```

#### 2. README.md

**File**: README.md
**Changes**: NEW — usage, keys, install/deploy instructions, known tradeoffs (ctrl+o reserved, esc passthrough while streaming)

```markdown
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
```

#### 3. ~/.pi/agent/extensions/pi-think-panel.ts

**File**: ~/.pi/agent/extensions/pi-think-panel.ts
**Changes**: NEW — deployed copy (cp from repo extensions/pi-think-panel.ts)

```bash
cp extensions/pi-think-panel.ts ~/.pi/agent/extensions/pi-think-panel.ts
```

### Success Criteria:

#### Automated Verification:
- [ ] Type checking passes: `npx tsc --noEmit` (exit 0, from repo root)
- [ ] All 6 handlers mode-guarded: `grep -c 'mode !== "tui"' extensions/pi-think-panel.ts` returns 6
- [ ] Key handling present: `grep -o 'matchesKey(data' extensions/pi-think-panel.ts | wc -l` returns 3
- [ ] Lifecycle wired: `grep -cE 'pi\.on\("session_(start|shutdown)"' extensions/pi-think-panel.ts` returns 2
- [ ] Deploy copy matches source: `diff -q extensions/pi-think-panel.ts ~/.pi/agent/extensions/pi-think-panel.ts && echo OK`

#### Manual Verification:
- [ ] `/reload` in pi loads the extension without errors; no ghost widget after reload
- [ ] Thinking on (max): panel auto-shows while the model thinks; last 5 lines visible; hides when the turn settles (default hide mode)
- [ ] ctrl+o toggles the panel; x closes it; esc closes it while idle
- [ ] Escape during streaming does not close the panel and the run still aborts
- [ ] Thinking off: panel not shown; ctrl+o → "thinking is off" notice
- [ ] hideThinkingBlock=false → hint row in panel; Ctrl+T hides chat think; after /reload the hint row is gone
- [ ] Sub-agent task runs without errors (print sessions inert)
- [ ] Narrow terminal: panel renders without errors; wide terminal: hint + text not cut mid-glyph

## Ordering Constraints

- Phase 1 → Phase 2 → Phase 3 (sequential; each phase's code fence is applied on top of the previous phase's file state).
- All three phases touch `extensions/pi-think-panel.ts` — the file must remain complete and type-correct after each phase (each phase's addition is self-contained; `tsc --noEmit` must pass after every phase).
- Deploy (Phase 3) must run after the file is complete — pi loads the install copy, so a broken mid-plan copy must never be deployed.
- The node_modules symlinks (Phase 1) are prerequisites for every `tsc` verification in all phases.

## Verification Notes

- **Type check**: `npx tsc --noEmit` from repo root (strict) must pass after every phase. Read-only; safe for any phase.
- **Resolution**: pi-coding-agent/pi-tui/@types/node resolved via node_modules symlinks created in Phase 1; `skipLibCheck: true` keeps pi's own .d.ts from failing the build.
- **Runtime load check (Phase 3 only)**: pi (jiti) loads `~/.pi/agent/extensions/pi-think-panel.ts` — resolution of `@earendil-works/pi-tui` happens against `~/.pi/agent/node_modules` (verified present: pi-ai, pi-coding-agent, pi-tui). A quick `node -e "import('...')"` smoke check on the installed copy is not sufficient (needs the full pi runtime) — manual TUI verification is authoritative.
- **Stream-abort safety**: escape must never be consumed while streaming (custom-editor.js:36-47, interactive-mode.js:2013-2038). Manual check: send a long prompt, press escape mid-stream → the run interrupts (panel stays open).
- **Sub-agent sessions**: print-mode sessions fire session_start too — without the `ctx.mode !== "tui"` guard the extension would crash sub-agent runs (sidebar lesson, 4 fix commits). Manual check: run a task that spawns a sub-agent; nothing breaks.
- **Ghost widget**: `setWidget(key, undefined)` on shutdown + re-mount on start (resetExtensionUI wipes widgets on reload). Manual check: `/reload` — panel works again after reload, no stale rows.
- **hideThinkingBlock reminder**: hint row only when settings.json `hideThinkingBlock` is false/absent; after Ctrl+T (or editing settings + /reload) hint disappears.
- **Wide/narrow width**: render must not throw at any terminal width; `truncateToWidth(..., pad: true)` pads to exact inner width.

## Performance Considerations

- `thinkText` holds only the current message's think text (overwritten per thinking event); no cross-turn accumulation. Memory bounded by a single thinking block.
- Render cost: 5 lines sliced + padded per repaint; repaints only on `thinking_*` events or key toggles — no per-keystroke repaint loop.
- `readHideThinkingBlock()` is called once per session (cached in module state), never per render.

## Migration Notes

Not applicable — new standalone extension repo; no existing data, schema, or config migration. Deployment is additive (a new file in `~/.pi/agent/extensions/`); removal = delete the file + `/reload`.

## Pattern References

- `~/.pi/agent/extensions/pi-powerline-footer/index.ts:8-29` — typed imports + module state pattern
- `~/.pi/agent/extensions/pi-powerline-footer/index.ts:319-327` — session_shutdown teardown (setWidget undefined, unsub)
- `~/github/pi-sidebar-panel/extensions/index.ts:572-581,638-647` — ctx.mode guards + state reset
- `examples/extensions/custom-footer.ts:24-30` — component triple `{ dispose, invalidate, render }`
- `examples/extensions/plan-mode/index.ts:76-84` — setWidget rebuild on session_start
- `examples/extensions/widget-placement.ts:5-8` — setWidget registration with placement
- `examples/extensions/hello.ts:14-16` — minimal factory shape

## Developer Context

**Q (panel default state)**: "think 开启时，默认是关闭需手动 ctrl+o 打开，还是 think 一开始就自动弹出？" — A: 手动开启 (Recommended) 被选择。**后经用户在设计确认时修正为「默认开启」**（覆盖）：think 开启时面板默认打开；ctrl+o 仍可切换。记录为 D4。

**Q ('x' key semantics)**: "面板开启时按 x 退出——这个 x 要不要同时吞掉？" — A: 吞掉 x（面板开时按 x 关闭且不输入）。记录为 D3。

**Q (design confirm)**: 用户自定义回答："独立目录, 放在 ~/github 下面, 默认开启. 如果用户没关闭 默认配置 hidethink 就默认在 widge 提醒." — 确认独立仓库 ~/github/pi-think-panel；面板默认开启（D4）；hideThinkingBlock 未开启时在 widget 内常驻提醒（D5，替代一次性 toast）。

**Q (empty-think modes, Slice 2)**: "没有 think 的时候,有 2 种状态可以配置,默认 2. 1)显示widget,和最后的 think 2) 隐藏 widget" — A: 新增 D8：EMPTY_THINK_MODE 常量默认 "hide"；think 流式中自动显示（D4 默认开启）；ctrl+o 手动开关；think 关闭时不显示。

**Q (config location, Slice 2)**: 无 think 模式配置放哪里？ — A: 文件顶部常量（改后 /reload 生效，README 说明；不写用户 settings.json）。

**Slice-verifier catches (audit trail)**: P2 — placeholder dead code (`"".split(/\r?\n/)` always length ≥ 1 → `thinkText ? ... : []` fix); P3 — stale `manuallyOpened` after thinking-off cycle (level-select off-branch now resets it), otherwise D8 hide semantics broken after ctrl+o → off → on → settle.

Step 8 code review unavailable; proceeded to developer review without artifact-code-reviewer findings (429 rate limit).

**Q (slices)**: 3 切片分解确认 — Approve。

## Plan Review (Step 8)

_Independent post-finalization review by artifact-code-reviewer and artifact-coverage-reviewer subagents. Findings triaged at Step 9._

_Step 8 code review failed: 429 provider rate limit (5h usage cap, resets 2026-08-04 20:59:51) — proceeded without artifact-code-reviewer findings; rpiv Stage 7 (post-implementation code review) covers the same audit ground._

| source   | plan-loc          | codebase-loc                | severity   | dimension             | finding   | recommendation   | resolution         |
| -------- | ----------------- | --------------------------- | ---------- | --------------------- | --------- | ---------------- | ------------------ |
| coverage | (all)             | <n/a>                       | —          | verification-coverage | No findings — every Verification Notes §1-8, Decision D1-D8, and Developer Context intent lands in a Success Criteria bullet or visible code mirror; all Automated commands read-only (write-scope rule satisfied; the only write is the Phase 3 cp deploy target). | <n/a> | n/a |

## Plan History

- Phase 1: Scaffold + Think Capture — approved as generated
- Phase 2: Panel Rendering — approved as generated (revised: D8 empty-think mode added per developer)
- Phase 3: Keys + Lifecycle + Deploy — approved as generated (revised: manuallyOpened reset on thinking-off per slice-verifier)
- Post-implementation review fixes (code review, 0 blockers): removed dead `thinkingActive` state; `tui = undefined` on session_start/shutdown; `Array.isArray` guard in extractThinking. D8 prose updated accordingly (code is source of truth).

## References

- Research: `.rpiv/artifacts/research/2026-08-04_pi-think-panel-extension.md`
- Pi docs: `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`, `docs/tui.md`, `docs/keybindings.md`
- Examples: `examples/extensions/{custom-footer,plan-mode,widget-placement,hello,subagent,hidden-thinking-label}.ts`
- Sidebar precedent: `~/github/pi-sidebar-panel/extensions/index.ts`
