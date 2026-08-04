/**
 * pi-think-panel — floating "think" content overlays.
 *
 * Captures the model's thinking from message_update events and renders:
 *   - overlay A: a top-center floating panel (PANEL_WIDTH_PCT) showing the
 *     last MAX_LINES lines of accumulated think text;
 *   - overlay B: a centered full-text overlay (75% width, 90% max height)
 *     toggled with ctrl+o to read the complete accumulated thinking.
 * Both overlays are nonCapturing so keyboard focus stays in the editor.
 *
 * Keys (ctx.ui.onTerminalInput — ctrl+o / escape / x are reserved keys):
 *   ctrl+o  toggle full-text overlay B (thinking off → info notify)
 *   x       close B + hide A (consumed only while a panel is visible)
 *   escape  collapse B only (never blocks stream-abort)
 * Overlay A is visible while the agent is thinking and auto-hides 5s after
 * the turn settles (EMPTY_THINK_MODE "hide", unless manually opened via
 * ctrl+o). If hideThinkingBlock is not enabled in settings, the title shows
 * a reminder that think text is also visible in chat (Ctrl+T hides it).
 * Never writes user settings.
 */

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { OverlayHandle, TUI } from "@earendil-works/pi-tui";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// Overlay A width — "45%" of terminal width. Tweak to taste, then /reload.
const PANEL_WIDTH_PCT = "45%";
// How many lines of think text overlay A shows (history tail + current block).
const MAX_LINES = 10;

// What to do when no thinking is happening: "last" keeps overlay A visible
// with the last think text; "hide" (default) auto-hides it 5s after the turn
// settles. Change this and /reload to apply.
const EMPTY_THINK_MODE: "last" | "hide" = "hide";

// Module-level state — survives in-process session switches (jiti cache).
let thinkingEnabled = false;
let hideThinkingBlock = false;
let thinkText = ""; // current thinking block (complete text of the active message)
let history: string[] = []; // completed thinking blocks from earlier messages
let manuallyOpened = false; // opened via ctrl+o → auto-hide stands down
let fullOverlayOpen = false; // overlay B (full-text) visible
let closeTimer: ReturnType<typeof setTimeout> | undefined;
let tui: TUI | undefined;
let overlayA: OverlayHandle | undefined;
let overlayB: OverlayHandle | undefined;
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

/** Full accumulated think text: completed blocks + the current block. */
function fullThinkText(): string {
  return [...history, thinkText].join("\n");
}

/** Italic title line: "Thinking…" + hint, plus a dim reminder when needed. */
function titleLine(theme: Theme, hint: string): string {
  const title = theme.italic(theme.fg("accent", "Thinking…") + hint);
  if (hideThinkingBlock) return title;
  return title + theme.italic(theme.fg("dim", "  chat shows think · Ctrl+T hides"));
}

/** Overlay A (top-center panel): last MAX_LINES lines, no inner separator. */
function renderTopPanel(theme: Theme, width: number): string[] {
  const innerW = Math.max(1, width - 2);
  const border = (s: string) => theme.fg("border", s);
  const pad = (s: string) => truncateToWidth(s, innerW, "...", true);
  // Think lines use the chat code-block color (mdCodeBlock) + 2-space indent,
  // matching pi's markdown code-block idiom so think text reads as code.
  const code = (s: string) => theme.fg("mdCodeBlock", s);
  const rows: string[] = [];
  rows.push(border("┌" + "─".repeat(innerW) + "┐"));
  rows.push(border("│") + pad(titleLine(theme, " ⌃O 展开 · esc/x 关闭")) + border("│"));
  const text = fullThinkText();
  const lines = text ? text.split(/\r?\n/).slice(-MAX_LINES) : [];
  if (lines.length === 0) {
    rows.push(border("│") + pad(theme.fg("dim", " (no thinking yet)")) + border("│"));
  } else {
    for (const l of lines) rows.push(border("│") + pad(code("  " + l)) + border("│"));
  }
  rows.push(border("└" + "─".repeat(innerW) + "┘"));
  return rows;
}

/** Overlay B (centered full-text): every line, capped so the hint stays visible. */
function renderFullPanel(theme: Theme, width: number): string[] {
  const innerW = Math.max(1, width - 2);
  const border = (s: string) => theme.fg("border", s);
  const pad = (s: string) => truncateToWidth(s, innerW, "...", true);
  // Think lines use the chat code-block color (mdCodeBlock) + 2-space indent,
  // matching pi's markdown code-block idiom so think text reads as code.
  const code = (s: string) => theme.fg("mdCodeBlock", s);
  const rows: string[] = [];
  rows.push(border("┌" + "─".repeat(innerW) + "┐"));
  rows.push(border("│") + pad(titleLine(theme, "  ⌃O 收起 · esc/x 关闭")) + border("│"));
  const text = fullThinkText();
  const lines = text ? text.split(/\r?\n/) : [];
  if (lines.length === 0) {
    rows.push(border("│") + pad(theme.fg("dim", " (no thinking yet)")) + border("│"));
  } else {
    // maxHeight is 90% of terminal rows — cap the body so the hint (and the
    // bottom border) are not hard-truncated by the TUI.
    const termRows = tui?.terminal.rows ?? 40;
    const maxBody = Math.max(2, Math.floor(termRows * 0.9) - 4);
    const shown = lines.length > maxBody ? lines.slice(0, maxBody) : lines;
    for (const l of shown) rows.push(border("│") + pad(code("  " + l)) + border("│"));
    if (lines.length > maxBody) {
      rows.push(border("│") + pad(theme.fg("dim", " …(更多内容超出)")) + border("│"));
    }
  }
  rows.push(border("└" + "─".repeat(innerW) + "┘"));
  return rows;
}

export default function (pi: ExtensionAPI): void {
  // Streaming flag — guards escape consumption (never block stream-abort).
  pi.on("agent_start", (_event, ctx) => {
    if (ctx?.mode !== "tui") return;
  });
  pi.on("agent_settled", (_event, ctx) => {
    if (ctx?.mode !== "tui") return;
    // 5s cooldown: any new think activity cancels this timer and re-shows the
    // panel, so overlay A stays up across runs of one turn and only hides
    // once the whole turn has been idle for 5s.
    if (closeTimer !== undefined) clearTimeout(closeTimer);
    closeTimer = setTimeout(() => {
      closeTimer = undefined;
      if (EMPTY_THINK_MODE === "hide" && !manuallyOpened) {
        overlayA?.setHidden(true);
      }
    }, 5000);
  });

  // Keep thinking-enabled in sync with every level change (top-level subscription).
  pi.on("thinking_level_select", (event, ctx) => {
    if (ctx?.mode !== "tui") return;
    thinkingEnabled = event.level !== "off";
    if (!thinkingEnabled) {
      // Unmount + reset.
      if (closeTimer !== undefined) {
        clearTimeout(closeTimer);
        closeTimer = undefined;
      }
      overlayA?.hide();
      overlayB?.hide();
      overlayA = undefined;
      overlayB = undefined;
      fullOverlayOpen = false;
      manuallyOpened = false;
    } else if (overlayA === undefined) {
      mountOverlays(ctx);
    }
    tui?.requestRender();
  });

  // Capture: message_update always carries the COMPLETE thinking text.
  pi.on("message_update", (event, ctx) => {
    if (ctx?.mode !== "tui") return;
    if (!thinkingEnabled) return;
    const t = event.assistantMessageEvent.type;
    if (!t.startsWith("thinking_")) return;
    if (t === "thinking_start") {
      // A new block is starting — rotate the finished one into history.
      if (thinkText) {
        history.push(thinkText);
        thinkText = "";
      }
    } else {
      thinkText = extractThinking(event.message);
    }
    // Any think activity keeps the panel up and cancels a pending auto-hide.
    if (closeTimer !== undefined) {
      clearTimeout(closeTimer);
      closeTimer = undefined;
    }
    overlayA?.setHidden(false);
    tui?.requestRender();
  });

  // Reset module state + (re)register the key listener on each session.
  pi.on("session_start", (_event, ctx) => {
    if (ctx?.mode !== "tui") return;

    // Reset module state that survived the previous in-process session.
    if (closeTimer !== undefined) {
      clearTimeout(closeTimer);
      closeTimer = undefined;
    }
    tui = undefined;
    overlayA = undefined;
    overlayB = undefined;
    fullOverlayOpen = false;
    manuallyOpened = false;
    thinkText = "";
    history = [];
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
        if (fullOverlayOpen) {
          overlayB?.setHidden(true);
          fullOverlayOpen = false;
        } else {
          overlayB?.setHidden(false);
          fullOverlayOpen = true;
          manuallyOpened = true; // opening counts as manual — auto-hide stands down
          overlayA?.setHidden(false); // expanding also ensures A is visible
        }
        return { consume: true };
      }
      if (matchesKey(data, "x") && (fullOverlayOpen || overlayA?.isHidden() === false)) {
        overlayB?.setHidden(true);
        fullOverlayOpen = false;
        overlayA?.setHidden(true);
        manuallyOpened = false;
        return { consume: true };
      }
      if (matchesKey(data, "escape")) {
        if (fullOverlayOpen) {
          overlayB?.setHidden(true);
          fullOverlayOpen = false;
          return { consume: true };
        }
        return undefined; // B is closed — pass through (never block stream-abort)
      }
      return undefined;
    });

    // Mount the overlays once per session (visibility toggled afterwards).
    if (thinkingEnabled) mountOverlays(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (ctx?.mode !== "tui") return;
    if (inputUnsub) {
      inputUnsub();
      inputUnsub = null;
    }
    if (closeTimer !== undefined) {
      clearTimeout(closeTimer);
      closeTimer = undefined;
    }
    overlayA?.setHidden(true);
    overlayB?.setHidden(true);
    overlayA = undefined;
    overlayB = undefined;
    fullOverlayOpen = false;
    tui = undefined;
  });

  // Mount both overlays. ctx.ui.custom resolves only when done() is called,
  // so do NOT await it — a persistent overlay never calls done().
  function mountOverlays(ctx: ExtensionContext): void {
    // Overlay A — top-center panel: created once, visibility toggled only.
    void ctx.ui.custom(
      (t, theme) => {
        tui = t;
        return {
          dispose() {},
          invalidate() {
            t.requestRender();
          },
          render(width: number): string[] {
            return renderTopPanel(theme, width);
          },
        };
      },
      {
        overlay: true,
        overlayOptions: { anchor: "top-center", offsetY: 1, width: PANEL_WIDTH_PCT, nonCapturing: true },
        onHandle: (h) => {
          overlayA = h;
          if (EMPTY_THINK_MODE === "hide") h.setHidden(true);
        },
      },
    );

    // Overlay B — centered full-text overlay, hidden until ctrl+o.
    void ctx.ui.custom(
      (t, theme) => {
        tui = t;
        return {
          dispose() {},
          invalidate() {
            t.requestRender();
          },
          render(width: number): string[] {
            return renderFullPanel(theme, width);
          },
        };
      },
      {
        overlay: true,
        overlayOptions: { anchor: "center", width: "75%", maxHeight: "90%", margin: { top: 1 }, nonCapturing: true },
        onHandle: (h) => {
          overlayB = h;
          h.setHidden(true);
        },
      },
    );
  }
}
