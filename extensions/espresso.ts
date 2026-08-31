/**
 * pi-espresso — Keeps the Mac awake (display + system idle) while the agent
 * is running, and marks the terminal title with ☕️ while caffeinate is active.
 *
 * Wake sources (either one holds the assertion up):
 *  - the main agent run (agent_start → agent_settled; no flicker between
 *    auto-retries, auto-compaction, or queued follow-up messages)
 *  - async subagents launched via pi-subagents in this session, tracked via
 *    the "subagent:async-started" / "subagent:async-complete" events on the
 *    in-process pi.events bus, hydrated once per session from the
 *    pi-subagents status RPC (covers /reload and late readiness)
 *
 * Title follows pi's own format ("π - [session - ]cwd"). pi rewrites the
 * title on session rename/switch/new/resume/fork, so the marker is
 * re-asserted shortly after those events while awake.
 *
 * macOS only; no-ops elsewhere.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// Matches pi's APP_TITLE default. Only differs for a custom-branded pi build
// (package.json `piConfig.name`); the title self-heals on the next rename/switch.
const APP_TITLE = "π";

// pi-subagents lifecycle events (in-process, parent side only).
const ASYNC_STARTED_EVENT = "subagent:async-started";
const ASYNC_COMPLETE_EVENT = "subagent:async-complete";
const RPC_REQUEST_EVENT = "subagents:rpc:v1:request";
const RPC_READY_EVENT = "subagents:rpc:v1:ready";

export default function (pi: ExtensionAPI) {
	let proc: ChildProcess | null = null;
	let pending: ReturnType<typeof setTimeout> | null = null;
	let mainActive = false;
	let subCount = 0;
	let everRan = false;
	let sessionLive = false;
	let ctxRef: ExtensionContext | undefined;

	const awake = () => mainActive || subCount > 0;

	// Compose pi's title format, optionally prefixed with the caffeinate marker.
	const setTitle = (ctx: ExtensionContext, marker: boolean) => {
		if (!ctx.hasUI) return;
		const cwdBasename = path.basename(ctx.sessionManager.getCwd());
		const name = ctx.sessionManager.getSessionName();
		const base = name ? `${APP_TITLE} - ${name} - ${cwdBasename}` : `${APP_TITLE} - ${cwdBasename}`;
		ctx.ui.setTitle(marker ? `☕️ ${base}` : base);
	};

	// Re-assert the marker after pi rewrites the title. Delayed so we run
	// after pi's internal handler regardless of listener ordering.
	const reassert = (ctx: ExtensionContext) => {
		if (!awake()) return;
		if (pending) clearTimeout(pending);
		pending = setTimeout(() => {
			pending = null;
			if (!awake()) return;
			setTitle(ctx, true);
		}, 50);
	};

	// Reconcile the caffeinate child process and title with current demand.
	// The title is only ever touched after caffeinate has actually run at
	// least once, so no-op platforms and print mode stay untouched.
	const reconcile = (ctx?: ExtensionContext) => {
		if (process.platform !== "darwin") return;
		const shouldRun = awake();
		if (shouldRun && !proc) {
			// -d: prevent display sleep, -i: prevent system idle sleep
			proc = spawn("caffeinate", ["-di"], { stdio: "ignore" });
			proc.on("exit", () => (proc = null));
			everRan = true;
		} else if (!shouldRun && proc) {
			proc.kill("SIGTERM");
			proc = null;
		}
		if (ctx && everRan) setTitle(ctx, shouldRun);
	};

	// Ask pi-subagents how many async runs are active right now and adopt the
	// count if it is higher than what we tracked. Best effort: if the package
	// is absent, old, or not ready yet, the reply never arrives and the
	// listener is dropped after a short grace period. Bump-up-only adoption
	// makes repeated hydrations (session_start + ready event) idempotent.
	const hydrateFleet = () => {
		if (process.platform !== "darwin" || !sessionLive) return;
		const requestId = randomUUID();
		const unsubscribe = pi.events.on(`subagents:rpc:v1:reply:${requestId}`, (raw) => {
			unsubscribe();
			const reply = raw as { success?: boolean; data?: { fleet?: { totalActive?: number } } };
			const total = reply?.success ? reply?.data?.fleet?.totalActive : undefined;
			if (typeof total === "number" && total > subCount) {
				subCount = total;
				reconcile(ctxRef);
			}
		});
		pi.events.emit(RPC_REQUEST_EVENT, { version: 1, requestId, method: "status" });
		setTimeout(() => unsubscribe(), 3000);
	};

	pi.on("session_start", async (_event, ctx) => {
		ctxRef = ctx;
		sessionLive = true;
		reassert(ctx);
		hydrateFleet();
	});

	// pi-subagents may become ready after our session_start; hydrate then too.
	pi.events.on(RPC_READY_EVENT, () => hydrateFleet());

	pi.events.on(ASYNC_STARTED_EVENT, () => {
		if (!sessionLive) return;
		subCount++;
		reconcile(ctxRef);
	});

	pi.events.on(ASYNC_COMPLETE_EVENT, () => {
		if (!sessionLive) return;
		subCount = Math.max(0, subCount - 1);
		reconcile(ctxRef);
	});

	pi.on("agent_start", (_event, ctx) => {
		mainActive = true;
		reconcile(ctx);
	});

	pi.on("agent_settled", (_event, ctx) => {
		mainActive = false;
		reconcile(ctx);
	});

	pi.on("session_info_changed", (_event, ctx) => reassert(ctx));

	pi.on("session_shutdown", () => {
		sessionLive = false;
		mainActive = false;
		subCount = 0;
		ctxRef = undefined;
		if (pending) {
			clearTimeout(pending);
			pending = null;
		}
		if (proc) {
			proc.kill("SIGTERM");
			proc = null;
		}
	});
}
