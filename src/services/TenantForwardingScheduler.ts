import { eq, and, notInArray, asc, gt } from "drizzle-orm";
import { NodePgDatabase } from "drizzle-orm/node-postgres";
import { DatabaseClient } from "../database/DatabaseClient";
import {
	messages,
	telegramSessions,
	tenantMessageState,
} from "../database/schema";

const FORWARDING_INTERVAL_MS = parseInt(
	process.env.FORWARDING_INTERVAL_MS ?? "1000",
	10,
);
const SERVER_NAME = process.env.SERVER_NAME ?? "";

const CALLBACK_RETRY_BASE_DELAY_S = parseInt(
	process.env.CALLBACK_RETRY_BASE_DELAY_SECONDS ?? "5",
	10,
);
const CALLBACK_MAX_RETRIES = parseInt(
	process.env.CALLBACK_MAX_RETRIES ?? "5",
	10,
);

/**
 * Maximum number of sessions processed concurrently per tick.
 *
 * Each session runs several sequential DB queries plus an outbound HTTP POST,
 * so fanning out across hundreds of sessions at once would stampede the shared
 * connection pool. Bounding concurrency keeps the pool healthy while still
 * draining many sessions in parallel.
 */
const FORWARDING_CONCURRENCY = Math.max(
	1,
	parseInt(process.env.FORWARDING_CONCURRENCY ?? "10", 10),
);

/**
 * Runs `worker` over `items` with at most `limit` concurrent executions.
 * Worker rejections are swallowed (each session already handles its own
 * errors) so one failure never aborts the rest of the batch.
 */
async function mapWithConcurrency<T>(
	items: T[],
	limit: number,
	worker: (item: T) => Promise<void>,
): Promise<void> {
	let cursor = 0;
	const runners = Array.from(
		{ length: Math.min(limit, items.length) },
		async () => {
			while (cursor < items.length) {
				const index = cursor++;
				await worker(items[index]).catch(() => {});
			}
		},
	);
	await Promise.all(runners);
}

/**
 * Forwards messages to each session's callback URL in strict FIFO order.
 *
 * Each session's queue is independent — one session's failure does not
 * delay any other session.
 *
 * FIFO guarantee: messages are forwarded in ascending `id` order per session.
 *
 * Retry behaviour: when a callback POST fails the message stays `downloaded`
 * and `next_delivery_attempt_at` is set using a linear back-off
 * (`attempt * CALLBACK_RETRY_BASE_DELAY_S`).  After `CALLBACK_MAX_RETRIES`
 * the message is marked `delivery_failed` and the cursor advances.
 *
 * Successfully delivered messages are deleted.
 */
export class TenantForwardingScheduler {
	private timer: NodeJS.Timeout | null = null;
	private processing = false;

	start(): void {
		if (this.timer) return;

		this.timer = setInterval(() => this.tick(), FORWARDING_INTERVAL_MS);
		console.log(
			`[ForwardingScheduler] Started (interval: ${FORWARDING_INTERVAL_MS}ms, ` +
				`concurrency: ${FORWARDING_CONCURRENCY}, ` +
				`retryBase: ${CALLBACK_RETRY_BASE_DELAY_S}s, maxRetries: ${CALLBACK_MAX_RETRIES})`,
		);
	}

	stop(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}

	private async tick(): Promise<void> {
		if (this.processing) return;
		this.processing = true;

		try {
			const db = DatabaseClient.getInstance();

			const rows = await db.execute(async (d) => {
				const result = await d
					.selectDistinct({ session_id: messages.session_id })
					.from(messages)
					.innerJoin(
						telegramSessions,
						eq(messages.session_id, telegramSessions.id),
					)
					.where(
						and(
							notInArray(messages.status, [
								"forwarded",
								"delivery_failed",
							]),
							eq(telegramSessions.server_name, SERVER_NAME),
						),
					);
				return result;
			});

			await mapWithConcurrency(
				rows.map((r) => r.session_id),
				FORWARDING_CONCURRENCY,
				(sessionId) => this.processSession(sessionId),
			);
		} catch (error) {
			console.error("[ForwardingScheduler] Tick error:", error);
		} finally {
			this.processing = false;
		}
	}

	private async processSession(sessionId: bigint): Promise<void> {
		try {
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
					`[ForwardingScheduler] No callback_url for session ${sessionId}`,
				);
				return;
			}

			const stateRows = await db.execute(async (d) => {
				const existing = await d
					.select({
						last_forwarded_id:
							tenantMessageState.last_forwarded_id,
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
		} catch (error) {
			console.error(
				`[ForwardingScheduler] Error for session ${sessionId}:`,
				error,
			);
		}
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
	private async forwardNext(
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
					next_delivery_attempt_at:
						messages.next_delivery_attempt_at,
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
				console.log(
					`[ForwardingScheduler] Forwarded message ${nextMsg.id} for session ${sessionId}`,
				);
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
	private async handleDeliverySuccess(
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
			await tx
				.delete(messages)
				.where(eq(messages.id, messageId));
		});
	}

	/**
	 * On failed delivery: increment the retry counter and schedule the next
	 * attempt using linear back-off (`attempt * base`).  If retries are
	 * exhausted, mark the message as permanently failed and advance the cursor.
	 */
	private async handleDeliveryFailure(
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
				`[ForwardingScheduler] Message ${messageId} permanently failed after ${newRetryCount} attempts: ${errorMessage}`,
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
			`[ForwardingScheduler] Message ${messageId} delivery failed ` +
				`(attempt ${newRetryCount}/${CALLBACK_MAX_RETRIES}), ` +
				`next retry in ${delaySec}s: ${errorMessage}`,
		);
	}

	private async postToCallbackUrl(
		callbackUrl: string,
		rawPayload: string | null,
	): Promise<{ ok: true } | { ok: false; error: string }> {
		if (!rawPayload) {
			console.warn(
				`[ForwardingScheduler] Message has no raw_payload, skipping`,
			);
			return { ok: true };
		}

		try {
			const res = await fetch(callbackUrl, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: rawPayload,
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
