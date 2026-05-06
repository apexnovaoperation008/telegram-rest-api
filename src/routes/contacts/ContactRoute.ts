import { Api } from "telegram";
import bigInt from "big-integer";
import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { BaseRoute } from "../BaseRoute";
import { SuccessResponse, ErrorResponse } from "../../http/ApiResponse";

export class ContactRoute extends BaseRoute {
	async register(fastify: FastifyInstance): Promise<void> {
		/**
		 * Adds an existing Telegram user as a contact.
		 */
		fastify.post(
			"/contacts/AddContact",
			async (request: FastifyRequest, reply: FastifyReply) => {
				const {
					sessionId,
					id,
					firstName,
					lastName = "",
					phone = "",
					addPhonePrivacyException = false,
				} = request.body as {
					sessionId: string;
					id: string;
					firstName: string;
					lastName?: string;
					phone?: string;
					addPhonePrivacyException?: boolean;
				};

				if (!sessionId || !id || !firstName) {
					return new ErrorResponse(
						"sessionId, id and firstName are required",
						400,
					).send(reply);
				}

				try {
					const result = await this.withTelegramSession(
						sessionId,
						async (client) => {
							const tc = client.getClient();

							let resolvedUser: Awaited<
								ReturnType<typeof tc.getInputEntity>
							>;
							try {
								resolvedUser = await tc.getInputEntity(id);
							} catch {
								await tc.getDialogs({ limit: 200 });
								resolvedUser = await tc.getInputEntity(id);
							}

							return tc.invoke(
								new Api.contacts.AddContact({
									id: resolvedUser,
									firstName,
									lastName,
									phone,
									addPhonePrivacyException,
								}),
							);
						},
					);

					new SuccessResponse(result, "Contact added successfully").send(
						reply,
					);
				} catch (error: unknown) {
					ErrorResponse.fromError(error).send(reply);
				}
			},
		);

		/**
		 * Deletes several contacts from the contact list by their user IDs.
		 */
		fastify.post(
			"/contacts/DeleteContacts",
			async (request: FastifyRequest, reply: FastifyReply) => {
				const { sessionId, id } = request.body as {
					sessionId: string;
					id: string[];
				};

				if (!sessionId || !id?.length) {
					return new ErrorResponse(
						"sessionId and id are required",
						400,
					).send(reply);
				}

				try {
					const result = await this.withTelegramSession(
						sessionId,
						async (client) => {
							const tc = client.getClient();

							const resolvedUsers = await Promise.all(
								id.map(async (userId) => {
									try {
										return await tc.getInputEntity(userId);
									} catch {
										await tc.getDialogs({ limit: 200 });
										return tc.getInputEntity(userId);
									}
								}),
							);

							return tc.invoke(
								new Api.contacts.DeleteContacts({
									id: resolvedUsers,
								}),
							);
						},
					);

					new SuccessResponse(
						result,
						"Contacts deleted successfully",
					).send(reply);
				} catch (error: unknown) {
					ErrorResponse.fromError(error).send(reply);
				}
			},
		);

		/**
		 * Returns the current user's contact list.
		 */
		fastify.post(
			"/contacts/GetContacts",
			async (request: FastifyRequest, reply: FastifyReply) => {
				const { sessionId } = request.body as {
					sessionId: string;
				};

				if (!sessionId) {
					return new ErrorResponse("sessionId is required", 400).send(
						reply,
					);
				}

				try {
					const result = await this.withTelegramSession(
						sessionId,
						(client) =>
							client.getClient().invoke(
								new Api.contacts.GetContacts({
									hash: bigInt(0), // Telling telegram that we do not have cached contacts
								}),
							),
					);

					new SuccessResponse(
						result,
						"Contacts fetched successfully",
					).send(reply);
				} catch (error: unknown) {
					ErrorResponse.fromError(error).send(reply);
				}
			},
		);

		/**
		 * Resolves a phone number to get user info, if their privacy settings allow it.
		 * Phone should be in international format (e.g. "+1234567890").
		 */
		fastify.post(
			"/contacts/ResolvePhone",
			async (request: FastifyRequest, reply: FastifyReply) => {
				const { sessionId, phone } = request.body as {
					sessionId: string;
					phone: string;
				};

				if (!sessionId || !phone) {
					return new ErrorResponse(
						"sessionId and phone are required",
						400,
					).send(reply);
				}

				try {
					const result = await this.withTelegramSession(
						sessionId,
						(client) =>
							client.getClient().invoke(
								new Api.contacts.ResolvePhone({ phone }),
							),
					);

					new SuccessResponse(
						result,
						"Phone resolved successfully",
					).send(reply);
				} catch (error: unknown) {
					ErrorResponse.fromError(error).send(reply);
				}
			},
		);

		/**
		 * Resolves a @username to get peer info.
		 * Pass the username without the leading "@".
		 */
		fastify.post(
			"/contacts/ResolveUsername",
			async (request: FastifyRequest, reply: FastifyReply) => {
				const { sessionId, username } = request.body as {
					sessionId: string;
					username: string;
				};

				if (!sessionId || !username) {
					return new ErrorResponse(
						"sessionId and username are required",
						400,
					).send(reply);
				}

				try {
					const result = await this.withTelegramSession(
						sessionId,
						(client) =>
							client.getClient().invoke(
								new Api.contacts.ResolveUsername({ username }),
							),
					);

					new SuccessResponse(
						result,
						"Username resolved successfully",
					).send(reply);
				} catch (error: unknown) {
					ErrorResponse.fromError(error).send(reply);
				}
			},
		);
	}
}
