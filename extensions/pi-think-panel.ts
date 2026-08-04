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
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const WIDGET_KEY = "think-panel";
const MAX_LINES = 5;

// What to do when no thinking is happening: "last" keeps the widget visible
// with the last think text; "hide" (default) hides the widget until the next
// thinking turn starts. Change this and /reload to apply.
const EMPTY_THINK_MODE: "last" | "hide" = "hide";

// Module-level state — survives in-process session switches (jiti cache).
let panelOpen = false;
let streaming = false;
let thinkingEnabled = false;
let hideThinkingBlock = false;
let thinkText = "";
let manuallyOpened = false;
let tui: TUI | undefined;
let inputUnsub: (() => void) | null = null;

/** Extract the complete accumulated thinking text from an assistant message. */
function extractThinking(message: unknown): string {
  // AgentMessage = Message | CustomAgentMessages[...] — custom members (e.g.
  // BashExecutionMessage) have no `content` or non-array shapes, so read defensively.
  const content = (message as { content?: unknown } | null)?.content;
  if (!Array.isArray(content)) return "";
  const parts = content as Array<{ type?: string; thinking?: string }>;
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
    // Empty-think mode: hide the panel once the turn is fully done.
    if (EMPTY_THINK_MODE === "hide" && !manuallyOpened) {
      panelOpen = false;
      ctx.ui.setWidget(WIDGET_KEY, undefined);
    }
  });

  // Keep thinking-enabled in sync with every level change (top-level subscription).
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

  // Capture: message_update always carries the COMPLETE thinking text.
  pi.on("message_update", (event, ctx) => {
    if (ctx?.mode !== "tui") return;
    const t = event.assistantMessageEvent.type;
    if (!t.startsWith("thinking_")) return;
    if (t === "thinking_start") {
      // Auto-show while thinking (default-open).
      if (thinkingEnabled && !panelOpen) {
        panelOpen = true;
        mountPanel(ctx);
      }
    }
    thinkText = extractThinking(event.message);
    if (panelOpen) tui?.requestRender();
  });

  // Reset module state + (re)register the key listener on each session.
  pi.on("session_start", (_event, ctx) => {
    if (ctx?.mode !== "tui") return;

    // Reset module state that survived the previous in-process session.
    panelOpen = false;
    streaming = false;
    tui = undefined;
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

  pi.on("session_shutdown", (_event, ctx) => {
    if (ctx?.mode !== "tui") return;
    if (inputUnsub) {
      inputUnsub();
      inputUnsub = null;
    }
    ctx.ui.setWidget(WIDGET_KEY, undefined);
    panelOpen = false;
    tui = undefined;
  });

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
}
