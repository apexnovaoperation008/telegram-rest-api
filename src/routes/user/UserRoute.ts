import { Api } from "telegram";
import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { BaseRoute } from "../BaseRoute";
import { SuccessResponse, ErrorResponse } from "../../http/ApiResponse";
import { MediaFileService } from "../../services/MediaFileService";
/**
 * All routes require a valid session ID.
 * The session ID identifies the user and authorises the operation.
 */
export class UserRoute extends BaseRoute {

	async register(fastify: FastifyInstance): Promise<void> {
		/**
		 * Fetches a full user by their ID.
		 * @param request - The request object
		 * @param reply - The reply object
		 * @returns The response object
		 */
		fastify.post(
			"/users/GetFullUser",
			async (request: FastifyRequest, reply: FastifyReply) => {
				const { sessionId, id } = request.body as {
					sessionId: string;
					id: string;
				};

				if (!sessionId || !id) {
					return new ErrorResponse("sessionId and id are required", 400).send(
						reply,
					);
				}

			try {
				const result = await this.withTelegramSession(
					sessionId,
					async (client) => {
						const userFull = await client
							.getClient()
							.invoke(new Api.users.GetFullUser({ id }));

						const data: Record<string, unknown> = JSON.parse(
							JSON.stringify(userFull, (_, v) =>
								typeof v === "bigint" ? v.toString() : v,
							),
						);

						const userEntity = userFull.users.find(
							(u: Api.TypeUser): u is Api.User => u instanceof Api.User,
						);

						let avatarUrl: string | null = null;
						if (
							userEntity &&
							userEntity.photo instanceof Api.UserProfilePhoto
						) {
							avatarUrl = await MediaFileService.downloadUserPhoto(
								client.getClient(),
								userEntity.id.toString(),
								userEntity.accessHash!.toString(),
								userEntity.photo,
							).catch((err) => {
								console.error(
									"[GetFullUser] Avatar download failed:",
									err instanceof Error ? err.message : err,
								);
								return null;
							});
						}

						const usersArray = data.users as Array<Record<string, unknown>>;
						for (const entry of usersArray) {
							entry.avatar_url = null;
						}
						const userEntry = usersArray.find(
							(u: Record<string, unknown>) => String(u.id) === String(userEntity?.id),
						);
						if (userEntry) {
							userEntry.avatar_url = avatarUrl;
						}

						return data;
					},
				);

				new SuccessResponse([result], "User fetched successfully").send(reply);
			} catch (error: unknown) {
				ErrorResponse.fromError(error).send(reply);
			}
			},
		);

		/**
		 * Returns basic user info according to their identifiers ids or usernames.
		 * @param request - The request object
		 * @param reply - The reply object
		 * @returns The response object
		 */
		fastify.post(
			"/users/GetUsers",
			async (request: FastifyRequest, reply: FastifyReply) => {
				const { sessionId, id } = request.body as {
					sessionId: string;
					id: string[];
				};

				if (!sessionId || !id?.length) {
					return new ErrorResponse("sessionId and id are required", 400).send(
						reply,
					);
				}

			try {
				const result = await this.withTelegramSession(
					sessionId,
					async (client) => {
						const users = await client
							.getClient()
							.invoke(new Api.users.GetUsers({ id }));

						const data: Array<Record<string, unknown>> = JSON.parse(
							JSON.stringify(users, (_, v) =>
								typeof v === "bigint" ? v.toString() : v,
							),
						);

						for (const entry of data) {
							entry.avatar_url = null;
						}

						await Promise.all(
							users.map(async (u: Api.TypeUser, i: number) => {
								if (!(u instanceof Api.User)) return;
								if (!(u.photo instanceof Api.UserProfilePhoto)) return;

								data[i].avatar_url = await MediaFileService.downloadUserPhoto(
									client.getClient(),
									u.id.toString(),
									u.accessHash!.toString(),
									u.photo,
								).catch((err) => {
									console.error(
										"[GetUsers] Avatar download failed:",
										err instanceof Error ? err.message : err,
									);
									return null;
								});
							}),
						);

						return data;
					},
				);

				new SuccessResponse(result, "Users fetched successfully").send(reply);
			} catch (error: unknown) {
				ErrorResponse.fromError(error).send(reply);
			}
			},
		);
	}
}
