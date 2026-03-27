import { FastifyInstance } from "fastify";
import { TelegramClientService } from "../telegram/TelegramClientService";
import { TelegramUtils } from "../telegram/TelegramUtils";

export abstract class BaseRoute {
	abstract register(fastify: FastifyInstance): Promise<void>;
	/**
	 * Resolves a Telegram client for the given session and executes the
	 * operation. Temporary (non-pooled) clients are destroyed after use;
	 * unauthorised sessions are invalidated automatically.
	 * Caution: Use this method for authorized sessions only (E.g send message, get user info, logout, etc.).
	 */
	protected async withTelegramSession<T>(
		sessionId: string,
		operation: (client: TelegramClientService) => Promise<T>,
	): Promise<T> {
		const isPooled = TelegramClientService.isPooled(sessionId);
		const client = await TelegramClientService.initialize(sessionId);
		try {
			return await operation(client);
		} catch (error: unknown) {
			if (TelegramUtils.isUnauthorized(error)) {
				await TelegramClientService.invalidate(sessionId);
			}
			throw error;
		} finally {
			if (!isPooled) await client.destroy();
		}
	}
}
