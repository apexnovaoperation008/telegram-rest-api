import { eq, and, notInArray } from "drizzle-orm";
import { DatabaseClient } from "../database/DatabaseClient";
import { DeliveryDispatcher } from "./DeliveryDispatcher";
import { messages, telegramSessions } from "../database/schema";

const FORWARDING_INTERVAL_MS = parseInt(
	process.env.FORWARDING_INTERVAL_MS ?? "30000",
	10,
);
const SERVER_NAME = process.env.SERVER_NAME ?? "";

/**
 * Recovery sweeper for message delivery.
 *
 * Real-time delivery is push-based: {@link DeliveryDispatcher.wake} is called
 * the moment a message row is inserted, so under normal operation this
 * scheduler does nothing. It exists to re-wake sessions whose messages are
 * deliverable but whose chain is idle, which happens when:
 *
 *  - a failed delivery's retry back-off (`next_delivery_attempt_at`) expires
 *  - the process restarts with a backlog persisted from before the restart
 *  - a wake was lost for any reason (defence in depth)
 *
 * Each tick is a single discovery query plus O(1) wake calls — no HTTP and
 * no per-message work — so the interval can stay long (default 30s) without
 * affecting normal delivery latency.
 */
export class TenantForwardingScheduler {
	private timer: NodeJS.Timeout | null = null;
	private sweeping = false;

	start(): void {
		if (this.timer) return;

		this.timer = setInterval(() => this.sweep(), FORWARDING_INTERVAL_MS);
		console.log(
			`[ForwardingSweeper] Started (interval: ${FORWARDING_INTERVAL_MS}ms)`,
		);

		// Immediate first sweep so a backlog persisted across a restart starts
		// draining right away instead of after one full interval.
		void this.sweep();
	}

	stop(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}

	private async sweep(): Promise<void> {
		if (this.sweeping) return;
		this.sweeping = true;

		try {
			const db = DatabaseClient.getInstance();

			const rows = await db.execute((d) =>
				d
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
					),
			);

			for (const row of rows) {
				DeliveryDispatcher.wake(row.session_id);
			}
		} catch (error) {
			console.error("[ForwardingSweeper] Sweep error:", error);
		} finally {
			this.sweeping = false;
		}
	}
}
