import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { BaseRoute } from "../BaseRoute";
import { SuccessResponse, ErrorResponse } from "../../http/ApiResponse";
import { DatabaseClient } from "../../database/DatabaseClient";
import { TelegramClientService } from "../../telegram/TelegramClientService";
import { SessionStatus } from "../../database/constants/SessionStatus";
import { ServerAuthMiddleware } from "../../http/middleware/ServerAuthMiddleware";

export class ServerRoute extends BaseRoute {
	async register(fastify: FastifyInstance): Promise<void> {
		/**
		 * Returns HTTP 200 with a simple OK payload.
		 * Intentionally kept outside the protected scope — no api-key required
		 * so that load balancer health probes never need credentials.
		 */
		fastify.get(
			"/health",
			async (_request: FastifyRequest, reply: FastifyReply) => {
				new SuccessResponse({ status: "ok" }, "Server is healthy").send(reply);
			},
		);

		/**
		 * Protected scope — all routes registered inside here require a valid
		 * `api-key` header matching the APPLICATION_API_KEY environment variable.
		 */
		fastify.register(async (protected_: FastifyInstance) => {
			protected_.addHook("onRequest", new ServerAuthMiddleware().handle);

			/**
			 * Returns server-wide runtime statistics.
			 */
			protected_.get(
				"/server/GetStatistics",
				async (_request: FastifyRequest, reply: FastifyReply) => {
					const serverName = process.env.SERVER_NAME ?? "";
					if (!serverName) {
						return new ErrorResponse(
							"SERVER_NAME is not configured on this server",
							500,
						).send(reply);
					}

					try {
						const db = DatabaseClient.getInstance();

						const activeSessions = await db.execute<number>((prisma) =>
							prisma.telegramSession.count({
								where: {
									status: SessionStatus.ACTIVE,
									server_name: serverName,
								},
							}),
						);

						new SuccessResponse(
							{
								poolSize: TelegramClientService.getPooledSessionIds().length,
								activeSessions,
							},
							"Statistics retrieved successfully",
						).send(reply);
					} catch (error: unknown) {
						ErrorResponse.fromError(error, 500).send(reply);
					}
				},
			);
		}); // end protected scope
	}
}
