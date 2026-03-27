import { FastifyReply, FastifyRequest } from "fastify";
import { BaseMiddleware } from "./BaseMiddleware";
import { ErrorResponse } from "../ApiResponse";

/**
 * Validates the `api-key` request header against the
 * `APPLICATION_API_KEY` environment variable.
 *
 * Applied to protected server-management endpoints
 * (e.g. CreateTenant, GetStatistics) via a scoped Fastify hook.
 */
export class ServerAuthMiddleware extends BaseMiddleware {
	handle = async (
		request: FastifyRequest,
		reply: FastifyReply,
	): Promise<void> => {
		const apiKey = request.headers["api-key"] as string | undefined;
		const expectedKey = process.env.APPLICATION_API_KEY;

		if (!expectedKey) {
			return new ErrorResponse(
				"APPLICATION_API_KEY is not configured on this server",
				500,
			).send(reply);
		}

		if (!apiKey || apiKey !== expectedKey) {
			return new ErrorResponse("Unauthorized", 401).send(reply);
		}
	};
}
