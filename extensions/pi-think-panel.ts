/**
 * pi-think-panel — floating "think" content overlays.
 *
 * Captures the model's thinking from message_update events and renders:
 *   - overlay A: a top-left floating panel (PANEL_WIDTH_PCT) showing the
 *     last MAX_LINES lines of accumulated think text;
 *   - overlay B: a left-anchored full-text overlay (80% width, 90% max height)
 *     toggled with ctrl+o to read the latest chunk of accumulated thinking,
 *     auto-following new content as it streams in (a live "details" view);
 *     anchored left so it stays clear of a right-side terminal sidebar.
 * Both overlays are nonCapturing so keyboard focus stays in the editor.
 *
 * Keys (ctx.ui.onTerminalInput — ctrl+o / escape / x are reserved keys):
 *   ctrl+o  toggle between overlay A (small) and overlay B (full text);
 *           thinking off → info notify
 *   ctrl+h  toggle overlay A (small panel) on/off (consumed while B is closed)
 * Closing B is another ctrl+o press (back to A); esc and x are never
 * consumed, so typing and stream-abort keep working.
 * Overlay A is visible while the agent is thinking and auto-hides 10s after
 * thinking ends / the turn settles (EMPTY_THINK_MODE "hide", unless manually opened via
 * ctrl+o). If hideThinkingBlock is not enabled in settings, the title shows
 * a reminder that think text is also visible in chat (Ctrl+T hides it).
 * Never writes user settings.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import type { OverlayHandle, TUI } from "@earendil-works/pi-tui";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// Overlay A width — "90%" of terminal width — near-full width with left/right
// whitespace; tweak then /reload.
const PANEL_WIDTH_PCT = "90%";
// How many lines of think text overlay A shows (history tail + current block).
const MAX_LINES = 10;
// Auto-hide delay (ms) after thinking ends / the turn settles.
const CLOSE_DELAY_MS = 10000;

// What to do when no thinking is happening: "last" keeps overlay A visible
// with the last think text; "hide" (default) auto-hides it 10s after the turn
// settles. Change this and /reload to apply.
const EMPTY_THINK_MODE: "last" | "hide" = "hide";

// Layout published by pi-sidebar-panel via globalThis (same process, jiti's
// shared global realm — no file/module dependency between the two). When the
// sidebar would be drawn (enabled && terminal wide enough), overlays A/B
// shrink out of its column band instead of being covered by it. Absent key ⇒
// sidebar not installed ⇒ no adjustment.
const SIDEBAR_LAYOUT_KEY = "__piSidebarLayout";

interface SidebarLayout {
	enabled: boolean;
	width: number; // rendered sidebar width in cols
	minWidth: number; // terminal cols below which the sidebar is not drawn
}

// Module-level state — survives in-process session switches (jiti cache).
let thinkingEnabled = false;
let hideThinkingBlock = false;
let thinkText = ""; // current thinking block (complete text of the active message)
let thinkEnded = false; // current block has finished → render a trailing ------ divider
let history: string[] = []; // completed thinking blocks from earlier messages
let manuallyOpened = false; // opened via ctrl+o → auto-hide stands down
let manuallyHidden = false; // ctrl+h pressed → A manually hidden; ctrl+h again or a new block re-shows it
let fullOverlayOpen = false; // overlay B (full-text) visible
let closeTimer: ReturnType<typeof setTimeout> | undefined;
let tui: TUI | undefined;
let overlayA: OverlayHandle | undefined;
let overlayB: OverlayHandle | undefined;
let inputUnsub: (() => void) | null = null;
// Width currently mounted for overlays A/B (sidebar-aware); changed ⇒ remount.
type OverlayWidth = number | `${number}%`;
let mountedAWidth: OverlayWidth | undefined;
let mountedBWidth: OverlayWidth | undefined;

/** Layout registry read — never throws; absent ⇒ sidebar not installed. */
function sidebarLayout(): SidebarLayout {
	try {
		const v = (globalThis as Record<string, unknown>)[SIDEBAR_LAYOUT_KEY];
		if (v && typeof v === "object") {
			const s = v as Partial<SidebarLayout>;
			if (typeof s.enabled === "boolean" && typeof s.width === "number") {
				return {
					enabled: s.enabled,
					width: s.width,
					minWidth: typeof s.minWidth === "number" ? s.minWidth : 0,
				};
			}
		}
	} catch {
		/* globalThis read must never throw */
	}
	return { enabled: false, width: 0, minWidth: 0 };
}

/** Overlay A width: full PANEL_WIDTH_PCT unless the sidebar would be drawn. */
function overlayWidthA(): OverlayWidth {
	const s = sidebarLayout();
	const cols = tui?.terminal.columns ?? 0;
	if (s.enabled && s.minWidth > 0 && cols >= s.minWidth)
		return Math.max(20, cols - s.width - 3); // offsetX 1 + 2-col breathing room
	return PANEL_WIDTH_PCT;
}

/** Overlay B width: "80%" unless the sidebar would be drawn. */
function overlayWidthB(): OverlayWidth {
	const s = sidebarLayout();
	const cols = tui?.terminal.columns ?? 0;
	if (s.enabled && s.minWidth > 0 && cols >= s.minWidth)
		return Math.max(20, cols - s.width - 4); // offsetX 2 + 2-col breathing room
	return "80%";
}

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
		const agentDir =
			process.env.PI_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
		const raw = JSON.parse(
			fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"),
		) as {
			hideThinkingBlock?: boolean;
		};
		return raw.hideThinkingBlock ?? false;
	} catch {
		return false;
	}
}

/** Full accumulated think text: completed blocks + the current block. */
function fullThinkText(): string {
	// A "------" divider marks each COMPLETED block — between history entries,
	// and (when the current block has ended) after the current block too.
	const completed = history.join("\n------\n");
	const current = thinkEnded && thinkText ? thinkText + "\n------" : thinkText;
	if (!completed) return current;
	return current ? `${completed}\n\n${current}` : completed;
}

/**
 * With the Kitty keyboard protocol active (flag 2), key release/repeat events
 * are delivered too, and pi-tui's matchesKey() matches on codepoint+modifier
 * regardless of event type — without filtering, ctrl+o would fire on press AND
 * release and double-toggle overlay B (the "flash" bug). pi-tui's own
 * isKeyRelease/isKeyRepeat are not exported from the package barrel, so check
 * inline. Bracketed paste can contain these patterns (e.g. MAC addresses), so
 * paste is treated as one event — the same guard pi-tui itself uses.
 */
function isKeyReleaseOrRepeat(data: string): boolean {
	if (data.includes("\x1b[200~")) return false;
	return /:(?:2|3)[u~ABCDHF]/.test(data);
}

/** Italic title line: "Thinking…" + hint, plus a dim reminder when needed. */
function titleLine(theme: Theme, hint: string): string {
	const title = theme.italic(theme.fg("accent", "Thinking…") + hint);
	if (hideThinkingBlock) return title;
	return (
		title + theme.italic(theme.fg("dim", "  chat shows think · Ctrl+T hides"))
	);
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
	rows.push(
		border("│") + pad(titleLine(theme, " ⌃O 展开 · ⌃H 隐藏")) + border("│"),
	);
	const text = fullThinkText();
	const lines = text ? text.split(/\r?\n/).slice(-MAX_LINES) : [];
	if (lines.length === 0) {
		rows.push(
			border("│") + pad(theme.fg("dim", " (no thinking yet)")) + border("│"),
		);
	} else {
		for (const l of lines)
			rows.push(
				border("│") +
					pad(l === "------" ? theme.fg("dim", "  ------") : code("  " + l)) +
					border("│"),
			);
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
	rows.push(border("│") + pad(titleLine(theme, "  ⌃O 收起")) + border("│"));
	const text = fullThinkText();
	const lines = text ? text.split(/\r?\n/) : [];
	if (lines.length === 0) {
		rows.push(
			border("│") + pad(theme.fg("dim", " (no thinking yet)")) + border("│"),
		);
	} else {
		// maxHeight is 90% of terminal rows — cap the body so the hint (and the
		// bottom border) are not hard-truncated by the TUI. Show the TAIL so the
		// view follows the newest content (a live "details" view — auto-scrolls
		// down as new think lines stream in, same behavior as overlay A).
		const termRows = tui?.terminal.rows ?? 40;
		const maxBody = Math.max(2, Math.floor(termRows * 0.9) - 4);
		const shown = lines.length > maxBody ? lines.slice(-maxBody) : lines;
		if (lines.length > maxBody) {
			rows.push(
				border("│") + pad(theme.fg("dim", " …(更早内容已省略)")) + border("│"),
			);
		}
		for (const l of shown)
			rows.push(
				border("│") +
					pad(l === "------" ? theme.fg("dim", "  ------") : code("  " + l)) +
					border("│"),
			);
	}
	rows.push(border("└" + "─".repeat(innerW) + "┘"));
	return rows;
}

export default function (pi: ExtensionAPI): void {
	// Streaming flag — guards escape consumption (never block stream-abort).
	pi.on("agent_start", (_event, ctx) => {
		if (ctx?.mode !== "tui") return;
	});
	// Set (or reset) the auto-hide timer; new think activity cancels it.
	function armCloseTimer(): void {
		if (closeTimer !== undefined) clearTimeout(closeTimer);
		closeTimer = setTimeout(() => {
			closeTimer = undefined;
			if (EMPTY_THINK_MODE === "hide" && !manuallyOpened) {
				overlayA?.setHidden(true);
			}
		}, CLOSE_DELAY_MS);
	}

	pi.on("agent_settled", (_event, ctx) => {
		if (ctx?.mode !== "tui") return;
		// Hide once the turn has been idle for CLOSE_DELAY_MS; any new think
		// activity cancels the timer and re-shows the panel.
		armCloseTimer();
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
			manuallyHidden = false;
			thinkEnded = false;
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
			thinkEnded = false;
			manuallyHidden = false; // fresh block → auto-show resumes
		} else {
			thinkText = extractThinking(event.message);
			thinkEnded = t === "thinking_end";
		}
		if (t === "thinking_end") {
			// Thinking finished — arm the auto-hide timer (measured from the actual
			// end, robust to event order around agent_settled).
			if (closeTimer === undefined) armCloseTimer();
		} else {
			// thinking_start / thinking_delta — active thinking cancels a pending
			// auto-hide.
			if (closeTimer !== undefined) {
				clearTimeout(closeTimer);
				closeTimer = undefined;
			}
		}
		// Don't re-show the small panel behind an open full-text overlay or a
		// user-requested hide (ctrl+h).
		if (!fullOverlayOpen && !manuallyHidden) overlayA?.setHidden(false);
		// Sidebar toggled or terminal resized? Re-mount with the corrected
		// width (cheap no-op unless the width actually changed).
		syncOverlayWidths(ctx);
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
		mountedAWidth = undefined;
		mountedBWidth = undefined;
		fullOverlayOpen = false;
		manuallyOpened = false;
		manuallyHidden = false;
		thinkText = "";
		thinkEnded = false;
		history = [];
		hideThinkingBlock = readHideThinkingBlock();
		thinkingEnabled = (ctx.thinkingLevel ?? "off") !== "off";

		// (Re)register the key listener; tear down the previous session's one.
		if (inputUnsub) {
			inputUnsub();
			inputUnsub = null;
		}
		inputUnsub = ctx.ui.onTerminalInput((data) => {
			// Kitty-protocol release/repeat events match the same keys — ignore them
			// so each keypress fires exactly once (fixes the ctrl+o double-toggle).
			if (isKeyReleaseOrRepeat(data)) return undefined;
			if (matchesKey(data, "ctrl+o")) {
				syncOverlayWidths(ctx); // sidebar may have toggled while idle
				if (!thinkingEnabled) {
					ctx.ui.notify("Think panel: thinking is off", "info");
					return { consume: true };
				}
				if (fullOverlayOpen) {
					overlayB?.setHidden(true);
					fullOverlayOpen = false;
					// Collapse back onto the small panel (unless the user hid A).
					if (!manuallyHidden) overlayA?.setHidden(false);
				} else {
					overlayB?.setHidden(false);
					fullOverlayOpen = true;
					manuallyOpened = true; // opening counts as manual — auto-hide stands down
					overlayA?.setHidden(true); // hide A so it doesn't show through behind B
				}
				return { consume: true };
			}
			if (
				matchesKey(data, "ctrl+h") &&
				!fullOverlayOpen &&
				overlayA !== undefined
			) {
				// Toggle the small panel: visible → hide it, hidden → bring it back.
				if (overlayA.isHidden()) {
					overlayA.setHidden(false);
					manuallyHidden = false;
				} else {
					overlayA.setHidden(true);
					manuallyHidden = true;
				}
				return { consume: true };
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
		mountOverlayA(ctx);
		mountOverlayB(ctx);
	}

	function mountOverlayA(ctx: ExtensionContext): void {
		mountedAWidth = overlayWidthA();
		void ctx.ui.custom(
			(t, theme) => {
				tui = t;
				// Terminal cols are only known once the TUI ref is captured —
				// re-check the sidebar-aware width a tick after mounting.
				queueMicrotask(() => syncOverlayWidths(ctx));
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
				overlayOptions: {
					anchor: "top-left",
					offsetX: 1,
					offsetY: 1,
					width: mountedAWidth,
					nonCapturing: true,
				},
				onHandle: (h) => {
					overlayA = h;
					if (EMPTY_THINK_MODE === "hide") h.setHidden(true);
				},
			},
		);
	}

	function mountOverlayB(ctx: ExtensionContext): void {
		mountedBWidth = overlayWidthB();
		void ctx.ui.custom(
			(t, theme) => {
				tui = t;
				queueMicrotask(() => syncOverlayWidths(ctx));
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
				overlayOptions: {
					anchor: "left-center",
					offsetX: 2,
					width: mountedBWidth,
					maxHeight: "90%",
					margin: { top: 1 },
					nonCapturing: true,
				},
				onHandle: (h) => {
					overlayB = h;
					h.setHidden(true);
				},
			},
		);
	}

	/** Re-mount overlays A/B when the sidebar-aware width changed. */
	function syncOverlayWidths(ctx: ExtensionContext): void {
		const wa = overlayWidthA();
		if (wa !== mountedAWidth) remountOverlayA(ctx, wa);
		const wb = overlayWidthB();
		if (wb !== mountedBWidth) remountOverlayB(ctx, wb);
	}

	function remountOverlayA(ctx: ExtensionContext, width: OverlayWidth): void {
		const old = overlayA;
		const wasVisible = old?.isHidden() === false;
		old?.hide();
		overlayA = undefined;
		mountedAWidth = width;
		void ctx.ui.custom(
			(t, theme) => {
				tui = t;
				queueMicrotask(() => syncOverlayWidths(ctx));
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
				overlayOptions: {
					anchor: "top-left",
					offsetX: 1,
					offsetY: 1,
					width,
					nonCapturing: true,
				},
				onHandle: (h) => {
					overlayA = h;
					// Preserve visibility across the remount: mid-thinking stays
					// visible; idle ("hide" mode) and open-B states stay hidden.
					h.setHidden(fullOverlayOpen || !(wasVisible && thinkingEnabled));
				},
			},
		);
	}

	function remountOverlayB(ctx: ExtensionContext, width: OverlayWidth): void {
		const old = overlayB;
		old?.hide();
		overlayB = undefined;
		mountedBWidth = width;
		void ctx.ui.custom(
			(t, theme) => {
				tui = t;
				queueMicrotask(() => syncOverlayWidths(ctx));
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
				overlayOptions: {
					anchor: "left-center",
					offsetX: 2,
					width,
					maxHeight: "90%",
					margin: { top: 1 },
					nonCapturing: true,
				},
				onHandle: (h) => {
					overlayB = h;
					h.setHidden(!fullOverlayOpen); // preserve open state
				},
			},
		);
	}
}
