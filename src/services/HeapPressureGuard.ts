import v8 from "node:v8";

/**
 * Exits the process before V8 aborts on heap exhaustion.
 *
 * Production history: the api process leaks heap slowly (suspected pending
 * media requests on wedged DC connections) until it hits the V8 old-space
 * limit and dies with `FATAL ERROR: Ineffective mark-compacts near heap
 * limit` — preceded by minutes of 4s+ GC pauses where the process is
 * effectively unresponsive but still "up". A clean early exit instead lets
 * Docker (`restart: unless-stopped`) bring the process back in seconds with
 * a fresh heap; sessions restore from the database and undelivered messages
 * are already persisted in Postgres, so nothing is lost.
 *
 * Two triggers, because leaks come in two speeds:
 *
 * 1. **Percent path** (slow leak): heap above `HEAP_GUARD_EXIT_PERCENT` of
 *    the V8 heap limit on two consecutive ticks. A single reading can be a
 *    pre-GC spike, but staying above across a full interval means the live
 *    set genuinely no longer fits.
 * 2. **Headroom path** (fast growth): fewer than
 *    `HEAP_GUARD_IMMEDIATE_HEADROOM_MB` left before the limit — exit on a
 *    single observation. V8 actually aborts when *old space* fills, which
 *    sits ~50MB below `heap_size_limit` regardless of heap size, so this
 *    close to the limit the process is already in the death zone and
 *    waiting for a confirming tick risks never getting one (verified by
 *    simulation: a fast allocator can go from 83% to a V8 abort inside one
 *    interval).
 *
 * Tunables (environment):
 * - `HEAP_GUARD_EXIT_PERCENT`  — exit threshold as % of the heap limit
 *   (default 92, `0` disables the guard entirely)
 * - `HEAP_GUARD_WARN_PERCENT`  — log a warning above this % (default 80)
 * - `HEAP_GUARD_IMMEDIATE_HEADROOM_MB` — single-tick exit when this close
 *   to the limit (default 96)
 * - `HEAP_GUARD_INTERVAL_SECONDS` — check cadence (default 30)
 */
const EXIT_PERCENT = parseInt(process.env.HEAP_GUARD_EXIT_PERCENT ?? "92", 10);
const WARN_PERCENT = parseInt(process.env.HEAP_GUARD_WARN_PERCENT ?? "80", 10);
const IMMEDIATE_HEADROOM_MB = parseInt(
	process.env.HEAP_GUARD_IMMEDIATE_HEADROOM_MB ?? "96",
	10,
);
const INTERVAL_SECONDS = Math.max(
	5,
	parseInt(process.env.HEAP_GUARD_INTERVAL_SECONDS ?? "30", 10),
);

export class HeapPressureGuard {
	private timer: ReturnType<typeof setInterval> | null = null;

	/** Consecutive ticks the heap has been above the exit threshold. */
	private breaches = 0;

	/**
	 * Starts the guard timer. Safe to call multiple times — calling start on
	 * an already-running guard is a no-op.
	 */
	start(): void {
		if (this.timer || EXIT_PERCENT <= 0) return;

		this.timer = setInterval(() => this.tick(), INTERVAL_SECONDS * 1000);
		// Never let the guard itself keep a shutting-down process alive.
		this.timer.unref();

		const limitMb = Math.round(
			v8.getHeapStatistics().heap_size_limit / 1024 / 1024,
		);
		console.log(
			`[HeapGuard] Started — limit: ${limitMb}MB, warn: ${WARN_PERCENT}%, exit: ${EXIT_PERCENT}% (interval: ${INTERVAL_SECONDS}s)`,
		);
	}

	/** Stops the guard timer. */
	stop(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}

	private tick(): void {
		const stats = v8.getHeapStatistics();
		const usedPercent = (stats.used_heap_size / stats.heap_size_limit) * 100;
		const usedMb = Math.round(stats.used_heap_size / 1024 / 1024);
		const limitMb = Math.round(stats.heap_size_limit / 1024 / 1024);

		if (limitMb - usedMb <= IMMEDIATE_HEADROOM_MB) {
			console.error(
				`[HeapGuard] Heap at ${usedMb}MB/${limitMb}MB — under ${IMMEDIATE_HEADROOM_MB}MB of headroom, exiting immediately for a clean restart before V8 aborts`,
			);
			process.exit(1);
		}

		if (usedPercent < EXIT_PERCENT) {
			this.breaches = 0;
			if (usedPercent >= WARN_PERCENT) {
				console.warn(
					`[HeapGuard] Heap at ${usedMb}MB/${limitMb}MB (${usedPercent.toFixed(1)}%)`,
				);
			}
			return;
		}

		this.breaches += 1;
		if (this.breaches < 2) {
			console.warn(
				`[HeapGuard] Heap at ${usedMb}MB/${limitMb}MB (${usedPercent.toFixed(1)}%) — exiting if still above ${EXIT_PERCENT}% next tick`,
			);
			return;
		}

		console.error(
			`[HeapGuard] Heap at ${usedMb}MB/${limitMb}MB (${usedPercent.toFixed(1)}%) for 2 consecutive ticks — exiting for a clean restart before V8 aborts`,
		);
		process.exit(1);
	}
}
