/**
 * pi-think-panel — a thinking viewport widget above the editor.
 *
 * Captures the model's thinking from message_update events and renders it as
 * a todo-style widget in the extension widget slot (aboveEditor): a scrolling
 * viewport that always shows the LATEST lines. When the wrapped text exceeds
 * the configured height it scrolls up — the newest content stays visible.
 *
 * Rows:
 *   row 0    "🧠Thinking: " prefix + the first line of the visible window
 *            (tail-truncated to terminal width)
 *   rows 1+  continuation lines (N-1 rows for an N-line config; N=1 keeps
 *            prefix and text on the single row, exactly "🧠Thinking: xxx")
 *
 * Lines are VISUAL lines after wrapping to the current terminal width
 * (ANSI-aware via pi-tui's wrapTextWithAnsi), so the view reflows on resize.
 *
 * Shows while the model is thinking and **auto-hides the moment thinking
 * stops** (thinking_end); a later block in the same turn re-shows it. The
 * turn settle (agent_settled) remains a safety-net reset.
 *
 * Configuration: /think-panel [1|3|5|7|off] — persisted to
 * ~/.pi/agent/think-panel.json as {"lines": N} (0 = off). With `off` (or no
 * active thinking) the widget renders zero rows and takes no space.
 *
 * The widget is text-only (no overlay, no key grabbing): ctrl+o/ctrl+h stay
 * with pi. Hiding the native thinking block in chat is pi's own
 * `hideThinkingBlock` setting — this extension never writes user settings.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const WIDGET_KEY = "think-panel:viewport";
const PREFIX = "🧠Thinking: ";
/** Cap the retained raw text so per-delta re-wrap stays O(1). 4KB is far
 * more than the largest possible window (7 lines × ~500 cols). */
const MAX_RETAINED_CHARS = 4000;
const VALID_LINES = [1, 3, 5, 7] as const;
type LinesConfig = (typeof VALID_LINES)[number] | 0; // 0 = off

// Widget background — one of pi's theme bg keys (light/dark adaptive).
const THEME_BGS = [
	"selectedBg",
	"searchMatchBg",
	"userMessageBg",
	"customMessageBg",
	"toolPendingBg",
	"toolSuccessBg",
	"toolErrorBg",
] as const;
type WidgetBg = (typeof THEME_BGS)[number];

function normalizeBg(value: unknown): WidgetBg {
	return typeof value === "string" && (THEME_BGS as readonly string[]).includes(value)
		? (value as WidgetBg)
		: "customMessageBg";
}

// ── Config (~/.pi/agent/think-panel.json) ─────────────────────────────────

function agentDir(): string {
	return process.env.PI_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
}

function configPath(): string {
	return path.join(agentDir(), "think-panel.json");
}

function loadLines(): LinesConfig {
	try {
		const raw = JSON.parse(fs.readFileSync(configPath(), "utf8")) as {
			lines?: unknown;
		};
		return normalizeLines(raw.lines);
	} catch {
		return 1;
	}
}

function normalizeLines(value: unknown): LinesConfig {
	if (typeof value !== "number") return 1;
	if ((VALID_LINES as readonly number[]).includes(value)) return value as LinesConfig;
	return 1;
}

function saveConfig(): void {
	try {
		fs.writeFileSync(
			configPath(),
			JSON.stringify({ lines, bg: bgKey }, null, 2) + "\n",
			"utf8",
		);
	} catch {
		/* persistence is best-effort; the in-session value still applies */
	}
}

// ── Module state (survives in-process session switches via jiti cache) ────

let lines: LinesConfig = loadLines();
let bgKey: WidgetBg = (() => {
	try {
		const raw = JSON.parse(fs.readFileSync(configPath(), "utf8")) as {
			bg?: unknown;
		};
		return normalizeBg(raw.bg);
	} catch {
		return "customMessageBg";
	}
})();
let tui: TUI | undefined;
let blocks: string[] = []; // completed thinking blocks of the current agent run
let blockText = ""; // the streaming block
let thinkActive = false; // true from first thinking_start until agent_settled

/** Extract the complete accumulated thinking text from an assistant message. */
function extractThinking(message: unknown): string {
	// AgentMessage is a union whose custom members have no `content` array —
	// read defensively.
	const content = (message as { content?: unknown } | null)?.content;
	if (!Array.isArray(content)) return "";
	const parts = content as Array<{ type?: string; thinking?: string }>;
	return parts
		.filter((c) => c.type === "thinking")
		.map((c) => c.thinking ?? "")
		.join("\n");
}

function resetViewport(): void {
	blocks = [];
	blockText = "";
	thinkActive = false;
}

/** All thinking text of the current run: blocks joined by a blank line. */
function viewportText(): string {
	const completed = blocks.join("\n\n");
	if (!completed) return blockText;
	return blockText ? `${completed}\n\n${blockText}` : completed;
}

/** Render the widget rows: latest N wrapped lines, prefix on row 0. */
function renderViewport(theme: Theme, width: number): string[] {
	if (lines === 0 || !thinkActive) return [];
	const text = viewportText();
	if (!text.trim()) return [];

	// Keep only the tail so wrapping stays cheap on long thinking streams.
	const tail =
		text.length > MAX_RETAINED_CHARS ? text.slice(-MAX_RETAINED_CHARS) : text;

	const wrapped = wrapTextWithAnsi(tail, Math.max(1, width));
	const window = wrapped.slice(-lines);
	if (window.length === 0) return [];

	// Every row is padded to exactly `width` visible cells and wrapped in the
	// theme bg color, so the viewport reads as one solid band (light/dark
	// adaptive). Rows longer than width are tail-truncated with "...".
	const bg = (s: string) => theme.bg(bgKey, s);
	const row = (s: string) => bg(truncateToWidth(s, width, "...", true));
	const rows: string[] = [];
	rows.push(
		row(theme.fg("accent", PREFIX) + theme.fg("mdCodeBlock", window[0])),
	);
	for (let i = 1; i < window.length; i++) {
		rows.push(row(theme.fg("mdCodeBlock", window[i])));
	}
	return rows;
}

// ── Extension entry ───────────────────────────────────────────────────────

export default function (pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		if (ctx?.mode !== "tui") return;
		// Fresh session → fresh viewport.
		resetViewport();

		// Register-once per session; render() reads live module state, content
		// updates just need requestRender().
		ctx.ui.setWidget(WIDGET_KEY, (t, theme) => {
			tui = t;
			return {
				dispose() {
					if (tui === t) tui = undefined;
				},
				invalidate() {
					t.requestRender();
				},
				render(width: number): string[] {
					return renderViewport(theme, width);
				},
			};
		});
	});

	// Capture: message_update always carries the COMPLETE thinking text.
	pi.on("message_update", (event, ctx) => {
		if (ctx?.mode !== "tui") return;
		const t = event.assistantMessageEvent.type;
		if (!t.startsWith("thinking_")) return;
		if (t === "thinking_start") {
			// A new block is starting — rotate the finished one into blocks.
			if (blockText) {
				blocks.push(blockText);
				blockText = "";
			}
			thinkActive = true;
		} else if (t === "thinking_end") {
			// Thinking stopped → auto-hide immediately; a later block re-shows.
			resetViewport();
		} else {
			blockText = extractThinking(event.message);
			if (blockText.length > MAX_RETAINED_CHARS) {
				blockText = blockText.slice(-MAX_RETAINED_CHARS);
			}
			thinkActive = true;
		}
		tui?.requestRender();
	});

	// Turn fully settled (stream done / aborted) → viewport goes away.
	pi.on("agent_settled", (_event, ctx) => {
		if (ctx?.mode !== "tui") return;
		resetViewport();
		tui?.requestRender();
	});

	// Thinking switched off → nothing to show.
	pi.on("thinking_level_select", (event, ctx) => {
		if (ctx?.mode !== "tui") return;
		if (event.level === "off") {
			resetViewport();
			tui?.requestRender();
		}
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx?.mode !== "tui") return;
		ctx.ui.setWidget(WIDGET_KEY, undefined);
		resetViewport();
		tui = undefined;
	});

	// /think-panel [1|3|5|7|off] | bg <ThemeBg> — persisted.
	pi.registerCommand("think-panel", {
		description:
			"Thinking viewport above the editor: /think-panel [1|3|5|7|off] | bg <selectedBg|searchMatchBg|userMessageBg|customMessageBg|toolPendingBg|toolSuccessBg|toolErrorBg> (persisted)",
		handler: async (args, ctx) => {
			const raw = (args ?? "").trim();
			const lc = raw.toLowerCase();
			if (lc === "" || lc === "status") {
				const state = lines === 0 ? "off" : `${lines} line(s)`;
				ctx.ui.notify(
					`Think viewport: ${state}, bg ${bgKey}\nUsage: /think-panel [1|3|5|7|off] | bg <theme-bg-key>`,
					"info",
				);
				return;
			}
			if (lc.startsWith("bg ")) {
				// Case-insensitive lookup against canonical camelCase keys.
				const requested = raw.slice(3).trim();
				const canonical = THEME_BGS.find(
					(k) => k.toLowerCase() === requested.toLowerCase(),
				);
				if (!canonical) {
					ctx.ui.notify(
						`Think viewport: unknown bg "${requested}". Valid: ${THEME_BGS.join(" ")}`,
						"warning",
					);
					return;
				}
				bgKey = canonical;
				saveConfig();
				ctx.ui.notify(`Think viewport bg: ${bgKey} (persisted)`, "info");
				tui?.requestRender();
				return;
			}
			if (lc === "off" || lc === "0") {
				lines = 0;
			} else {
				const n = Number(raw);
				if (!(VALID_LINES as readonly number[]).includes(n)) {
					ctx.ui.notify(
						`Think viewport: unknown arg "${raw}". Usage: /think-panel [1|3|5|7|off]`,
						"warning",
					);
					return;
				}
				lines = n as LinesConfig;
			}
			saveConfig();
			// No state reset: renderViewport() reads `lines` on every render, so the
			// new height applies on the next paint without a mid-stream blank.
			ctx.ui.notify(
				`Think viewport: ${lines === 0 ? "off" : `${lines} line(s)`} (persisted)`,
				"info",
			);
			tui?.requestRender();
		},
	});
}
