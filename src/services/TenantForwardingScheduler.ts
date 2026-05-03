import { PrismaClient } from "@prisma/client";
import { DatabaseClient } from "../database/DatabaseClient";

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

			const rows = await db.execute(
				(prisma) =>
					prisma.message.findMany({
						where: {
							status: { notIn: ["forwarded", "delivery_failed"] },
							session: { server_name: SERVER_NAME },
						},
						select: { session_id: true },
						distinct: ["session_id"],
					}) as Promise<{ session_id: bigint }[]>,
			);

			await Promise.all(rows.map((r) => this.processSession(r.session_id)));
		} catch (error) {
			console.error("[ForwardingScheduler] Tick error:", error);
		} finally {
			this.processing = false;
		}
	}

	private async processSession(sessionId: bigint): Promise<void> {
		try {
			const db = DatabaseClient.getInstance();

			const session = await db.execute(
				(prisma) =>
					prisma.telegramSession.findUnique({
						where: { id: sessionId },
						select: { callback_url: true },
					}) as Promise<{ callback_url: string } | null>,
			);

			if (!session?.callback_url) {
				console.warn(
					`[ForwardingScheduler] No callback_url for session ${sessionId}`,
				);
				return;
			}

			const state = await db.execute(
				(prisma) =>
					prisma.tenantMessageState.upsert({
						where: { session_id: sessionId },
						update: {},
						create: {
							session_id: sessionId,
							last_forwarded_id: BigInt(0),
						},
					}) as Promise<{ last_forwarded_id: bigint }>,
			);

			let lastForwardedId = state.last_forwarded_id;
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

		return db.execute(async (prisma) => {
			const nextMsg = await prisma.message.findFirst({
				where: {
					session_id: sessionId,
					id: { gt: lastForwardedId },
				},
				orderBy: { id: "asc" },
				select: {
					id: true,
					raw_payload: true,
					status: true,
					delivery_retry_count: true,
					next_delivery_attempt_at: true,
				},
			});

			if (!nextMsg) return null;

			// Already forwarded or permanently failed — advance the cursor past it
			if (nextMsg.status === "forwarded" || nextMsg.status === "delivery_failed") {
				await prisma.tenantMessageState.update({
					where: { session_id: sessionId },
					data: { last_forwarded_id: nextMsg.id },
				});
				return nextMsg.id;
			}

			// Retry delay has not elapsed yet — stop the queue for now
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
				await this.handleDeliverySuccess(prisma, sessionId, nextMsg.id);
				console.log(
					`[ForwardingScheduler] Forwarded message ${nextMsg.id} for session ${sessionId}`,
				);
				return nextMsg.id;
			}

			await this.handleDeliveryFailure(
				prisma,
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
		prisma: PrismaClient,
		sessionId: bigint,
		messageId: bigint,
	): Promise<void> {
		await prisma.$transaction([
			prisma.tenantMessageState.update({
				where: { session_id: sessionId },
				data: { last_forwarded_id: messageId },
			}),
			prisma.message.delete({
				where: { id: messageId },
			}),
		]);
	}

	/**
	 * On failed delivery: increment the retry counter and schedule the next
	 * attempt using linear back-off (`attempt * base`).  If retries are
	 * exhausted, mark the message as permanently failed and advance the cursor.
	 */
	private async handleDeliveryFailure(
		prisma: PrismaClient,
		sessionId: bigint,
		messageId: bigint,
		currentRetryCount: number,
		errorMessage: string,
	): Promise<void> {
		const newRetryCount = currentRetryCount + 1;

		if (newRetryCount >= CALLBACK_MAX_RETRIES) {
			await prisma.$transaction([
				prisma.message.update({
					where: { id: messageId },
					data: {
						status: "delivery_failed",
						delivery_retry_count: newRetryCount,
						delivery_failed_at: new Date(),
						last_delivery_error: errorMessage,
						next_delivery_attempt_at: null,
					},
				}),
				prisma.tenantMessageState.update({
					where: { session_id: sessionId },
					data: { last_forwarded_id: messageId },
				}),
			]);

			console.error(
				`[ForwardingScheduler] Message ${messageId} permanently failed after ${newRetryCount} attempts: ${errorMessage}`,
			);
			return;
		}

		const delaySec = newRetryCount * CALLBACK_RETRY_BASE_DELAY_S;
		const nextAttempt = new Date(Date.now() + delaySec * 1000);

		await prisma.message.update({
			where: { id: messageId },
			data: {
				delivery_retry_count: newRetryCount,
				next_delivery_attempt_at: nextAttempt,
				last_delivery_error: errorMessage,
			},
		});

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
