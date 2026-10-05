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
 * The caffeinate child watches our own pid (`-w process.pid`), so it can
 * never outlive pi — even if pi is killed with SIGKILL or exits while async
 * subagents are still running, the assertion dies with the process.
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

// --- pi-subagents integration contract -------------------------------------
// pi-subagents is optional. When it is loaded in this process it publishes
// two lifecycle events on pi.events (the in-process bus, parent side only):
//
//   subagent:async-started   one async/detached run (or workflow) started
//   subagent:async-complete  one such run settled
//
// Those events are only sufficient while we observe the whole session. After
// /reload, or when pi-subagents becomes ready after us, runs may already be
// in flight, so we hydrate the current count through pi-subagents' versioned
// RPC bridge instead of guessing:
//
//   emit   subagents:rpc:v1:request            { version: 1, requestId, method }
//   reply  subagents:rpc:v1:reply:<requestId>  { version: 1, requestId, method,
//                                                success, data }
//   ready  subagents:rpc:v1:ready              (bridge became available)
//
// We speak only v1 and read only `status` replies. A reply is adopted only
// when its version/method match and it carries a finite `data.fleet.totalActive`
// (capability check, see readFleetTotalActive). Anything else — an absent or
// older pi-subagents, a future v2 protocol, a malformed payload — is ignored,
// and event-only counting keeps working. None of it can crash or wedge the
// assertion. To move to a new protocol version, bump SUBAGENT_RPC_VERSION and
// teach readFleetTotalActive the new payload; the event names are derived.
const SUBAGENT_RPC_VERSION = 1 as const;
const SUBAGENT_RPC_STATUS_METHOD = "status";
const SUBAGENT_RPC_REQUEST_EVENT = `subagents:rpc:v${SUBAGENT_RPC_VERSION}:request`;
const SUBAGENT_RPC_READY_EVENT = `subagents:rpc:v${SUBAGENT_RPC_VERSION}:ready`;
const SUBAGENT_RPC_REPLY_PREFIX = `subagents:rpc:v${SUBAGENT_RPC_VERSION}:reply:`;
// If pi-subagents is absent or not ready, no reply arrives; drop the one-shot
// listener after this grace period so it cannot leak.
const SUBAGENT_RPC_HYDRATE_TIMEOUT_MS = 3000;

// pi-subagents lifecycle events (in-process, parent side only).
const ASYNC_STARTED_EVENT = "subagent:async-started";
const ASYNC_COMPLETE_EVENT = "subagent:async-complete";

// Capability probe for an RPC reply. Returns the active fleet size only when
// the reply is a v1 `status` success carrying a valid count; otherwise
// undefined, so callers fall back to event-only counting.
const readFleetTotalActive = (raw: unknown): number | undefined => {
	if (typeof raw !== "object" || raw === null) return undefined;
	const reply = raw as {
		version?: unknown;
		method?: unknown;
		success?: unknown;
		data?: { fleet?: { totalActive?: unknown } };
	};
	if (reply.version !== SUBAGENT_RPC_VERSION) return undefined;
	if (reply.method !== SUBAGENT_RPC_STATUS_METHOD) return undefined;
	if (reply.success !== true) return undefined;
	const total = reply.data?.fleet?.totalActive;
	return typeof total === "number" && Number.isFinite(total) && total >= 0 ? total : undefined;
};

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
			// -d: prevent display sleep, -i: prevent system idle sleep,
			// -w: exit automatically when pi's pid dies (crash safety net)
			proc = spawn("caffeinate", ["-di", "-w", String(process.pid)], { stdio: "ignore" });
			proc.on("exit", () => (proc = null));
			everRan = true;
		} else if (!shouldRun && proc) {
			proc.kill("SIGTERM");
			proc = null;
		}
		if (ctx && everRan) setTitle(ctx, shouldRun);
	};

	// Ask pi-subagents how many async runs are active right now and adopt the
	// count if it is higher than what we tracked. The reply is validated by
	// readFleetTotalActive (version + method + shape); a missing or incompatible
	// bridge never replies, so the one-shot listener is dropped after a short
	// grace period. Bump-up-only adoption keeps repeated hydrations
	// (session_start + ready event) idempotent, since the counter only ever
	// moves down through the async-complete event.
	const hydrateFleet = () => {
		if (process.platform !== "darwin" || !sessionLive) return;
		const requestId = randomUUID();
		const unsubscribe = pi.events.on(`${SUBAGENT_RPC_REPLY_PREFIX}${requestId}`, (raw) => {
			unsubscribe();
			const total = readFleetTotalActive(raw);
			if (total !== undefined && total > subCount) {
				subCount = total;
				reconcile(ctxRef);
			}
		});
		pi.events.emit(SUBAGENT_RPC_REQUEST_EVENT, {
			version: SUBAGENT_RPC_VERSION,
			requestId,
			method: SUBAGENT_RPC_STATUS_METHOD,
		});
		setTimeout(() => unsubscribe(), SUBAGENT_RPC_HYDRATE_TIMEOUT_MS);
	};

	pi.on("session_start", async (_event, ctx) => {
		ctxRef = ctx;
		sessionLive = true;
		reassert(ctx);
		hydrateFleet();
	});

	// pi-subagents may become ready after our session_start; hydrate then too.
	pi.events.on(SUBAGENT_RPC_READY_EVENT, () => hydrateFleet());

	// Event-only counting: one increment per async run start, one decrement per
	// completion, clamped at zero. These events are already scoped to this
	// parent session by pi-subagents, so the counter needs no session filter.
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
