import { TelegramClientService } from "./TelegramClientService";
import { DatabaseClient } from "../database/DatabaseClient";
import { SessionStatus } from "../database/constants/SessionStatus";

interface TelegramSessionRecord {
	id: number;
	session_id: string;
	telegram_user_id: string;
}

/**
 * Periodically scans the session pool and the database to keep live
 * Telegram connections in a healthy state.
 *
 * Two scenarios are handled on every tick:
 *
 * 1. **Stale pool entry** — a session is pooled but the user has logged out
 *    (e.g. revoked from another device). The client is destroyed, removed from
 *    the pool, and the database record is marked as revoked.
 *
 * 2. **Dead session** — a session is active in the database but absent from
 *    the pool (e.g. the process crashed and restarted without a full restore,
 *    or the connection dropped silently). The session is re-initialized and
 *    added back to the pool automatically.
 *
 * The check interval is controlled by `WATCHDOG_INTERVAL_SECONDS` in the
 * environment file (default: 60 seconds).
 */
const REVOKE_AFTER_FAILURES = 10;

export class TelegramSessionWatchdog {
	private timer: ReturnType<typeof setInterval> | null = null;

	/** Whether a health-check tick is currently in progress. */
	private busy = false;

	/** Tracks consecutive `isUserAuthorized()` failures per session. */
	private readonly failureCounts = new Map<string, number>();

	/**
	 * Starts the watchdog timer.
	 * Safe to call multiple times — calling start on an already-running
	 * watchdog is a no-op.
	 */
	start(): void {
		if (this.timer) return;

		const intervalSec = Math.max(
			1,
			parseInt(process.env.WATCHDOG_INTERVAL_SECONDS ?? "60", 10),
		);

		this.timer = setInterval(() => {
			this.tick().catch((error) => {
				console.error("[Watchdog] Unhandled error during tick:", error);
			});
		}, intervalSec * 1000);

		console.log(`[Watchdog] Started — interval: ${intervalSec}s`);
	}

	/** Stops the watchdog timer. */
	stop(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
			console.log("[Watchdog] Stopped");
		}
	}

	// ── Private ──────────────────────────────────────────────────────────

	/**
	 * Single watchdog tick.
	 * Guards against overlapping ticks if a previous one is still running.
	 */
	private async tick(): Promise<void> {
		if (this.busy) {
			return;
		}

		this.busy = true;
		try {
			await this.evictLoggedOutSessions();
			await this.reviveDeadSessions();
		} finally {
			this.busy = false;
		}
	}

	/**
	 * Scenario 1: Pool contains a session whose user has logged out.
	 *
	 * First probes every pooled session with `isUserAuthorized()`, then
	 * applies a circuit breaker: if most sessions failed in this tick
	 * the cause is almost certainly a network outage rather than
	 * individual logouts, so failure counters are left unchanged and
	 * no sessions are evicted.
	 *
	 * Individual failures are tracked with a consecutive-failure counter;
	 * a session is only revoked after {@link REVOKE_AFTER_FAILURES}
	 * consecutive ticks where it alone (not the whole pool) fails.
	 */
	private async evictLoggedOutSessions(): Promise<void> {
		const pooledIds = TelegramClientService.getPooledSessionIds();
		if (pooledIds.length === 0) return;

		const results = new Map<string, boolean>();

		for (const sessionId of pooledIds) {
			const client = TelegramClientService.getFromPool(sessionId);
			if (!client) continue;

			try {
				results.set(
					sessionId,
					await client.getClient().isUserAuthorized(),
				);
			} catch {
				results.set(sessionId, false);
			}
		}

		const total = results.size;
		const failedCount = [...results.values()].filter((v) => !v).length;

		if (failedCount === total && total > 1) {
			console.warn(
				`[Watchdog] All ${total} sessions failed authorization — likely a network issue, skipping eviction`,
			);
			return;
		}

		if (total > 2 && failedCount / total > 0.5) {
			console.warn(
				`[Watchdog] ${failedCount}/${total} sessions failed — likely a network issue, skipping eviction`,
			);
			return;
		}

		for (const [sessionId, authorized] of results) {
			if (authorized) {
				this.failureCounts.delete(sessionId);
				continue;
			}

			const count = (this.failureCounts.get(sessionId) ?? 0) + 1;
			this.failureCounts.set(sessionId, count);

			if (count >= REVOKE_AFTER_FAILURES) {
				this.failureCounts.delete(sessionId);
				await TelegramClientService.invalidate(sessionId);
				console.log(
					`[Watchdog] Session unauthorized ${count} consecutive times — revoked`,
				);
			} else {
				console.warn(
					`[Watchdog] Session authorization check failed (${count}/${REVOKE_AFTER_FAILURES})`,
				);
			}
		}
	}

	/**
	 * Scenario 2: Database has an active session that is not in the pool.
	 *
	 * Queries the database for all active sessions belonging to this server
	 * and re-initializes any that are missing from the pool.
	 */
	private async reviveDeadSessions(): Promise<void> {
		const serverName = process.env.SERVER_NAME ?? "";
		if (!serverName) return;

		let activeSessions: TelegramSessionRecord[];

		try {
			// Get all active sessions from the database by server name and status active
			activeSessions = await DatabaseClient.getInstance().execute<
				TelegramSessionRecord[]
			>((prisma) =>
				prisma.telegramSession.findMany({
					select: {
						id: true,
						session_id: true,
						telegram_user_id: true,
					},
					where: {
						status: SessionStatus.ACTIVE,
						server_name: serverName,
					},
				}),
			);
		} catch (error) {
			console.error("[Watchdog] Failed to query active sessions:", error);
			return;
		}

		for (const session of activeSessions) {
			if (TelegramClientService.isPooled(session.session_id)) continue;

			console.log(
				`[Watchdog] Session id=${session.id} is active in DB but not pooled — Reconnecting`,
			);

			try {
				const client = await TelegramClientService.initialize(
					session.session_id,
				);
				TelegramClientService.addToPool(
					session.session_id,
					client,
					session.telegram_user_id,
				);
				console.log(
					`[Watchdog] Session id=${session.id} reconnect successfully`,
				);
			} catch (error) {
				console.error(
					`[Watchdog] Failed to reconnect session id=${session.id}:`,
					error,
				);
			}
		}
	}
}
