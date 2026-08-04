---
date: 2026-08-04T15:38:02+0800
author: fliu56
commit: no-commit
branch: main
repository: pi-think-panel
topic: "pi extension: toggleable ~5-line think-content panel, keep think text out of main TUI"
tags: [research, pi-extension, tui, thinking, keybindings]
status: ready
last_updated: 2026-08-04T15:38:02+0800
last_updated_by: fliu56
---

# Research: pi extension — think-content panel (Ctrl+O open, Esc/X close, 5 lines, no chat pollution)

## Research Question

Build a pi extension that captures the model's "think" (extended thinking) content and shows it in a small text box / panel in the TUI showing only the last ~5 lines. Think content must NOT be dumped into the main TUI chat area. The panel is toggleable: Ctrl+O opens it, Esc or X closes it. The panel only makes sense / is visible when thinking is enabled. Target: pi v0.83.0, user runs thinking at `defaultThinkingLevel: "max"`.

## Summary

- **Think capture**: subscribe `pi.on("message_update", ...)` and read `event.message.content` — it already contains the COMPLETE accumulated thinking text in `{ type: "thinking", thinking }` parts on every update. No delta accumulation needed. Filter on `event.assistantMessageEvent.type.startsWith("thinking_")` to only repaint on thinking deltas. Extensions receive NO events on session replay/resume.
- **Chat suppression**: the only supported switch is the `hideThinkingBlock` setting (render decision at `assistant-message.js:100-106`); the extension API cannot flip it — `ctx.ui` has only `setHiddenThinkingLabel` (label text, not visibility). **User decision: extension never writes settings; it notifies the user to press Ctrl+T or set `hideThinkingBlock: true` in `~/.pi/agent/settings.json` (currently `false`).**
- **Rendering surface**: `ctx.ui.setWidget(key, factory, { placement: "aboveEditor" })` — factory-function form renders a persistent bordered box in the fixed band directly above the editor (below chat). Matches the user's "above the chat box" mental model (the subagent example is actually a scroll-away transcript tool block, not a panel — see Findings 3). Widget never steals focus; toggle = `setWidget(key, undefined)` to hide / re-`setWidget` to show; re-set on every `session_start` (reload wipes widgets).
- **Keys**: `ctrl+o` (app.tools.expand), `ctrl+x` (app.message.copy), `escape` (app.interrupt + tui.select.cancel) are in `RESERVED_KEYBINDINGS_FOR_EXTENSION_CONFLICTS` (`runner.js:6-24`) — `pi.registerShortcut` on them is silently skipped, and plain `x` can never be a registered shortcut (would swallow typing). Only `ctx.ui.onTerminalInput(handler)` (`interactive-mode.js:1643`) intercepts keys before the editor (`tui.js:557-570`) with zero config. Handler receives raw key string; use `matchesKey(data, "escape"|"ctrl+o"|"x")`. Consuming escape breaks stream-abort while streaming → guard with a module-level streaming flag.
- **Thinking-enabled detection**: `ctx.thinkingLevel` is a live getter in event-handler contexts (resolves to `agent.state.thinkingLevel`); `pi.on("thinking_level_select", ...)` fires on every level change (`agent-session.js:1287-1292`). Level `"off"` = disabled. `session_start` events do NOT carry the level — read `ctx.thinkingLevel` in the handler.
- **Lifecycle**: auto-discovered `~/.pi/agent/extensions/*.ts` (or `*/index.ts`); factory re-runs on every session incl. sub-agent "print" sessions → guard ALL handlers with `ctx.mode !== "tui"`. `session_start` resets module state + (re)creates widget; `session_shutdown` tears down. `/reload` = `session_shutdown {reason:"reload"}` → `resetExtensionUI()` (hides overlays, wipes widgets) → factory re-runs.
- **Deliverable layout**: git repo `~/github/pi-think-panel/` (this artifact tree), installed copy at `~/.pi/agent/extensions/pi-think-panel.ts` (cp after edits — sidebar lesson: pi loads the installed copy, not git source).

## Detailed Findings

### 1. Think content flow: `message_update` carries complete thinking text

- Every provider stream event (text/thinking/toolcall deltas) is forwarded to extensions as `MessageUpdateEvent` (`dist/core/extensions/types.d.ts:567-571`: `{ type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }`) from `dist/core/agent-session.js:460-466` (`_emitExtensionEvent`).
- `event.message` is `{ ...partialMessage }` — a shallow copy; `content` array and block objects are SHARED references with the agent-core's live partial and the provider's output (`node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js:205-232`). So `event.message.content[i].thinking` is the running total — reading it each update yields complete thinking-so-far.
- Thinking part shape (`node_modules/@earendil-works/pi-ai/dist/types.d.ts:239-245`): `ThinkingContent = { type: "thinking"; thinking: string; thinkingSignature?: string; redacted?: boolean }`. `AssistantMessage.content` = `(TextContent | ThinkingContent | ToolCall)[]`.
- No dedicated thinking event in the extension `ExtensionEvent` union (`types.d.ts:773`); branch on `event.assistantMessageEvent.type.startsWith("thinking_")` (AssistantMessageEvent variants at pi-ai `types.d.ts:375-405`).
- Persistence: thinking parts ARE stored in session `.jsonl` entries (verified in user session files) and replayed into `AssistantMessageComponent` on resume — but extensions get no events on replay (`renderInitialMessages`/`rebuildChatFromMessages` at `interactive-mode.js:2850-2854` render directly from session entries, bypassing `_emitExtensionEvent`). Panel is live-only (empty until next thinking event).
- Extraction pattern (from user's orca-agent-status.ts:154-172, `extractAssistantText()`): filter `content` parts by `type`, concatenate string field. Thinking analogue: `type === "thinking"` → `part.thinking`.

### 2. Keeping think out of the chat: only `hideThinkingBlock`

- Render decision: `AssistantMessageComponent.updateContent()` (`dist/modes/interactive/components/assistant-message.js:79-118`) — line 100: if `this.hideThinkingBlock` → single static label (`hiddenThinkingLabel`, default "Thinking..."); lines 111-117: else full italic Markdown block (`theme.fg("thinkingText", ...)`) — the ONLY place think text enters the chat (repo grep confirms; `/tree` selector excludes thinking parts; print mode writes only `type:"text"`).
- The flag: `getHideThinkingBlock()` (`dist/core/settings-manager.js:581-583`) → `settings.hideThinkingBlock ?? false`; per-component at construction (`interactive-mode.js:2348, 2684`); live toggle via Ctrl+T = `app.thinking.toggle` → `toggleThinkingBlockVisibility()` (`interactive-mode.js:3132-3145`), which also persists via `settingsManager.setHideThinkingBlock`.
- **Extension API cannot flip it**: `ExtensionUIContext` (`types.d.ts:68-185`) exposes only `setHiddenThinkingLabel` (label text; `interactive-mode.js:1458-1468`). No `setSettings`/`getSettings` on `ExtensionContext` (`types.d.ts:209-252`) or `ExtensionAPI` (`types.d.ts:855-987`). `settings-manager.js:598-602` setter is internal.
- Raw settings.json write takes effect only at startup or `/reload` (in-memory `this.settings` is computed once and only re-read on `reload()`/`save()` paths; `settings-manager.js:116-140, 432-433`).
- `message_end` replacement (returning `{ message }` from a `message_end` handler, `runner.js:607-659` → `_replaceMessageInPlace` at `agent-session.js:412-425, 468-485`) can strip thinking parts — but permanently removes them from session history AND future LLM context (incl. `thinkingSignature` needed by some providers) and still can't suppress live streaming text. NOT recommended.
- **User decision**: notify-only. Extension reads `~/.pi/agent/settings.json` (fs) at `session_start`; if `hideThinkingBlock !== true` and thinking enabled → `ctx.ui.notify("Think panel: press Ctrl+T or set hideThinkingBlock:true in settings to hide think text from chat")`. Never writes the file.

### 3. Rendering surface: widget aboveEditor beats overlay for this UX

- The subagent example (`examples/extensions/subagent/index.ts`) is a **registered tool** rendered as a transcript item via `renderCall`/`renderResult` (`index.ts:700, 744`) mounted by `ToolExecutionComponent` into `chatContainer` (`interactive-mode.js:2360-2365`) — it scrolls away with history; it only "appears above the chat box" because the viewport pins the bottom. Borrowable: event-driven updates (onUpdate → re-render) and truncation style (`index.ts:787-788`: collapsed text = first 3 lines; previews cut at 40/60 chars). Not a panel pattern.
- Layout: root TUI children are header, resources, **chatContainer**, pendingMessages, status, **widgetContainerAbove**, editorContainer, widgetContainerBelow, footer (`interactive-mode.js:484-493`). `setWidget(key, content, { placement: "aboveEditor" | "belowEditor" })` (`interactive-mode.js:1473-1506`) puts content in the fixed band directly above the editor.
- String-array form: plain `Text(line, 1, 0)` rows, NO border, capped at `MAX_WIDGET_LINES = 10` (`interactive-mode.js:1546-1549`).
- **Factory-function form**: `component = content(this.ui, theme)` called ONCE per setWidget (`interactive-mode.js:1522`); may return any pi-tui component with mutable closure state; can draw a border (`theme.fg("border", ...)` + `truncateToWidth(text, w, "...", true)` — sidebar precedent `~/github/pi-sidebar-panel/extensions/index.ts:392-563`). Uncapped height. Factory receives `tui` as first arg → capture it for `requestRender()` (pattern: `examples/extensions/custom-footer.ts:24-30`).
- Show/hide: `setWidget(key, undefined)` removes the entry entirely (`interactive-mode.js:1481-1486`) — instant, no overlay dispose lifecycle, no focus effects. Empty array `[]` keeps an empty row — use `undefined`.
- Visible during streaming: yes — `message_update` render path (`interactive-mode.js:2355-2384`) never touches widget containers; each `requestRender` re-renders the whole tree including widgets.
- Widgets survive editor-container swaps (selector/editor dialogs) — they're root siblings, not children of `editorContainer` (`hideExtensionSelector` `interactive-mode.js:1759-1766` only clears editorContainer).
- Wiped on `resetExtensionUI()` (`interactive-mode.js:1518-1557`, `clearExtensionWidgets` at 1507-1517) — must re-`setWidget` on every `session_start` (pattern: `plan-mode/index.ts:80`, `widget-placement.ts:6-7`).
- Overlay alternative (`ctx.ui.custom(factory, { overlay: true, overlayOptions, onHandle })`, `interactive-mode.js:1921-1987`): floats over content, `OverlayHandle` has NO `refresh()` — needs `setInterval` + `tui.requestRender()` (sidebar precedent); close is LIFO + disposes the component (`tui.md:179-198`); `nonCapturing: true` required to avoid focus steal (`tui.d.ts:77-104`, `tui.js:289-376`). Rejected as primary: covers chat content, heavier lifecycle; kept as fallback knowledge.
- Widgets/overlays are TUI-only: no-op in print/rpc/json (`runner.js:88-130`); guard with `ctx.mode === "tui"` (`extensions.md:942, 2870-2877`).

### 4. Keybindings: reserved keys + the raw-input path

- `RESERVED_KEYBINDINGS_FOR_EXTENSION_CONFLICTS` (`dist/core/extensions/runner.js:6-24`): app.interrupt, app.clear, app.exit, app.suspend, app.thinking.cycle, app.model.*, app.tools.expand, app.thinking.toggle, app.editor.external, app.message.copy, app.message.followUp, tui.input.submit, tui.select.confirm, tui.select.cancel, tui.input.copy, tui.editor.deleteToLineEnd.
- Default bindings: `escape` → app.interrupt (`dist/core/keybindings.js:7`) + tui.select.cancel (`pi-tui/dist/keybindings.js:78-81`); `ctrl+o` → app.tools.expand (`core/keybindings.js:27`); `ctrl+x` → app.message.copy (`core/keybindings.js:40-43`). All reserved.
- Conflict resolution: `ExtensionRunner.getShortcuts(resolvedKeybindings)` (`runner.js:319-348`) builds key→action map via `buildBuiltinKeybindings` (`runner.js:27-47`); extension shortcut on a `restrictOverride` key is **silently skipped** with a warning diagnostic (`runner.js:332-335`). Check runs against the RESOLVED keybindings — user remapping via `~/.pi/agent/keybindings.json` would free keys, but escape needs BOTH app.interrupt and tui.select.cancel remapped, and `x` can never be a shortcut (would swallow typing `x` in the editor).
- `ctx.ui.onTerminalInput(handler)` (`interactive-mode.js:1643-1650` → `TUI.addInputListener`, `pi-tui/dist/tui.js:443-451`): listeners run at top of `handleInput` (`tui.js:550-620`, loop at 557-570) — BEFORE the focused component (`tui.js:613-618`) and before the editor's escape-abort (`custom-editor.js:36-47`). Return `{ consume: true }` swallows the key globally; `{ data }` rewrites; `undefined` passes through. Fires for every keypress regardless of focus (except OSC/terminal-control replies).
- **Hazard**: consuming `escape` kills stream-abort (defaultEditor.onEscape at `interactive-mode.js:2013-2038`) and autocomplete-escape-cancel (`custom-editor.js:45-46`). Guard: consume escape only when panel open AND not streaming. Track streaming via agent events (e.g. `message_start`/`message_end` or `agent_start`/`agent_settled`) in module state.
- Key data is a raw string: escape=`"\x1b"`, ctrl+o=`"\x0f"`, x=`"x"` (legacy) or CSI-u sequences (Kitty protocol) — ALWAYS match with `matchesKey(data, "escape")` etc. (`pi-tui/dist/keys.js:648-652, 913-922`; builtin usage `interactive-mode.js:1403`).
- Example extensions use `registerShortcut` only for unbound combos (ctrl+alt+p `plan-mode/index.ts:158`, ctrl+shift+u `preset.ts:352`); the fleet (user's live extensions) uses **zero** shortcuts — slash commands only. onTerminalInput has no shipped example; types at `types.d.ts:50-53`.

### 5. Thinking-enabled detection

- `ThinkingLevelSelectEvent` (`types.d.ts:609-613`: `{ level, previousLevel }`) emitted from the single `AgentSession.setThinkingLevel()` (`agent-session.js:1271-1296`) on `pi.setThinkingLevel()`, model change/clamp, and `app.thinking.cycle` (shift+tab, `interactive-mode.js:2051, 3084-3092`). `app.thinking.toggle` (Ctrl+T) is display-only (hideThinkingBlock), emits nothing.
- `ctx.thinkingLevel` in event-handler contexts is a lazy getter → `runtime.getThinkingLevel()` → `agent.state.thinkingLevel` (`runner.js:484-487`, `agent-session.js:1896`) — live at call time. NOT in `session_start` event payload (`types.d.ts:414-420`) — read via `ctx.thinkingLevel` in the handler (binding order guarantees accuracy, `agent-session.js:1845, 1761`). NOT in `ui.custom` factory args (factory gets `(tui, theme, keybindings, done)` only, `types.d.ts:117`).
- ThinkingLevel values: `"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"` (pi-ai `types.d.ts:22-23`). `defaultThinkingLevel` seeds new sessions, clamped to model capabilities (`dist/core/sdk.js:113-131`); non-reasoning models clamp to `"off"` (`pi-ai/dist/models.js:392-424`). User's settings: `defaultThinkingLevel: "max"`, `hideThinkingBlock: false`.

### 6. Extension lifecycle

- Discovery: `~/.pi/agent/extensions/*.ts`, `~/.pi/agent/extensions/*/index.ts` (global), `.pi/extensions/` (project, trust-gated) (`docs/extensions.md:109-124`; `loader.js:470-489`). Module must default-export a factory function (`loader.js:329-343`); loaded via jiti (no build). `/reload` hot-reloads auto-discovered extensions.
- Factory shape (`examples/extensions/hello.ts`): `export default function (pi: ExtensionAPI) { pi.on(...); pi.registerCommand(...); }`. Registration legal at factory time or later; `assertActive()` (`loader.js:224-227, 276`) throws after session dispose.
- **Sub-agent sessions**: extensions load into EVERY in-process session including sub-agents (`ctx.mode === "print"`, `runner.js:89, 267`; `agent-session.js:121`). Guard every session_start/session_shutdown handler with `if (ctx?.mode !== "tui") return;` — sidebar's root-cause fix (its comments at index.ts:572-581, 638-647).
- Reload sequence: `session_shutdown {reason:"reload"}` on old runner (`agent-session.js:2052-2075`) → `resetExtensionUI()` (`interactive-mode.js:1518-1557`: hideOverlay, clearExtensionWidgets, reset footer/header/editor, `defaultEditor.onExtensionShortcut = undefined`) → factory re-runs on new runner (module cache cleared, `resource-loader.js:264-266`) → `session_start {reason:"reload"}`.
- Module state survives session switches (jiti caches module in-process) — stale flags/handles/timers are the #1 bug class; use a session-generation counter pattern (pi-powerline-footer) or explicit reset at session_start.
- `ctx.mode` values: `"tui" | "rpc" | "json" | "print"` (`types.d.ts:208`).

## Code References

- `dist/core/agent-session.js:460-466` — `_emitExtensionEvent`: forwards every stream event to extensions as message_update
- `node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js:205-232` — stream loop: message_update carries `{...event.partial}` (complete growing message)
- `node_modules/@earendil-works/pi-ai/dist/types.d.ts:239-245` — `ThinkingContent` shape
- `dist/core/extensions/types.d.ts:567-571` — `MessageUpdateEvent`; `:609-613` — `ThinkingLevelSelectEvent`; `:50-53` — `TerminalInputHandler`; `:68-185` — `ExtensionUIContext` (only setHiddenThinkingLabel for thinking); `:209-252` — `ExtensionContext` (thinkingLevel, mode, ui)
- `dist/modes/interactive/components/assistant-message.js:79-118` — thinking render: hidden label (100) vs full Markdown (111-117)
- `dist/core/settings-manager.js:581-583` — `getHideThinkingBlock()`; `:598-602` — internal setter
- `dist/modes/interactive/interactive-mode.js:1473-1506` — `setExtensionWidget` (factory form at 1522); `:1481-1486` — `setWidget(key, undefined)` hides; `:1518-1557` — `resetExtensionUI`; `:1643-1650` — `addExtensionTerminalInputListener`; `:1921-1987` — `showExtensionCustom` (overlay); `:2051, 3084-3092` — thinking cycle; `:3132-3145` — hideThinkingBlock toggle; `:2348, 2355-2384, 2684` — message render paths; `:484-493` — root layout (widgetContainerAbove between chat and editor)
- `dist/core/extensions/runner.js:6-24` — reserved keybinding list; `:27-47` — buildBuiltinKeybindings; `:319-348` — getShortcuts skip logic; `:88-130` — noOpUIContext (print)
- `dist/core/keybindings.js:7, 27, 40-43` — escape/ctrl+o/ctrl+x default bindings; `:276-294` — keybindings.json loading
- `dist/modes/interactive/components/custom-editor.js:24-68` — editor input: extension shortcuts first (:26), app.interrupt escape-abort (:36-47)
- `node_modules/@earendil-works/pi-tui/dist/tui.js:443-451` — addInputListener; `:550-620` — handleInput (listeners before focused component, 557-570 / 613-618); `:289-376` — showOverlay + OverlayHandle (no refresh)
- `node_modules/@earendil-works/pi-tui/dist/tui.d.ts:77-104` — OverlayOptions (nonCapturing, visible); `:115-122` — OverlayHandle
- `node_modules/@earendil-works/pi-tui/dist/keys.js:648-652, 913-922` — matchesKey for escape/ctrl+letter
- `dist/core/extensions/loader.js:211-215` — registerShortcut storage; `:272-390` — createExtensionAPI; `:329-343` — factory import; `:470-489` — discovery rules
- `examples/extensions/subagent/index.ts:700, 744, 787-788` — tool renderer patterns (transcript item; truncation style)
- `examples/extensions/custom-footer.ts:24-30` — subscribe + requestRender on change
- `examples/extensions/plan-mode/index.ts:80-82, 158` — setWidget re-set on session_start; ctrl+alt+p shortcut
- `examples/extensions/hello.ts` — minimal factory shape
- `~/github/pi-sidebar-panel/extensions/index.ts:568-765` — overlay + toggle + lifecycle precedent; `:392-563` — bordered box rendering
- `/Users/fliu56/.pi/agent/extensions/orca-agent-status.ts:154-172` — extractAssistantText pattern

## Integration Points

### Inbound References
- `dist/core/agent-session.js:460-466` — extension message_update handlers receive stream events (think capture channel)
- `dist/core/agent-session.js:1271-1296` — setThinkingLevel emits thinking_level_select
- `dist/modes/interactive/interactive-mode.js:1643-1650` — onTerminalInput wraps TUI.addInputListener (key interception)
- `dist/modes/interactive/interactive-mode.js:1473-1506` — setWidget renders widget band above/below editor

### Outbound Dependencies
- `node_modules/@earendil-works/pi-tui/` — TUI instance (captured from setWidget factory), matchesKey, requestRender
- `node_modules/@earendil-works/pi-ai/dist/types.d.ts:239-245` — ThinkingContent type (cast at boundary; SDK types may skew vs runtime)
- `~/.pi/agent/settings.json` — read-only probe of hideThinkingBlock (notify decision)

### Infrastructure Wiring
- Extension file: `~/.pi/agent/extensions/pi-think-panel.ts` (installed copy of git source at `~/github/pi-think-panel/extensions/pi-think-panel.ts`)
- No build step (jiti); `/reload` or restart to apply
- No npm package; no Dockerfile; no CI

## Architecture Insights

- **Think capture = read, don't accumulate**: `message_update` always carries the full thinking text; keep a ring buffer of the last N lines derived from it.
- **Two orthogonal settings**: `hideThinkingBlock` (display in chat) vs `thinkingLevel` (whether thinking happens). Panel visibility keys off thinkingLevel; chat suppression keys off hideThinkingBlock (notify-only per user).
- **onTerminalInput is the universal key hook** but runs before everything — minimal consumption is the design rule (consume only what you own: ctrl+o always; esc/x only when panel open; esc additionally only when idle).
- **Widget factory form** = component created once per session with closure state; updates via captured `tui.requestRender()`; re-created on every session_start.
- **Mode guards**: every handler starts with `if (ctx?.mode !== "tui") return;` — the sidebar's hard-won lesson.
- Panel content rule: last 5 lines of the think text, each truncated to widget width with `truncateToWidth(text, innerW, "...", true)` (pad=true), bordered `╭─╮│╰─╯` box in `theme.fg("border", ...)` — sidebar's proven visual.

## Precedents & Lessons

### Precedent: pi-sidebar-panel overlay extension (`~/github/pi-sidebar-panel`)
**Commits**: `08821c4` (2026-08-02, initial overlay), `ac3ea5b` (todo display parity), `b939b9d` (fix stale sub-agent state at session_start), `30f7877` (fix visibility after session switch), `4e629e4` (visible predicate), `3a753e9` (force full-screen clear on first render — ghost rows), `b584419` (variable height verified against pi-tui source)
**Blast radius**: 1 extension file, 11 commits, 4 lifecycle/ghost-row fixes
**Follow-up fixes**: `b939b9d` — session_start replayed stale branch records → clear state at session_start, replay only on explicit toggle; `30f7877` — module flag survived in-process session switch → reset at session_start, teardown at session_shutdown; `3a753e9` — cross-process ghost rows → once-per-process `tui.requestRender(true)`; `b584419` — fixed-height workaround reverted after verifying pi-tui compositing
**Takeaway**: overlay lifecycle is where everything breaks — reset module state at session_start, teardown at session_shutdown, guard print-mode sessions, drive repaints yourself.

### Precedent: user's live extensions (`~/.pi/agent/extensions/`)
- orca-agent-status.ts: module-level state (warn-once, cached detection, pending-post slot), `session_start` handler with `if (event.reason === 'reload') return;`, extracts only `type:"text"` parts (reasoning treated as noise), zero shortcuts/commands.
- pi-powerline-footer: session-generation counter guards stale timers; re-asserts editor at staggered delays after reload; `thinking_level_select` subscribed at TOP level (was a bug inside startPowerline); setWidget(undefined) teardown; `setInterval(() => tui.requestRender(), 1000)` clock.
- Fleet-wide: slash commands are the proven interaction; zero registerShortcut usage.

### Composite Lessons
1. **Module-level state outlives sessions** (jiti in-process cache) — reset at session_start, teardown at session_shutdown, generation counters for timers (30f7877, powerline).
2. **Extensions load into sub-agent "print" sessions** — guard `ctx.mode !== "tui"` on every session handler (b939b9d root cause B).
3. **Keybinding conflicts are enforced, not warned** — reserved keys silently skip; use onTerminalInput or unbound combos; `x` only via onTerminalInput (runner.js:6-24).
4. **Widgets/overlays don't repaint themselves** — capture tui from the factory, call `tui.requestRender()` on change (custom-footer pattern).
5. **session_start replays the whole branch** — don't re-fill panel from history at startup; live-only is correct (b939b9d).
6. **Reload replaces components after your swap** — re-create widget on every session_start (plan-mode pattern); reload's session_start has `reason: "reload"`.
7. **SDK types may skew vs runtime** (0.80.3 vs 0.83.0) — cast at the registration boundary like the sidebar does.
8. **Ctrl+T (hide thinking) and the think panel are semantically adjacent** — the notify message must point users at Ctrl+T explicitly.

## Historical Context (from `.rpiv/artifacts/`)
- `~/github/.rpiv/artifacts/handoffs/2026-08-03_13-15-42_problem-not-fixed.md` — sidebar bug saga root causes (per-ResourceLoader EventBus, print-mode sessions, ghost rows)
- `~/github/.rpiv/artifacts/handoffs/2026-08-03_15-04-59_ghost-rows-fixed.md` — cross-process residue + once-per-process requestRender(true) fix
- `~/github/.rpiv/artifacts/handoffs/2026-08-02_13-55-00.md` — sidebar extraction from pi-ext-fan; deployment gotcha (pi loads installed copy, not git source)
- `/Users/fliu56/vcc-repo/docs/superpowers/` — vcc-repo pipeline docs (unrelated to this task; do NOT write artifacts into vcc-repo)

## Developer Context

**Q (`dist/core/extensions/runner.js:6-24`): ctrl+o/ctrl+x/escape are reserved — registerShortcut is silently skipped and 'x' can never be a shortcut. How should the panel bind keys?**
A: User pointed at the subagent example extension as the display reference. Investigation showed the subagent example is a transcript tool-renderer (scrolls away), NOT a pinned panel — what's borrowable is event-driven updates + truncation. Chosen surface: `setWidget` aboveEditor (factory form, bordered box) matching the "above the chat box" mental model. Keys: `ctx.ui.onTerminalInput` — ctrl+o toggles, esc/x close when open (esc passes through while streaming to preserve abort). No keybindings.json changes; tool-output-expand loses ctrl+o (documented trade-off, user can remap).

**Q (`dist/modes/interactive/components/assistant-message.js:100-106`): hideThinkingBlock cannot be flipped via extension API. How to keep think text out of the chat?**
A: 仅提示不代写 (notify-only). Extension reads settings.json, if `hideThinkingBlock !== true` notifies the user to press Ctrl+T (persists the setting) or edit settings.json manually. Extension never writes user settings.

**Q (gate): scan complete — write the doc?**
A: Write the doc.

## Related Research
- (none — first artifact in this repo)

## Open Questions
- None blocking. Nice-to-have (deferred): pre-filling the panel from `sessionManager.getBranch()` on resume (replay resurrects stale content — precedent b939b9d advises against; live-only is the v1 scope).
