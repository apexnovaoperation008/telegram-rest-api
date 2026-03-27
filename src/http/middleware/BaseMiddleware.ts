import { FastifyReply, FastifyRequest } from "fastify";

export abstract class BaseMiddleware {
	abstract handle(
		request: FastifyRequest,
		reply: FastifyReply,
	): Promise<void>;
}
