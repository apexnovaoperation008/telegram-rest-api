import { Api, TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { eq, and } from "drizzle-orm";
import { EventHandler, type SentMessageContext } from "./EventHandler";
import { DatabaseClient } from "../database/DatabaseClient";
import { SessionStatus } from "../database/constants/SessionStatus";
import { TelegramClientInterface } from "./interface/Telegram";
import {
	SessionCallbackService,
	type SessionLifecycleReason,
} from "../services/SessionCallbackService";
import { telegramSessions } from "../database/schema";

interface TelegramSessionRecord {
	id: bigint;
	session_id: string;
	telegram_user_id: string;
	telegram_username: string;
	status: string;
}

/**
 * Manages individual Telegram client connections and a static pool
 * of live authenticated sessions.
 *
 * Each instance wraps a single TelegramClient.
 * The static pool keeps authenticated clients alive for real-time use
 * (sending/receiving messages). On startup, active sessions are restored
 * from the database via {@link restoreFromDatabase}.
 */
export class TelegramClientService implements TelegramClientInterface {
	// ── Static Pool State ──────────────────────────────────────────────

	private static readonly pool = new Map<string, TelegramClientService>();
	private static readonly eventHandlers = new Map<string, EventHandler>();

	// ── Instance State ─────────────────────────────────────────────────

	private readonly client: TelegramClient;

	private constructor(
		private readonly apiId: number,
		private readonly apiHash: string,
		private readonly sessionId: string,
	) {
		this.client = new TelegramClient(
			new StringSession(this.sessionId),
			this.apiId,
			this.apiHash,
			{
				connectionRetries: 10,
				retryDelay: 2000,
				maxConcurrentDownloads: 4,
			},
		);
	}

	/**
	 * Returns a connected client for the given session.
	 * If the session is already pooled the existing instance is returned;
	 * otherwise a fresh connection is created (caller owns its lifecycle).
	 */
	static async initialize(
		sessionId: string = "",
	): Promise<TelegramClientService> {
		const apiId = parseInt(process.env.TELEGRAM_API_ID ?? "", 10);
		const apiHash = process.env.TELEGRAM_API_HASH ?? "";

		if (!apiId || !apiHash) {
			throw new Error(
				"TELEGRAM_API_ID and TELEGRAM_API_HASH must be set in environment variables",
			);
		}

		if (sessionId !== "" && TelegramClientService.pool.has(sessionId)) {
			return TelegramClientService.pool.get(sessionId) as TelegramClientService;
		}

		const client = new TelegramClientService(apiId, apiHash, sessionId);
		await client.connect();
		return client;
	}

	/**
	 * Registers an authenticated client in the pool and starts
	 * its incoming-message handler.
	 */
	static addToPool(
		sessionId: string,
		client: TelegramClientService,
		telegramUserId?: string,
	): void {
		TelegramClientService.pool.set(sessionId, client);

		if (telegramUserId) {
			TelegramClientService.startEventHandler(sessionId, client, telegramUserId);
		}
	}

	/** Checks whether a session is currently held in the pool. */
	static isPooled(sessionId: string): boolean {
		return TelegramClientService.pool.has(sessionId);
	}

	/** Returns the IDs of all sessions currently held in the pool. */
	static getPooledSessionIds(): string[] {
		return [...TelegramClientService.pool.keys()];
	}

	/** Returns the pooled client instance for a session, or undefined. */
	static getFromPool(sessionId: string): TelegramClientService | undefined {
		return TelegramClientService.pool.get(sessionId);
	}

	/**
	 * Invalidates a session: stops its handlers, deletes the session record
	 * (cascades to messages and tenant state), logs out from Telegram, and
	 * removes it from the pool.
	 *
	 * Returns `false` if the session does not exist on this server, so callers
	 * can distinguish between a valid logout and an invalid/foreign session.
	 */
	static async invalidate(
		sessionId: string,
		reason: SessionLifecycleReason = "unauthorized",
	): Promise<boolean> {
		TelegramClientService.stopEventHandler(sessionId);

		const serverName = process.env.SERVER_NAME ?? "";
		const db = DatabaseClient.getInstance();

		const sessionRows = await db.execute((d) =>
			d
				.select({
					callback_url: telegramSessions.callback_url,
					telegram_user_id: telegramSessions.telegram_user_id,
				})
				.from(telegramSessions)
				.where(
					and(
						eq(telegramSessions.session_id, sessionId),
						eq(telegramSessions.server_name, serverName),
					),
				)
				.limit(1),
		);
		const sessionRecord = sessionRows[0] ?? null;

		const result = await db.execute((d) =>
			d
				.delete(telegramSessions)
				.where(
					and(
						eq(telegramSessions.session_id, sessionId),
						eq(telegramSessions.server_name, serverName),
					),
				),
		);

		if (result.rowCount === 0) {
			return false;
		}

		if (TelegramClientService.isPooled(sessionId)) {
			const client = TelegramClientService.pool.get(
				sessionId,
			) as TelegramClientService;

			try {
				await client.getClient().invoke(new Api.auth.LogOut());
				await client.destroy();
			} catch {
				// Client may already be in a broken state; ignore destroy errors
			}
			TelegramClientService.pool.delete(sessionId);
		}

		if (sessionRecord?.callback_url) {
			await SessionCallbackService.notify(
				sessionRecord.callback_url,
				"telegram_session_removed",
				sessionId,
				sessionRecord.telegram_user_id,
				"removed",
				reason,
			);
		}

		return true;
	}

	/**
	 * Restores all active sessions for this server from the database,
	 * reconnects each, and registers them in the pool.
	 */
	static async restoreFromDatabase(): Promise<void> {
		const serverName = process.env.SERVER_NAME ?? "";
		if (!serverName) {
			console.log("No telegram sessions to restore");
			return;
		}

		const db = DatabaseClient.getInstance();
		const sessions = await db.execute((d) =>
			d
				.select()
				.from(telegramSessions)
				.where(
					and(
						eq(telegramSessions.status, SessionStatus.ACTIVE),
						eq(telegramSessions.server_name, serverName),
					),
				),
		);

		for (const session of sessions) {
			try {
				const client = await TelegramClientService.initialize(
					session.session_id,
				);
				TelegramClientService.addToPool(
					session.session_id,
					client,
					session.telegram_user_id,
				);
			} catch (error) {
				console.error(`Failed to restore session id=${session.id}:`, error);
			}
		}

		console.log(
			`Session restore complete: ${TelegramClientService.pool.size}/${sessions.length} restored`,
		);
	}

	// ── Static: Private Helpers ────────────────────────────────────────

	private static startEventHandler(
		sessionId: string,
		client: TelegramClientService,
		telegramUserId: string,
	): void {
		const handler = new EventHandler(
			client.getClient(),
			telegramUserId,
			sessionId,
		);
		TelegramClientService.eventHandlers.set(sessionId, handler);

		handler.start().catch((error) => {
			console.error(
				`Failed to start event handler for user ${telegramUserId}:`,
				error,
			);
		});
	}

	private static stopEventHandler(sessionId: string): void {
		const handler = TelegramClientService.eventHandlers.get(sessionId);
		if (handler) {
			handler.stop();
			TelegramClientService.eventHandlers.delete(sessionId);
		}
	}

	// ── Instance Methods ───────────────────────────────────────────────

	async connect(): Promise<void> {
		await this.client.connect();
	}

	async destroy(): Promise<void> {
		await this.client.destroy();
	}

	getClient(): TelegramClient {
		return this.client;
	}

	/**
	 * Captures and persists a message this session just sent (via SendMessage /
	 * SendMedia / SendMultiMedia) by routing the RPC response through the
	 * session's event handler. No-op when the session has no active handler
	 * (e.g. a transient, non-pooled client) — such sessions don't forward.
	 */
	async captureSentResult(
		result: unknown,
		context: SentMessageContext,
	): Promise<void> {
		const handler = TelegramClientService.eventHandlers.get(this.sessionId);
		if (handler) {
			await handler.captureSentResult(result, context);
		}
	}

	getSession(): string {
		return (this.client.session as StringSession).save();
	}
}
