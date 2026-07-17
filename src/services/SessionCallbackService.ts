const SERVER_NAME = process.env.SERVER_NAME ?? "";

const CALLBACK_TIMEOUT_MS = parseInt(
	process.env.CALLBACK_TIMEOUT_MS ?? "4000",
	10,
);

export type SessionLifecycleEvent =
	| "telegram_session_removed"
	| "telegram_session_disconnected";

export type SessionLifecycleStatus =
	| "removed"
	| "disconnected"
	| "reconnecting";

export type SessionLifecycleReason =
	| "logout"
	| "unauthorized"
	| "authorization_check_failed"
	| "reconnecting"
	| "reconnect_failed";

interface SessionLifecyclePayload {
	event: SessionLifecycleEvent;
	sessionId: string;
	telegramUserId: string;
	status: SessionLifecycleStatus;
	reason: SessionLifecycleReason;
	serverName: string;
	timestamp: string;
}

export class SessionCallbackService {
	static async notify(
		callbackUrl: string,
		event: SessionLifecycleEvent,
		sessionId: string,
		telegramUserId: string,
		status: SessionLifecycleStatus,
		reason: SessionLifecycleReason,
	): Promise<void> {
		const payload: SessionLifecyclePayload = {
			event,
			sessionId,
			telegramUserId,
			status,
			reason,
			serverName: SERVER_NAME,
			timestamp: new Date().toISOString(),
		};

		try {
			const res = await fetch(callbackUrl, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(payload),
				signal: AbortSignal.timeout(CALLBACK_TIMEOUT_MS),
			});

			if (!res.ok) {
				console.error(
					`[SessionCallback] POST to ${callbackUrl} returned HTTP ${res.status} ${res.statusText}`,
				);
			}
		} catch (error) {
			console.error(
				`[SessionCallback] POST to ${callbackUrl} failed:`,
				error instanceof Error ? error.message : error,
			);
		}
	}
}
