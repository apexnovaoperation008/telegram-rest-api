import Fastify, {
	FastifyError,
	FastifyInstance,
	FastifyReply,
	FastifyRequest,
} from "fastify";
import { BaseRoute } from "./routes/BaseRoute";
import { BaseMiddleware } from "./http/middleware/BaseMiddleware";
import { ErrorResponse } from "./http/ApiResponse";

export class Application {
	private readonly server: FastifyInstance;
	private authMiddleware: BaseMiddleware | null = null;

	constructor() {
		this.server = Fastify({ logger: true });
		this.registerErrorHandlers();
	}

	private registerErrorHandlers(): void {
		this.server.setNotFoundHandler(
			(_request: FastifyRequest, reply: FastifyReply) => {
				new ErrorResponse("Route not found", 404).send(reply);
			},
		);

		this.server.setErrorHandler(
			(error: FastifyError, _request: FastifyRequest, reply: FastifyReply) => {
				const statusCode = error.statusCode ?? 500;
				const message =
					statusCode >= 500 ? "Internal Server Error" : error.message;
				new ErrorResponse(message, statusCode).send(reply);
			},
		);
	}

	/**
	 * Stores the auth middleware to be applied to authenticated route scopes.
	 * Must be called before `registerRoutes`.
	 */
	registerMiddleware(middleware: BaseMiddleware): this {
		this.authMiddleware = middleware;
		return this;
	}

	/**
	 * Registers routes without any authentication middleware.
	 * Use for public endpoints (e.g. health check).
	 */
	registerPublicRoutes(routes: BaseRoute[]): this {
		this.server.register(async (fastify: FastifyInstance) => {
			for (const route of routes) {
				await route.register(fastify);
			}
		});
		return this;
	}

	/**
	 * Registers routes inside an authenticated scope.
	 * The auth middleware is applied as an `onRequest` hook scoped only
	 * to these routes — public routes registered via `registerPublicRoutes`
	 * are not affected.
	 */
	registerRoutes(routes: BaseRoute[]): this {
		const middleware = this.authMiddleware;
		this.server.register(async (fastify: FastifyInstance) => {
			if (middleware) {
				fastify.addHook("onRequest", middleware.handle);
			}
			for (const route of routes) {
				await route.register(fastify);
			}
		});
		return this;
	}

	async start(port: number, host = "0.0.0.0"): Promise<void> {
		await this.server.listen({ port, host });
	}
}
