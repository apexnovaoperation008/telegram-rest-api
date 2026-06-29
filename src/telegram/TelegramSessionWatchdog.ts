import { eq, and } from "drizzle-orm";
import { TelegramClientService } from "./TelegramClientService";
import { DatabaseClient } from "../database/DatabaseClient";
import { SessionStatus } from "../database/constants/SessionStatus";
import {
	SessionCallbackService,
	type SessionLifecycleReason,
} from "../services/SessionCallbackService";
import { telegramSessions } from "../database/schema";

interface TelegramSessionRecord {
	id: bigint;
	session_id: string;
	telegram_user_id: string;
	callback_url?: string;
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

	/** Last lifecycle reason emitted per session, used to avoid callback spam. */
	private readonly lastEmittedReason = new Map<string, SessionLifecycleReason>();

	/**
	 * Starts the watchdog timer.
	 * Safe to call multiple times — calling start on an already-running
	 * watchdog is a no-op.
	 */
	start(): void {
		if (this.timer) return;

		const intervalSec = Math.max(
			1,
			parseInt(process.env.WATCHDOG_INTERVAL_SECONDS ?? "60", 3),
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

		// Probe all sessions concurrently. Each check is an MTProto round-trip,
		// so running 100+ sequentially would make a single tick take far longer
		// than the watchdog interval.
		await Promise.all(
			pooledIds.map(async (sessionId) => {
				const client = TelegramClientService.getFromPool(sessionId);
				if (!client) return;

				try {
					results.set(
						sessionId,
						await client.getClient().isUserAuthorized(),
					);
				} catch {
					results.set(sessionId, false);
				}
			}),
		);

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

		const sessionInfoCache = new Map<
			string,
			{ callback_url: string; telegram_user_id: string }
		>();

		for (const [sessionId, authorized] of results) {
			if (authorized) {
				this.failureCounts.delete(sessionId);
				this.lastEmittedReason.delete(sessionId);
				continue;
			}

			const count = (this.failureCounts.get(sessionId) ?? 0) + 1;
			this.failureCounts.set(sessionId, count);

			if (count >= REVOKE_AFTER_FAILURES) {
				this.failureCounts.delete(sessionId);
				this.lastEmittedReason.delete(sessionId);
				await TelegramClientService.invalidate(
					sessionId,
					"authorization_check_failed",
				);
				console.log(
					`[Watchdog] Session unauthorized ${count} consecutive times — revoked`,
				);
			} else {
				console.warn(
					`[Watchdog] Session authorization check failed (${count}/${REVOKE_AFTER_FAILURES})`,
				);

				if (
					this.lastEmittedReason.get(sessionId) !==
					"authorization_check_failed"
				) {
					const info = await this.resolveSessionInfo(
						sessionId,
						sessionInfoCache,
					);
					if (info) {
						await SessionCallbackService.notify(
							info.callback_url,
							"telegram_session_disconnected",
							sessionId,
							info.telegram_user_id,
							"disconnected",
							"authorization_check_failed",
						);
						this.lastEmittedReason.set(
							sessionId,
							"authorization_check_failed",
						);
					}
				}
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
			activeSessions = await DatabaseClient.getInstance().execute(
				(db) =>
					db
						.select({
							id: telegramSessions.id,
							session_id: telegramSessions.session_id,
							telegram_user_id: telegramSessions.telegram_user_id,
							callback_url: telegramSessions.callback_url,
						})
						.from(telegramSessions)
						.where(
							and(
								eq(telegramSessions.status, SessionStatus.ACTIVE),
								eq(telegramSessions.server_name, serverName),
							),
						),
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

			if (
				session.callback_url &&
				this.lastEmittedReason.get(session.session_id) !== "reconnecting"
			) {
				await SessionCallbackService.notify(
					session.callback_url,
					"telegram_session_disconnected",
					session.session_id,
					session.telegram_user_id,
					"reconnecting",
					"reconnecting",
				);
				this.lastEmittedReason.set(session.session_id, "reconnecting");
			}

			try {
				const client = await TelegramClientService.initialize(
					session.session_id,
				);
				TelegramClientService.addToPool(
					session.session_id,
					client,
					session.telegram_user_id,
				);
				this.lastEmittedReason.delete(session.session_id);
				console.log(
					`[Watchdog] Session id=${session.id} reconnect successfully`,
				);
			} catch (error) {
				console.error(
					`[Watchdog] Failed to reconnect session id=${session.id}:`,
					error,
				);

				if (
					session.callback_url &&
					this.lastEmittedReason.get(session.session_id) !==
						"reconnect_failed"
				) {
					await SessionCallbackService.notify(
						session.callback_url,
						"telegram_session_disconnected",
						session.session_id,
						session.telegram_user_id,
						"disconnected",
						"reconnect_failed",
					);
					this.lastEmittedReason.set(
						session.session_id,
						"reconnect_failed",
					);
				}
			}
		}
	}

	private async resolveSessionInfo(
		sessionId: string,
		cache: Map<string, { callback_url: string; telegram_user_id: string }>,
	): Promise<{ callback_url: string; telegram_user_id: string } | null> {
		const cached = cache.get(sessionId);
		if (cached) return cached;

		const rows = await DatabaseClient.getInstance().execute((db) =>
			db
				.select({
					callback_url: telegramSessions.callback_url,
					telegram_user_id: telegramSessions.telegram_user_id,
				})
				.from(telegramSessions)
				.where(
					and(
						eq(telegramSessions.session_id, sessionId),
						eq(
							telegramSessions.server_name,
							process.env.SERVER_NAME ?? "",
						),
					),
				)
				.limit(1),
		);
		const record = rows[0] ?? null;

		if (record) {
			cache.set(sessionId, record);
		}
		return record;
	}
}
