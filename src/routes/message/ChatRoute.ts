import { Api, TelegramClient } from "telegram";
import bigInt from "big-integer";
import { CustomFile } from "telegram/client/uploads";
import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { BaseRoute } from "../BaseRoute";
import { SuccessResponse, ErrorResponse } from "../../http/ApiResponse";
import { TelegramUtils } from "../../telegram/TelegramUtils";
import { MediaFileService } from "../../services/MediaFileService";

export class ChatRoute extends BaseRoute {
	/**
	 * Builds an InputPeer for a basic group or channel/supergroup.
	 * Pass `accessHash` for channels; when omitted it is resolved via getEntity.
	 */
	private async resolveChatPeer(
		client: TelegramClient,
		chatId: string,
		accessHash?: string,
	): Promise<Api.TypeInputPeer> {
		if (accessHash) {
			return new Api.InputPeerChannel({
				channelId: bigInt(chatId),
				accessHash: bigInt(accessHash),
			});
		}

		const entity = await client.getEntity(bigInt(chatId));

		if (entity instanceof Api.Channel) {
			if (!entity.accessHash) {
				throw new Error(
					`Channel ${chatId} has no accessHash — pass accessHash or ensure the session has access`,
				);
			}
			return new Api.InputPeerChannel({
				channelId: entity.id,
				accessHash: entity.accessHash,
			});
		}

		if (entity instanceof Api.Chat) {
			return new Api.InputPeerChat({ chatId: entity.id });
		}

		throw new Error(
			`Entity ${chatId} is not a group or channel (got ${entity.className})`,
		);
	}

	async register(fastify: FastifyInstance): Promise<void> {
		/**
		 * Fetches a page of dialogs using Telegram's native cursor-based pagination.
		 * Each response includes a `nextCursor` — pass it back verbatim to fetch
		 * the next page. When `nextCursor` is null there are no more pages.
		 *
		 * First request: omit offsetDate / offsetId (they default to 0).
		 * Subsequent requests: pass `offsetDate` and `offsetId` from the
		 * previous response's `nextCursor`.
		 */
		fastify.post(
			"/chats/GetDialogs",
			async (request: FastifyRequest, reply: FastifyReply) => {
				const {
					sessionId,
					limit = 20,
					excludePinned = false,
					folderId,
					offsetDate = 0,
					offsetId = 0,
				} = request.body as {
					sessionId: string;
					limit?: number;
					excludePinned?: boolean;
					folderId?: number;
					offsetDate?: number;
					offsetId?: number;
				};

				if (!sessionId) {
					return new ErrorResponse("sessionId is required", 400).send(reply);
				}

				try {
					const data = await this.withTelegramSession(
						sessionId,
						async (client) => {
							const result = await client.getClient().invoke(
								new Api.messages.GetDialogs({
									offsetDate,
									offsetId,
									offsetPeer: new Api.InputPeerEmpty(),
									limit,
									hash: bigInt(0),
									excludePinned,
									...(folderId !== undefined && { folderId }),
								}),
							);

							// DialogsNotModified has no dialogs — return empty
							if (!("dialogs" in result)) {
								return {
									dialogs: [],
									messages: [],
									chats: [],
									users: [],
									count: 0,
									nextCursor: null,
								};
							}

							const { dialogs, messages, chats, users } = result;
							const count = "count" in result ? result.count : dialogs.length;

							// Build next cursor from the last dialog's top message
							let nextCursor: { offsetDate: number; offsetId: number } | null =
								null;
							const lastDialog = dialogs[dialogs.length - 1];
							if (
								dialogs.length === limit &&
								lastDialog &&
								"topMessage" in lastDialog
							) {
								const topMsgId = lastDialog.topMessage;
								const lastMsg = messages.find(
									(m: Api.TypeMessage): m is Api.Message =>
										m instanceof Api.Message && m.id === topMsgId,
								);
								if (lastMsg) {
									nextCursor = {
										offsetDate: lastMsg.date,
										offsetId: lastMsg.id,
									};
								}
							}

							return { dialogs, messages, chats, users, count, nextCursor };
						},
					);

					new SuccessResponse(data, "Dialogs fetched successfully").send(reply);
				} catch (error: unknown) {
					ErrorResponse.fromError(error).send(reply);
				}
			},
		);

		/**
		 * Fetches basic group chats by their IDs (className === "Chat").
		 * Does NOT work for supergroups or channels — use /chats/GetChannels for those.
		 */
		fastify.post(
			"/chats/GetChats",
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
					const result = await this.withTelegramSession(sessionId, (client) =>
						client.getClient().invoke(
							new Api.messages.GetChats({
								id: id.map((x) => bigInt(x)),
							}),
						),
					);

					new SuccessResponse(result, "Chats fetched successfully").send(reply);
				} catch (error: unknown) {
					ErrorResponse.fromError(error).send(reply);
				}
			},
		);

		/**
		 * Fetches full info for a basic group chat.
		 *
		 * Enhancements over the raw Telegram response:
		 *   - avatar_url: S3 public URL of the group photo
		 *     (null when the group has no photo set)
		 */
		fastify.post(
			"/chats/GetFullChat",
			async (request: FastifyRequest, reply: FastifyReply) => {
				const { sessionId, chatId } = request.body as {
					sessionId: string;
					chatId: string;
				};

				if (!sessionId || !chatId) {
					return new ErrorResponse(
						"sessionId and chatId are required",
						400,
					).send(reply);
				}

				try {
					const result = await this.withTelegramSession(
						sessionId,
						async (client) => {
							const chatFull = await client.getClient().invoke(
								new Api.messages.GetFullChat({
									chatId: bigInt(chatId),
								}),
							);

							const data: Record<string, unknown> = JSON.parse(
								JSON.stringify(chatFull, (_, v) =>
									typeof v === "bigint" ? v.toString() : v,
								),
							);

							const chatInfo = chatFull.chats.find(
								(c: Api.TypeChat): c is Api.Chat =>
									c instanceof Api.Chat && c.id.toString() === chatId,
							);

							let avatarUrl: string | null = null;
							if (chatInfo?.photo instanceof Api.ChatPhoto) {
								avatarUrl = await MediaFileService.downloadChatPhoto(
									client.getClient(),
									chatId,
									chatInfo.photo,
								).catch((err) => {
									console.error(
										"[GetFullChat] Avatar download failed:",
										err instanceof Error ? err.message : err,
									);
									return null;
								});
							}

							// Inject avatar_url into the matching chats[] entry so it sits
							// alongside the photo field in the original payload structure.
							const chatsArray = data.chats as Array<Record<string, unknown>>;
							const chatEntry = chatsArray.find((c) => String(c.id) === chatId);
							if (chatEntry) {
								chatEntry.avatar_url = avatarUrl;
							}

							return data;
						},
					);

					new SuccessResponse(result, "Full chat fetched successfully").send(
						reply,
					);
				} catch (error: unknown) {
					ErrorResponse.fromError(error).send(reply);
				}
			},
		);

		/**
		 * Creates a new group chat and invites the specified users.
		 */
		fastify.post(
			"/chats/CreateChat",
			async (request: FastifyRequest, reply: FastifyReply) => {
				const { sessionId, users, title } = request.body as {
					sessionId: string;
					users: string[];
					title: string;
				};

				if (!sessionId || !users?.length || !title) {
					return new ErrorResponse(
						"sessionId, users and title are required",
						400,
					).send(reply);
				}

				try {
					const result = await this.withTelegramSession(sessionId, (client) =>
						client
							.getClient()
							.invoke(new Api.messages.CreateChat({ users, title })),
					);

					new SuccessResponse(result, "Chat created successfully").send(reply);
				} catch (error: unknown) {
					ErrorResponse.fromError(error).send(reply);
				}
			},
		);

		/**
		 * Deletes a chat, or removes a specific user from a chat.
		 * Pass `userId` to remove only that user; omit it to delete the chat entirely.
		 */
		fastify.post(
			"/chats/DeleteChat",
			async (request: FastifyRequest, reply: FastifyReply) => {
				const { sessionId, chatId, userId, revokeHistory } = request.body as {
					sessionId: string;
					chatId: string;
					userId?: string;
					revokeHistory?: boolean;
				};

				if (!sessionId || !chatId) {
					return new ErrorResponse(
						"sessionId and chatId are required",
						400,
					).send(reply);
				}

				try {
					const result = await this.withTelegramSession(sessionId, (client) =>
						client.getClient().invoke(
							new Api.messages.DeleteChat({
								chatId: bigInt(chatId),
							}),
						),
					);

					new SuccessResponse(result, "Chat deleted successfully").send(reply);
				} catch (error: unknown) {
					ErrorResponse.fromError(error).send(reply);
				}
			},
		);

		/**
		 * Deletes a chat, or removes a specific user from a chat.
		 * Pass `userId` to remove only that user; omit it to delete the chat entirely.
		 */
		fastify.post(
			"/chats/DeleteChatUser",
			async (request: FastifyRequest, reply: FastifyReply) => {
				const { sessionId, chatId, userId, revokeHistory } = request.body as {
					sessionId: string;
					chatId: string;
					userId?: string;
					revokeHistory?: boolean;
				};

				if (!sessionId || !chatId || !userId) {
					return new ErrorResponse(
						"sessionId, chatId and userId are required",
						400,
					).send(reply);
				}

				try {
					const result = await this.withTelegramSession(sessionId, (client) =>
						client.getClient().invoke(
							new Api.messages.DeleteChatUser({
								chatId: bigInt(chatId),
								userId: userId,
								revokeHistory: revokeHistory,
							}),
						),
					);

					new SuccessResponse(
						result,
						"User deleted from chat successfully",
					).send(reply);
				} catch (error: unknown) {
					ErrorResponse.fromError(error).send(reply);
				}
			},
		);

		/**
		 * Grants or revokes admin rights for a user in a basic group chat.
		 */
		fastify.post(
			"/chats/EditChatAdmin",
			async (request: FastifyRequest, reply: FastifyReply) => {
				const { sessionId, chatId, userId, isAdmin } = request.body as {
					sessionId: string;
					chatId: string;
					userId: string;
					isAdmin: boolean;
				};

				if (!sessionId || !chatId || !userId || isAdmin === undefined) {
					return new ErrorResponse(
						"sessionId, chatId, userId and isAdmin are required",
						400,
					).send(reply);
				}

				try {
					const result = await this.withTelegramSession(sessionId, (client) =>
						client.getClient().invoke(
							new Api.messages.EditChatAdmin({
								chatId: bigInt(chatId),
								userId,
								isAdmin,
							}),
						),
					);

					new SuccessResponse(
						result,
						"Chat admin rights updated successfully",
					).send(reply);
				} catch (error: unknown) {
					ErrorResponse.fromError(error).send(reply);
				}
			},
		);

		/**
		 * Updates the default banned rights for all members of a chat or channel.
		 * All `bannedRights` flags are optional and default to false (no restriction).
		 */
		fastify.post(
			"/chats/EditChatDefaultBannedRights",
			async (request: FastifyRequest, reply: FastifyReply) => {
				const {
					sessionId,
					chatId,
					bannedRights: {
						viewMessages = false,
						sendMessages = false,
						sendMedia = false,
						sendStickers = false,
						sendGifs = false,
						sendGames = false,
						sendInline = false,
						sendPolls = false,
						changeInfo = false,
						inviteUsers = false,
						pinMessages = false,
					} = {},
				} = request.body as {
					sessionId: string;
					chatId: string;
					bannedRights?: {
						viewMessages?: boolean;
						sendMessages?: boolean;
						sendMedia?: boolean;
						sendStickers?: boolean;
						sendGifs?: boolean;
						sendGames?: boolean;
						sendInline?: boolean;
						sendPolls?: boolean;
						changeInfo?: boolean;
						inviteUsers?: boolean;
						pinMessages?: boolean;
					};
				};

				if (!sessionId || !chatId) {
					return new ErrorResponse(
						"sessionId and chatId are required",
						400,
					).send(reply);
				}

				try {
					const result = await this.withTelegramSession(sessionId, (client) =>
						client.getClient().invoke(
							new Api.messages.EditChatDefaultBannedRights({
								peer: new Api.InputPeerChat({ chatId: bigInt(chatId) }),
								bannedRights: new Api.ChatBannedRights({
									untilDate: 0,
									viewMessages,
									sendMessages,
									sendMedia,
									sendStickers,
									sendGifs,
									sendGames,
									sendInline,
									sendPolls,
									changeInfo,
									inviteUsers,
									pinMessages,
								}),
							}),
						),
					);

					new SuccessResponse(
						result,
						"Default banned rights updated successfully",
					).send(reply);
				} catch (error: unknown) {
					ErrorResponse.fromError(error).send(reply);
				}
			},
		);

		/**
		 * Changes the photo of a group chat.
		 * Provide `photoUrl` to set a new photo; omit it to remove the current photo.
		 */
		fastify.post(
			"/chats/EditChatPhoto",
			async (request: FastifyRequest, reply: FastifyReply) => {
				const { sessionId, chatId, photoUrl } = request.body as {
					sessionId: string;
					chatId: string;
					photoUrl?: string;
				};

				if (!sessionId || !chatId) {
					return new ErrorResponse(
						"sessionId and chatId are required",
						400,
					).send(reply);
				}

				try {
					const result = await this.withTelegramSession(
						sessionId,
						async (client) => {
							const tc = client.getClient();

							let photo: Api.TypeInputChatPhoto;
							if (photoUrl) {
								const { buffer, filename } =
									await TelegramUtils.downloadFromUrl(photoUrl);
								const uploadedFile = await tc.uploadFile({
									file: new CustomFile(filename, buffer.length, "", buffer),
									workers: 1,
								});
								photo = new Api.InputChatUploadedPhoto({ file: uploadedFile });
							} else {
								photo = new Api.InputChatPhotoEmpty();
							}

							return tc.invoke(
								new Api.messages.EditChatPhoto({
									chatId: bigInt(chatId),
									photo,
								}),
							);
						},
					);

					new SuccessResponse(result, "Chat photo updated successfully").send(
						reply,
					);
				} catch (error: unknown) {
					ErrorResponse.fromError(error).send(reply);
				}
			},
		);

		/**
		 * Changes the title of a group chat.
		 */
		fastify.post(
			"/chats/EditChatTitle",
			async (request: FastifyRequest, reply: FastifyReply) => {
				const { sessionId, chatId, title } = request.body as {
					sessionId: string;
					chatId: string;
					title: string;
				};

				if (!sessionId || !chatId || !title) {
					return new ErrorResponse(
						"sessionId, chatId and title are required",
						400,
					).send(reply);
				}

				try {
					const result = await this.withTelegramSession(sessionId, (client) =>
						client.getClient().invoke(
							new Api.messages.EditChatTitle({
								chatId: bigInt(chatId),
								title,
							}),
						),
					);

					new SuccessResponse(result, "Chat title updated successfully").send(
						reply,
					);
				} catch (error: unknown) {
					ErrorResponse.fromError(error).send(reply);
				}
			},
		);

		/**
		 * Generates an invite link for a basic group, supergroup, or channel.
		 * For supergroups/channels, pass `accessHash` or omit it to resolve from
		 * the session cache / Telegram API.
		 */
		fastify.post(
			"/chats/ExportChatInvite",
			async (request: FastifyRequest, reply: FastifyReply) => {
				const {
					sessionId,
					chatId,
					accessHash,
					legacyRevokePermanent,
					requestNeeded,
					expireDate,
					usageLimit,
					title,
				} = request.body as {
					sessionId: string;
					chatId: string;
					accessHash?: string;
					legacyRevokePermanent?: boolean;
					requestNeeded?: boolean;
					expireDate?: number;
					usageLimit?: number;
					title?: string;
				};

				if (!sessionId || !chatId) {
					return new ErrorResponse(
						"sessionId and chatId are required",
						400,
					).send(reply);
				}

				try {
					const result = await this.withTelegramSession(
						sessionId,
						async (client) => {
							const tc = client.getClient();
							const peer = await this.resolveChatPeer(tc, chatId, accessHash);

							return tc.invoke(
								new Api.messages.ExportChatInvite({
									peer,
									...(legacyRevokePermanent !== undefined && {
										legacyRevokePermanent,
									}),
									...(requestNeeded !== undefined && { requestNeeded }),
									...(expireDate !== undefined && { expireDate }),
									...(usageLimit !== undefined && { usageLimit }),
									...(title !== undefined && { title }),
								}),
							);
						},
					);

					new SuccessResponse(
						result,
						"Chat invite link generated successfully",
					).send(reply);
				} catch (error: unknown) {
					ErrorResponse.fromError(error).send(reply);
				}
			},
		);

		/**
		 * Lists exported invite links for a supergroup or channel.
		 * Basic groups only support a single link via ExportChatInvite.
		 */
		fastify.post(
			"/chats/GetExportedChatInvites",
			async (request: FastifyRequest, reply: FastifyReply) => {
				const {
					sessionId,
					chatId,
					accessHash,
					limit = 100,
					offsetDate = 0,
					offsetLink = "",
				} = request.body as {
					sessionId: string;
					chatId: string;
					accessHash?: string;
					limit?: number;
					offsetDate?: number;
					offsetLink?: string;
				};

				if (!sessionId || !chatId) {
					return new ErrorResponse(
						"sessionId and chatId are required",
						400,
					).send(reply);
				}

				try {
					const result = await this.withTelegramSession(
						sessionId,
						async (client) => {
							const tc = client.getClient();
							const peer = await this.resolveChatPeer(
								tc,
								chatId,
								accessHash,
							);

							return tc.invoke(
								new Api.messages.GetExportedChatInvites({
									peer,
									adminId: new Api.InputUserSelf(),
									limit,
									offsetDate,
									offsetLink,
								}),
							);
						},
					);

					new SuccessResponse(
						result,
						"Exported chat invites fetched successfully",
					).send(reply);
				} catch (error: unknown) {
					ErrorResponse.fromError(error).send(reply);
				}
			},
		);

		/**
		 * Revokes an existing invite link for a basic group, supergroup, or channel.
		 * Pass the full invite URL (or hash) in `link`.
		 */
		fastify.post(
			"/chats/RevokeChatInvite",
			async (request: FastifyRequest, reply: FastifyReply) => {
				const { sessionId, chatId, accessHash, link } = request.body as {
					sessionId: string;
					chatId: string;
					accessHash?: string;
					link: string;
				};

				if (!sessionId || !chatId || !link) {
					return new ErrorResponse(
						"sessionId, chatId and link are required",
						400,
					).send(reply);
				}

				try {
					const result = await this.withTelegramSession(
						sessionId,
						async (client) => {
							const tc = client.getClient();
							const peer = await this.resolveChatPeer(tc, chatId, accessHash);

							return tc.invoke(
								new Api.messages.EditExportedChatInvite({
									peer,
									link,
									revoked: true,
								}),
							);
						},
					);

					new SuccessResponse(
						result,
						"Chat invite link revoked successfully",
					).send(reply);
				} catch (error: unknown) {
					ErrorResponse.fromError(error).send(reply);
				}
			},
		);
	}
}
