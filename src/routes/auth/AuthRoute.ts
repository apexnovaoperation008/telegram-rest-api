import { Api } from "telegram";
import { computeCheck } from "telegram/Password";
import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { BaseRoute } from "../BaseRoute";
import { SuccessResponse, ErrorResponse } from "../../http/ApiResponse";
import { TelegramClientService } from "../../telegram/TelegramClientService";
import { DatabaseClient } from "../../database/DatabaseClient";
import { SessionStatus } from "../../database/constants/SessionStatus";

/**
 * Force telegram session to destroy after each request to avoid memory leaks
 * Only successfully signed in accounts are added to the pool
 */
export class AuthRoute extends BaseRoute {
	/**
	 * Saves an authenticated Telegram session to the database and adds
	 * a fresh client to the session pool. Destroys the handshake client
	 * before creating the pool-safe replacement.
	 */
	private async saveSession(
		authClient: TelegramClientService,
		user: Api.User,
		callbackUrl: string,
	): Promise<void> {
		const sessionId = authClient.getSession();
		const telegramUserId = user.id.toString();
		const serverName = process.env.SERVER_NAME ?? "";

		await DatabaseClient.getInstance().execute((prisma) =>
			prisma.telegramSession.create({
				data: {
					session_id: sessionId,
					telegram_user_id: telegramUserId,
					telegram_username: user.username ?? "",
					telegram_access_hash: user.accessHash?.toString() ?? "",
					server_name: serverName,
					callback_url: callbackUrl,
					status: SessionStatus.ACTIVE,
				},
			}),
		);

		await authClient.destroy();

		const freshClient = await TelegramClientService.initialize(sessionId);
		// Add the authenticated session to the pool
		TelegramClientService.addToPool(sessionId, freshClient, telegramUserId);
	}

	async register(fastify: FastifyInstance): Promise<void> {
		/**
		 * Sends a one-time verification code to the given phone number (Telegram login flow).
		 * This is the first step in the authentication process.
		 * @param request - The request object
		 * @param reply - The reply object
		 * @returns The response object
		 */
		fastify.post(
			"/auth/SendCode",
			async (request: FastifyRequest, reply: FastifyReply) => {
				const { phoneNumber } = request.body as { phoneNumber: string };

				if (!phoneNumber) {
					return new ErrorResponse("phoneNumber is required", 400).send(reply);
				}

				const telegram = await TelegramClientService.initialize();

				try {
					const result = await telegram.getClient().invoke(
						new Api.auth.SendCode({
							phoneNumber,
							apiId: parseInt(process.env.TELEGRAM_API_ID ?? "", 10),
							apiHash: process.env.TELEGRAM_API_HASH ?? "",
							settings: new Api.CodeSettings({}),
						}),
					);

					new SuccessResponse(
						{
							phoneCodeHash: result.phoneCodeHash,
							sessionId: telegram.getSession(),
						},
						"Verification code sent",
					).send(reply);
				} catch (error: unknown) {
					ErrorResponse.fromError(error).send(reply);
				} finally {
					await telegram.destroy();
				}
			},
		);

		/**
		 * Resend the login code via another medium,
		 * the phone code type is determined by the return value of the previous auth.sendCode/auth.resendCode
		 * The session code must be the same as the one used in the send-code route.
		 * @param request - The request object
		 * @param reply - The reply object
		 * @returns The response object
		 */
		fastify.post(
			"/auth/ResendCode",
			async (request: FastifyRequest, reply: FastifyReply) => {
				const { phoneNumber, phoneCodeHash, sessionId } = request.body as {
					phoneNumber: string;
					phoneCodeHash: string;
					sessionId: string;
				};

				if (!phoneNumber) {
					return new ErrorResponse("phoneNumber is required", 400).send(reply);
				}

				// Initialize the Telegram client with the session code that was sent in send-code route
				const telegram = await TelegramClientService.initialize(sessionId);

				try {
					const result = await telegram.getClient().invoke(
						new Api.auth.ResendCode({
							phoneNumber: phoneNumber,
							phoneCodeHash: phoneCodeHash,
						}),
					);

					new SuccessResponse(
						{ result, sessionId },
						"Verification code resent",
					).send(reply);
				} catch (error: unknown) {
					ErrorResponse.fromError(error).send(reply);
				} finally {
					await telegram.destroy();
				}
			},
		);

		/**
		 * Signs in a user with a validated phone number.
		 * Inherits the session code from the send-code route.
		 * @param request - The request object
		 * @param reply - The reply object
		 * @returns The response object
		 */
		fastify.post(
			"/auth/SignIn",
			async (request: FastifyRequest, reply: FastifyReply) => {
				const { phoneNumber, phoneCodeHash, phoneCode, sessionId, callbackUrl } =
					request.body as {
						phoneNumber: string;
						phoneCodeHash: string;
						phoneCode: string;
						sessionId: string;
						callbackUrl: string;
					};

				if (!phoneNumber || !phoneCodeHash || !phoneCode || !sessionId || !callbackUrl) {
					return new ErrorResponse(
						"phoneNumber, phoneCodeHash, phoneCode, sessionId, and callbackUrl are required",
						400,
					).send(reply);
				}

				// Initialize the Telegram client with the session code that was sent in send-code route
				const telegram = await TelegramClientService.initialize(sessionId);

				try {
					const result = await telegram.getClient().invoke(
						new Api.auth.SignIn({
							phoneNumber: phoneNumber,
							phoneCode: phoneCode,
							phoneCodeHash: phoneCodeHash,
						}),
					);

					const activeSessionId = telegram.getSession();
					await this.saveSession(telegram, result.user as Api.User, callbackUrl);

					new SuccessResponse(
						{ result, sessionId: activeSessionId },
						"Signed in successfully",
					).send(reply);
				} catch (error: unknown) {
					await telegram.destroy();
					ErrorResponse.fromError(error).send(reply);
				}
			},
		);

		/**
		 * Registers a validated phone number in the system.
		 * Inherits the session code from the send-code route.
		 * @param request - The request object
		 * @param reply - The reply object
		 * @returns The response object
		 */
		fastify.post(
			"/auth/SignUp",
			async (request: FastifyRequest, reply: FastifyReply) => {
				const { phoneNumber, phoneCodeHash, firstName, lastName, sessionId, callbackUrl } =
					request.body as {
						phoneNumber: string;
						phoneCodeHash: string;
						firstName: string;
						lastName: string;
						sessionId: string;
						callbackUrl: string;
					};

				if (!phoneNumber || !phoneCodeHash || !firstName || !sessionId || !callbackUrl) {
					return new ErrorResponse(
						"phoneNumber, phoneCodeHash, firstName, sessionId, and callbackUrl are required",
						400,
					).send(reply);
				}

				const telegram = await TelegramClientService.initialize(sessionId);

				try {
					const result = await telegram.getClient().invoke(
						new Api.auth.SignUp({
							phoneNumber,
							phoneCodeHash,
							firstName,
							lastName: lastName ?? "",
						}),
					);

					const activeSessionId = telegram.getSession();
					await this.saveSession(telegram, result.user as Api.User, callbackUrl);

					new SuccessResponse(
						{ result, sessionId: activeSessionId },
						"Signed up successfully",
					).send(reply);
				} catch (error: unknown) {
					await telegram.destroy();
					ErrorResponse.fromError(error).send(reply);
				}
			},
		);

		/**
		 * Terminates the current session.
		 * The current session must be authorized.
		 * @param request - The request object
		 * @param reply - The reply object
		 * @returns The response object
		 */
		fastify.post(
			"/auth/LogOut",
			async (request: FastifyRequest, reply: FastifyReply) => {
				const { sessionId } = request.body as { sessionId: string };

				if (!sessionId) {
					return new ErrorResponse("sessionId is required", 400).send(reply);
				}

				try {
					// Explicit invalidate on success: removes from pool and deletes DB record.
					await TelegramClientService.invalidate(sessionId);

					new SuccessResponse({}, "Logged out successfully").send(reply);
				} catch (error: unknown) {
					ErrorResponse.fromError(error).send(reply);
				}
			},
		);

		fastify.post(
			"/auth/TwoFactorAuth",
			async (request: FastifyRequest, reply: FastifyReply) => {
				const { sessionId, password, callbackUrl } = request.body as {
					sessionId: string;
					password: string;
					callbackUrl: string;
				};

				if (!sessionId || !callbackUrl) {
					return new ErrorResponse("sessionId and callbackUrl are required", 400).send(reply);
				}

				const telegram = await TelegramClientService.initialize(sessionId);

				try {
					const passwordSrp = await telegram
						.getClient()
						.invoke(new Api.account.GetPassword());

					const passwordCheck = await computeCheck(passwordSrp, password);

					const result = await telegram.getClient().invoke(
						new Api.auth.CheckPassword({
							password: passwordCheck,
						}),
					);
					await this.saveSession(telegram, result.user as Api.User, callbackUrl);

					new SuccessResponse(
						{ result, sessionId },
						"Two-factor authentication successful",
					).send(reply);
				} catch (error: unknown) {
					await telegram.destroy();
					ErrorResponse.fromError(error).send(reply);
				}
			},
		);
	}
}
