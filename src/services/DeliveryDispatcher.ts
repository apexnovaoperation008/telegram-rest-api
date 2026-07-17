import { eq, and, gt, asc } from "drizzle-orm";
import { NodePgDatabase } from "drizzle-orm/node-postgres";
import { DatabaseClient } from "../database/DatabaseClient";
import { messages, telegramSessions, tenantMessageState } from "../database/schema";

const CALLBACK_RETRY_BASE_DELAY_S = parseInt(
	process.env.CALLBACK_RETRY_BASE_DELAY_SECONDS ?? "5",
	10,
);
const CALLBACK_MAX_RETRIES = parseInt(
	process.env.CALLBACK_MAX_RETRIES ?? "5",
	10,
);

/**
 * Upper bound for a single callback POST. Without it a hung tenant endpoint
 * holds its delivery chain for undici's default timeout (~5 minutes); with it
 * the message falls into the normal retry/back-off path instead.
 */
const CALLBACK_TIMEOUT_MS = parseInt(
	process.env.CALLBACK_TIMEOUT_MS ?? "4000",
	10,
);

/**
 * Push-based message delivery.
 *
 * Every session has (at most) one lightweight delivery chain — an async loop
 * that drains that session's queue in strict FIFO order and then goes idle.
 * `wake(sessionId)` is called the moment a message row is inserted
 * (EventHandler) and by the recovery sweeper (TenantForwardingScheduler), so
 * delivery starts within milliseconds of arrival instead of waiting for a
 * polling tick.
 *
 * Chains are independent: a slow or failing tenant delays only its own queue,
 * never another session's. Node comfortably sustains one in-flight POST per
 * session; DB connections are only held for the milliseconds around each
 * query, not across the POST.
 *
 * Wake coalescing: wakes arriving while a chain is running set a pending
 * flag and return; the chain re-drains before going idle, so no wake is ever
 * lost and no session ever has two concurrent chains (which would break FIFO).
 *
 * Retry behaviour is unchanged from the original scheduler: a failed POST
 * sets `next_delivery_attempt_at` with linear back-off and the chain parks;
 * the sweeper re-wakes the session once the delay expires. After
 * `CALLBACK_MAX_RETRIES` the message is marked `delivery_failed` and the
 * cursor advances past it.
 */
export class DeliveryDispatcher {
	/** Sessions with a currently running delivery chain. */
	private static readonly running = new Set<string>();

	/** Sessions that were woken while their chain was running (or starting). */
	private static readonly pendingWake = new Set<string>();

	/**
	 * Requests delivery for a session. Starts a chain if none is running,
	 * otherwise flags the running chain to re-drain before going idle.
	 * Fire-and-forget and cheap — safe to call once per inserted message.
	 */
	static wake(sessionId: bigint): void {
		const key = sessionId.toString();
		DeliveryDispatcher.pendingWake.add(key);

		if (DeliveryDispatcher.running.has(key)) return;
		DeliveryDispatcher.running.add(key);

		void DeliveryDispatcher.runChain(sessionId, key);
	}

	/** Whether a delivery chain is currently running for the session. */
	static isRunning(sessionId: bigint): boolean {
		return DeliveryDispatcher.running.has(sessionId.toString());
	}

	private static async runChain(
		sessionId: bigint,
		key: string,
	): Promise<void> {
		try {
			while (DeliveryDispatcher.pendingWake.has(key)) {
				DeliveryDispatcher.pendingWake.delete(key);
				await DeliveryDispatcher.drainSession(sessionId).catch((error) =>
					console.error(
						`[DeliveryDispatcher] Drain error for session ${sessionId}:`,
						error,
					),
				);
			}
		} finally {
			DeliveryDispatcher.running.delete(key);
			// A wake may have landed between the loop's last check and the
			// `running` cleanup above; restart so it is not lost.
			if (DeliveryDispatcher.pendingWake.has(key)) {
				DeliveryDispatcher.wake(sessionId);
			}
		}
	}

	/**
	 * Delivers every currently deliverable message for the session in
	 * ascending `id` order, then returns. Stops early when the head of the
	 * queue is waiting on its retry delay or fails its POST.
	 */
	private static async drainSession(sessionId: bigint): Promise<void> {
		const db = DatabaseClient.getInstance();

		const sessionRows = await db.execute((d) =>
			d
				.select({ callback_url: telegramSessions.callback_url })
				.from(telegramSessions)
				.where(eq(telegramSessions.id, sessionId))
				.limit(1),
		);
		const session = sessionRows[0] ?? null;

		if (!session?.callback_url) {
			console.warn(
				`[DeliveryDispatcher] No callback_url for session ${sessionId}`,
			);
			return;
		}

		const stateRows = await db.execute(async (d) => {
			const existing = await d
				.select({
					last_forwarded_id: tenantMessageState.last_forwarded_id,
				})
				.from(tenantMessageState)
				.where(eq(tenantMessageState.session_id, sessionId))
				.limit(1);

			if (existing.length > 0) return existing;

			await d.insert(tenantMessageState).values({
				session_id: sessionId,
				last_forwarded_id: BigInt(0),
				updated_at: new Date(),
			});
			return [{ last_forwarded_id: BigInt(0) }];
		});

		let lastForwardedId = stateRows[0].last_forwarded_id;
		let nextId: bigint | null;

		do {
			nextId = await this.forwardNext(
				sessionId,
				lastForwardedId,
				session.callback_url,
			);
			if (nextId !== null) {
				lastForwardedId = nextId;
			}
		} while (nextId !== null);
	}

	/**
	 * Finds the next message after `lastForwardedId` for the session and
	 * attempts to forward it.
	 *
	 * Returns the forwarded message's `id` (the new cursor) on success,
	 * or `null` when:
	 *  - There are no more messages to forward
	 *  - The next message is waiting for its retry delay to expire
	 *  - The HTTP POST to the callback URL failed
	 */
	private static async forwardNext(
		sessionId: bigint,
		lastForwardedId: bigint,
		callbackUrl: string,
	): Promise<bigint | null> {
		const db = DatabaseClient.getInstance();

		return db.execute(async (d) => {
			const rows = await d
				.select({
					id: messages.id,
					raw_payload: messages.raw_payload,
					status: messages.status,
					delivery_retry_count: messages.delivery_retry_count,
					next_delivery_attempt_at: messages.next_delivery_attempt_at,
				})
				.from(messages)
				.where(
					and(
						eq(messages.session_id, sessionId),
						gt(messages.id, lastForwardedId),
					),
				)
				.orderBy(asc(messages.id))
				.limit(1);

			const nextMsg = rows[0];
			if (!nextMsg) return null;

			if (
				nextMsg.status === "forwarded" ||
				nextMsg.status === "delivery_failed"
			) {
				await d
					.update(tenantMessageState)
					.set({
						last_forwarded_id: nextMsg.id,
						updated_at: new Date(),
					})
					.where(eq(tenantMessageState.session_id, sessionId));
				return nextMsg.id;
			}

			if (
				nextMsg.next_delivery_attempt_at &&
				nextMsg.next_delivery_attempt_at > new Date()
			) {
				return null;
			}

			const postResult = await this.postToCallbackUrl(
				callbackUrl,
				nextMsg.raw_payload,
			);

			if (postResult.ok) {
				await this.handleDeliverySuccess(d, sessionId, nextMsg.id);
				return nextMsg.id;
			}

			await this.handleDeliveryFailure(
				d,
				sessionId,
				nextMsg.id,
				nextMsg.delivery_retry_count,
				postResult.error,
			);
			return null;
		});
	}

	/**
	 * On successful delivery: advance the cursor and delete the message row.
	 */
	private static async handleDeliverySuccess(
		db: NodePgDatabase,
		sessionId: bigint,
		messageId: bigint,
	): Promise<void> {
		await db.transaction(async (tx) => {
			await tx
				.update(tenantMessageState)
				.set({
					last_forwarded_id: messageId,
					updated_at: new Date(),
				})
				.where(eq(tenantMessageState.session_id, sessionId));
			await tx.delete(messages).where(eq(messages.id, messageId));
		});
	}

	/**
	 * On failed delivery: increment the retry counter and schedule the next
	 * attempt using linear back-off (`attempt * base`).  If retries are
	 * exhausted, mark the message as permanently failed and advance the cursor.
	 */
	private static async handleDeliveryFailure(
		db: NodePgDatabase,
		sessionId: bigint,
		messageId: bigint,
		currentRetryCount: number,
		errorMessage: string,
	): Promise<void> {
		const newRetryCount = currentRetryCount + 1;

		if (newRetryCount >= CALLBACK_MAX_RETRIES) {
			await db.transaction(async (tx) => {
				await tx
					.update(messages)
					.set({
						status: "delivery_failed",
						delivery_retry_count: newRetryCount,
						delivery_failed_at: new Date(),
						last_delivery_error: errorMessage,
						next_delivery_attempt_at: null,
						updated_at: new Date(),
					})
					.where(eq(messages.id, messageId));
				await tx
					.update(tenantMessageState)
					.set({
						last_forwarded_id: messageId,
						updated_at: new Date(),
					})
					.where(eq(tenantMessageState.session_id, sessionId));
			});

			console.error(
				`[DeliveryDispatcher] Message ${messageId} permanently failed after ${newRetryCount} attempts: ${errorMessage}`,
			);
			return;
		}

		const delaySec = newRetryCount * CALLBACK_RETRY_BASE_DELAY_S;
		const nextAttempt = new Date(Date.now() + delaySec * 1000);

		await db
			.update(messages)
			.set({
				delivery_retry_count: newRetryCount,
				next_delivery_attempt_at: nextAttempt,
				last_delivery_error: errorMessage,
				updated_at: new Date(),
			})
			.where(eq(messages.id, messageId));

		console.warn(
			`[DeliveryDispatcher] Message ${messageId} delivery failed ` +
				`(attempt ${newRetryCount}/${CALLBACK_MAX_RETRIES}), ` +
				`next retry in ${delaySec}s: ${errorMessage}`,
		);
	}

	private static async postToCallbackUrl(
		callbackUrl: string,
		rawPayload: string | null,
	): Promise<{ ok: true } | { ok: false; error: string }> {
		if (!rawPayload) {
			console.warn(
				`[DeliveryDispatcher] Message has no raw_payload, skipping`,
			);
			return { ok: true };
		}

		try {
			const res = await fetch(callbackUrl, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: rawPayload,
				signal: AbortSignal.timeout(CALLBACK_TIMEOUT_MS),
			});

			if (!res.ok) {
				return {
					ok: false,
					error: `HTTP ${res.status} ${res.statusText}`,
				};
			}

			return { ok: true };
		} catch (error) {
			return {
				ok: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}
}
