import { Api, TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { IncomingMessageHandler } from "./IncomingMessageHandler";
import { IncomingReactionHandler } from "./IncomingReactionHandler";
import { DatabaseClient } from "../database/DatabaseClient";
import { SessionStatus } from "../database/constants/SessionStatus";
import { TelegramClientInterface } from "./interface/Telegram";

interface TelegramSessionRecord {
	id: number;
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
	private static readonly messageHandlers = new Map<
		string,
		IncomingMessageHandler
	>();
	private static readonly reactionHandlers = new Map<
		string,
		IncomingReactionHandler
	>();

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
			TelegramClientService.startMessageHandler(
				sessionId,
				client,
				telegramUserId,
			);
			TelegramClientService.startReactionHandler(
				sessionId,
				client,
				telegramUserId,
			);
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
	 * Destroys a pooled client, stops its message handler,
	 * and deletes the session record from the database.
	 */
	static async invalidate(sessionId: string): Promise<void> {
		TelegramClientService.stopMessageHandler(sessionId);
		TelegramClientService.stopReactionHandler(sessionId);

		// Delete the session record from the database
		await DatabaseClient.getInstance().execute((prisma) =>
			prisma.telegramSession.deleteMany({
				where: { session_id: sessionId },
			}),
		);

		if (TelegramClientService.isPooled(sessionId)) {
			// Destroy the client from the pool and remove it from the pool
			const client = TelegramClientService.pool.get(
				sessionId,
			) as TelegramClientService;

			try {
				await client.getClient().invoke(new Api.auth.LogOut({}));
				await client.destroy();
			} catch {
				// Client may already be in a broken state; ignore destroy errors
			}
			TelegramClientService.pool.delete(sessionId);
		}
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
		const sessions = await db.execute<TelegramSessionRecord[]>((prisma) =>
			prisma.telegramSession.findMany({
				where: {
					status: SessionStatus.ACTIVE,
					server_name: serverName,
				},
			}),
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

	private static startMessageHandler(
		sessionId: string,
		client: TelegramClientService,
		telegramUserId: string,
	): void {
		const handler = new IncomingMessageHandler(
			client.getClient(),
			telegramUserId,
			sessionId,
		);
		TelegramClientService.messageHandlers.set(sessionId, handler);

		handler.start().catch((error) => {
			console.error(
				`Failed to start message handler for user ${telegramUserId}:`,
				error,
			);
		});
	}

	private static stopMessageHandler(sessionId: string): void {
		const handler = TelegramClientService.messageHandlers.get(sessionId);
		if (handler) {
			handler.stop();
			TelegramClientService.messageHandlers.delete(sessionId);
		}
	}

	private static startReactionHandler(
		sessionId: string,
		client: TelegramClientService,
		telegramUserId: string,
	): void {
		const handler = new IncomingReactionHandler(
			client.getClient(),
			telegramUserId,
		);
		TelegramClientService.reactionHandlers.set(sessionId, handler);
		handler.start();
	}

	private static stopReactionHandler(sessionId: string): void {
		const handler = TelegramClientService.reactionHandlers.get(sessionId);
		if (handler) {
			handler.stop();
			TelegramClientService.reactionHandlers.delete(sessionId);
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

	getSession(): string {
		return (this.client.session as StringSession).save();
	}
}
