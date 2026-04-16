import { Api, TelegramClient } from "telegram";
import { computeCheck } from "telegram/Password";
import { CustomFile } from "telegram/client/uploads";
import bigInt from "big-integer";
import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { BaseRoute } from "../BaseRoute";
import { SuccessResponse, ErrorResponse } from "../../http/ApiResponse";
import { TelegramUtils } from "../../telegram/TelegramUtils";
import { MediaFileService } from "../../services/MediaFileService";

export class ChannelRoute extends BaseRoute {
	// ── Private Helpers ────────────────────────────────────────────────────────

	/** Constructs an InputChannel from a string id/accessHash pair. */
	private inputChannel(id: string, accessHash: string): Api.InputChannel {
		return new Api.InputChannel({
			channelId: bigInt(id),
			accessHash: bigInt(accessHash),
		});
	}

	/**
	 * Returns the provided accessHash if non-empty, otherwise resolves it from
	 * the gramjs session cache / Telegram API via getEntity. Throws if the
	 * entity cannot be found or is not a channel.
	 */
	private async resolveChannelAccessHash(
		client: TelegramClient,
		channelId: string,
		accessHash?: string,
	): Promise<string> {
		if (accessHash) return accessHash;

		const entity = await client.getEntity(
			new Api.PeerChannel({ channelId: bigInt(channelId) }),
		);

		if (!(entity instanceof Api.Channel)) {
			throw new Error(
				`Entity ${channelId} resolved but is not a Channel (got ${entity.className})`,
			);
		}

		if (!entity.accessHash) {
			throw new Error(
				`Resolved channel ${channelId} has no accessHash — the session may lack access`,
			);
		}

		return entity.accessHash.toString();
	}

	/** Constructs an InputUser from a string id/accessHash pair. */
	private inputUser(id: string, accessHash: string): Api.InputUser {
		return new Api.InputUser({
			userId: bigInt(id),
			accessHash: bigInt(accessHash),
		});
	}

	/** Constructs an InputPeerUser from a string id/accessHash pair. */
	private inputPeerUser(id: string, accessHash: string): Api.InputPeerUser {
		return new Api.InputPeerUser({
			userId: bigInt(id),
			accessHash: bigInt(accessHash),
		});
	}

	// ── Routes ─────────────────────────────────────────────────────────────────

	async register(fastify: FastifyInstance): Promise<void> {
		/**
		 * Fetches supergroups and channels by their numeric ID and accessHash.
		 * Both values are available in the chats[] array of the GetDialogs response
		 * for all channels — public and private alike.
		 *
		 * For basic groups (className === "Chat") use /chats/GetChats instead.
		 */
		fastify.post(
			"/channels/GetChannels",
			async (request: FastifyRequest, reply: FastifyReply) => {
				const { sessionId, channels } = request.body as {
					sessionId: string;
					channels: { id: string; accessHash?: string }[];
				};

				if (!sessionId || !channels?.length) {
					return new ErrorResponse(
						"sessionId and channels are required",
						400,
					).send(reply);
				}

				try {
					const result = await this.withTelegramSession(
						sessionId,
						async (client) => {
							const tgClient = client.getClient();

							// Resolve any missing accessHashes in parallel before invoking
							const resolved = await Promise.all(
								channels.map(async (c) => ({
									id: c.id,
									accessHash: await this.resolveChannelAccessHash(
										tgClient,
										c.id,
										c.accessHash,
									),
								})),
							);

							const chats = await tgClient.invoke(
								new Api.channels.GetChannels({
									id: resolved.map((c) =>
										this.inputChannel(c.id, c.accessHash),
									),
								}),
							);

							// Serialize bigints as strings so accessHash is readable by callers
							return JSON.parse(
								JSON.stringify(chats, (_, v) =>
									typeof v === "bigint" ? v.toString() : v,
								),
							);
						},
					);

					new SuccessResponse(result, "Channels fetched successfully").send(
						reply,
					);
				} catch (error: unknown) {
					ErrorResponse.fromError(error).send(reply);
				}
			},
		);

		/**
		 * Checks whether a username is available and can be assigned to a channel.
		 * Returns true if available, false if taken.
		 */
		fastify.post(
			"/channels/CheckUsername",
			async (request: FastifyRequest, reply: FastifyReply) => {
				const { sessionId, channelId, accessHash, username } = request.body as {
					sessionId: string;
					channelId: string;
					accessHash: string;
					username: string;
				};

				if (!sessionId || !channelId || !accessHash || !username) {
					return new ErrorResponse(
						"sessionId, channelId, accessHash and username are required",
						400,
					).send(reply);
				}

				try {
					const result = await this.withTelegramSession(sessionId, (client) =>
						client.getClient().invoke(
							new Api.channels.CheckUsername({
								channel: this.inputChannel(channelId, accessHash),
								username,
							}),
						),
					);

					new SuccessResponse(result, "Username checked successfully").send(
						reply,
					);
				} catch (error: unknown) {
					ErrorResponse.fromError(error).send(reply);
				}
			},
		);

		/**
		 * Creates a new supergroup or broadcast channel.
		 *   type = "supergroup"  → a group that allows unlimited members and admin tools
		 *   type = "broadcast"   → a one-way channel only admins can post in
		 */
		fastify.post(
			"/channels/CreateChannel",
			async (request: FastifyRequest, reply: FastifyReply) => {
				const {
					sessionId,
					title,
					about = "",
					type = "supergroup",
				} = request.body as {
					sessionId: string;
					title: string;
					about?: string;
					type?: "supergroup" | "broadcast";
				};

				if (!sessionId || !title) {
					return new ErrorResponse(
						"sessionId and title are required",
						400,
					).send(reply);
				}

				try {
					const result = await this.withTelegramSession(sessionId, (client) =>
						client.getClient().invoke(
							new Api.channels.CreateChannel({
								title,
								about,
								megagroup: type === "supergroup",
								broadcast: type === "broadcast",
							}),
						),
					);

					new SuccessResponse(result, "Channel created successfully").send(
						reply,
					);
				} catch (error: unknown) {
					ErrorResponse.fromError(error).send(reply);
				}
			},
		);

		/**
		 * Permanently deletes a channel or supergroup.
		 * The authenticated user must be the creator. Cannot delete channels with
		 * more than 1000 members.
		 */
		fastify.post(
			"/channels/DeleteChannel",
			async (request: FastifyRequest, reply: FastifyReply) => {
				const { sessionId, channelId, accessHash } = request.body as {
					sessionId: string;
					channelId: string;
					accessHash: string;
				};

				if (!sessionId || !channelId || !accessHash) {
					return new ErrorResponse(
						"sessionId, channelId and accessHash are required",
						400,
					).send(reply);
				}

				try {
					const result = await this.withTelegramSession(sessionId, (client) =>
						client.getClient().invoke(
							new Api.channels.DeleteChannel({
								channel: this.inputChannel(channelId, accessHash),
							}),
						),
					);

					new SuccessResponse(result, "Channel deleted successfully").send(
						reply,
					);
				} catch (error: unknown) {
					ErrorResponse.fromError(error).send(reply);
				}
			},
		);

		/**
		 * Deletes the message history of a supergroup up to (and including) maxId.
		 * Set maxId to 0 to delete the entire history.
		 * Set forEveryone to true to delete for all members (admin only).
		 */
		fastify.post(
			"/channels/DeleteHistory",
			async (request: FastifyRequest, reply: FastifyReply) => {
				const {
					sessionId,
					channelId,
					accessHash,
					maxId = 0,
					forEveryone = false,
				} = request.body as {
					sessionId: string;
					channelId: string;
					accessHash: string;
					maxId?: number;
					forEveryone?: boolean;
				};

				if (!sessionId || !channelId || !accessHash) {
					return new ErrorResponse(
						"sessionId, channelId and accessHash are required",
						400,
					).send(reply);
				}

				try {
					const result = await this.withTelegramSession(sessionId, (client) =>
						client.getClient().invoke(
							new Api.channels.DeleteHistory({
								channel: this.inputChannel(channelId, accessHash),
								maxId,
								forEveryone,
							}),
						),
					);

					new SuccessResponse(result, "History deleted successfully").send(
						reply,
					);
				} catch (error: unknown) {
					ErrorResponse.fromError(error).send(reply);
				}
			},
		);

		/**
		 * Deletes specific messages in a channel or supergroup by their IDs.
		 * Requires delete-messages admin permission.
		 */
		fastify.post(
			"/channels/DeleteMessages",
			async (request: FastifyRequest, reply: FastifyReply) => {
				const { sessionId, channelId, accessHash, id } = request.body as {
					sessionId: string;
					channelId: string;
					accessHash: string;
					id: number[];
				};

				if (!sessionId || !channelId || !accessHash || !id?.length) {
					return new ErrorResponse(
						"sessionId, channelId, accessHash and id are required",
						400,
					).send(reply);
				}

				try {
					const result = await this.withTelegramSession(sessionId, (client) =>
						client.getClient().invoke(
							new Api.channels.DeleteMessages({
								channel: this.inputChannel(channelId, accessHash),
								id,
							}),
						),
					);

					new SuccessResponse(result, "Messages deleted successfully").send(
						reply,
					);
				} catch (error: unknown) {
					ErrorResponse.fromError(error).send(reply);
				}
			},
		);

		/**
		 * Deletes all messages sent by a specific participant in a supergroup.
		 * Requires delete-messages admin permission.
		 * Participant must be a user identified by userId + userAccessHash.
		 */
		fastify.post(
			"/channels/DeleteParticipantHistory",
			async (request: FastifyRequest, reply: FastifyReply) => {
				const { sessionId, channelId, accessHash, userId, userAccessHash } =
					request.body as {
						sessionId: string;
						channelId: string;
						accessHash: string;
						userId: string;
						userAccessHash: string;
					};

				if (
					!sessionId ||
					!channelId ||
					!accessHash ||
					!userId ||
					!userAccessHash
				) {
					return new ErrorResponse(
						"sessionId, channelId, accessHash, userId and userAccessHash are required",
						400,
					).send(reply);
				}

				try {
					const result = await this.withTelegramSession(sessionId, (client) =>
						client.getClient().invoke(
							new Api.channels.DeleteParticipantHistory({
								channel: this.inputChannel(channelId, accessHash),
								participant: this.inputPeerUser(userId, userAccessHash),
							}),
						),
					);

					new SuccessResponse(
						result,
						"Participant history deleted successfully",
					).send(reply);
				} catch (error: unknown) {
					ErrorResponse.fromError(error).send(reply);
				}
			},
		);

		/**
		 * Grants or modifies admin rights for a user in a channel or supergroup.
		 * Pass rank to set a custom admin title (e.g. "Moderator").
		 * Set all adminRights flags to false to demote the user.
		 */
		fastify.post(
			"/channels/EditAdmin",
			async (request: FastifyRequest, reply: FastifyReply) => {
				const {
					sessionId,
					channelId,
					accessHash,
					userId,
					userAccessHash,
					adminRights,
					rank = "",
				} = request.body as {
					sessionId: string;
					channelId: string;
					accessHash: string;
					userId: string;
					userAccessHash: string;
					adminRights?: {
						changeInfo?: boolean;
						postMessages?: boolean;
						editMessages?: boolean;
						deleteMessages?: boolean;
						banUsers?: boolean;
						inviteUsers?: boolean;
						pinMessages?: boolean;
						addAdmins?: boolean;
						anonymous?: boolean;
						manageCall?: boolean;
						other?: boolean;
					};
					rank?: string;
				};

				if (
					!sessionId ||
					!channelId ||
					!accessHash ||
					!userId ||
					!userAccessHash
				) {
					return new ErrorResponse(
						"sessionId, channelId, accessHash, userId and userAccessHash are required",
						400,
					).send(reply);
				}

				try {
					const result = await this.withTelegramSession(sessionId, (client) =>
						client.getClient().invoke(
							new Api.channels.EditAdmin({
								channel: this.inputChannel(channelId, accessHash),
								userId: this.inputUser(userId, userAccessHash),
								adminRights: new Api.ChatAdminRights({
									changeInfo: adminRights?.changeInfo ?? false,
									postMessages: adminRights?.postMessages ?? false,
									editMessages: adminRights?.editMessages ?? false,
									deleteMessages: adminRights?.deleteMessages ?? false,
									banUsers: adminRights?.banUsers ?? false,
									inviteUsers: adminRights?.inviteUsers ?? false,
									pinMessages: adminRights?.pinMessages ?? false,
									addAdmins: adminRights?.addAdmins ?? false,
									anonymous: adminRights?.anonymous ?? false,
									manageCall: adminRights?.manageCall ?? false,
									other: adminRights?.other ?? false,
								}),
								rank,
							}),
						),
					);

					new SuccessResponse(result, "Admin rights updated successfully").send(
						reply,
					);
				} catch (error: unknown) {
					ErrorResponse.fromError(error).send(reply);
				}
			},
		);

		/**
		 * Bans, restricts, or unbans a user in a channel or supergroup.
		 *
		 * To unban: send an empty bannedRights object (all flags false, untilDate 0).
		 * To kick:  set viewMessages to true.
		 * untilDate is a Unix timestamp; 0 means permanent.
		 */
		fastify.post(
			"/channels/EditBanned",
			async (request: FastifyRequest, reply: FastifyReply) => {
				const {
					sessionId,
					channelId,
					accessHash,
					userId,
					userAccessHash,
					bannedRights,
				} = request.body as {
					sessionId: string;
					channelId: string;
					accessHash: string;
					userId: string;
					userAccessHash: string;
					bannedRights?: {
						untilDate?: number;
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

				if (
					!sessionId ||
					!channelId ||
					!accessHash ||
					!userId ||
					!userAccessHash
				) {
					return new ErrorResponse(
						"sessionId, channelId, accessHash, userId and userAccessHash are required",
						400,
					).send(reply);
				}

				if (
					bannedRights?.untilDate &&
					bannedRights.untilDate < Math.floor(Date.now() / 1000)
				) {
					return new ErrorResponse(
						"untilDate must be a future Unix timestamp in seconds (e.g. Math.floor(Date.now()/1000) + 86400 for 1 day). Pass 0 or omit it for a permanent ban.",
						400,
					).send(reply);
				}

				try {
					const result = await this.withTelegramSession(sessionId, (client) =>
						client.getClient().invoke(
							new Api.channels.EditBanned({
								channel: this.inputChannel(channelId, accessHash),
								participant: this.inputPeerUser(userId, userAccessHash),
								bannedRights: new Api.ChatBannedRights({
									// untilDate is a conditional TL field — only include it when
									// a real future Unix timestamp is provided. Passing 0 causes
									// Telegram to reject the request with UNTIL_DATE_INVALID.
									untilDate: bannedRights?.untilDate ?? 0,
									viewMessages: bannedRights?.viewMessages ?? false,
									sendMessages: bannedRights?.sendMessages ?? false,
									sendMedia: bannedRights?.sendMedia ?? false,
									sendStickers: bannedRights?.sendStickers ?? false,
									sendGifs: bannedRights?.sendGifs ?? false,
									sendGames: bannedRights?.sendGames ?? false,
									sendInline: bannedRights?.sendInline ?? false,
									sendPolls: bannedRights?.sendPolls ?? false,
									changeInfo: bannedRights?.changeInfo ?? false,
									inviteUsers: bannedRights?.inviteUsers ?? false,
									pinMessages: bannedRights?.pinMessages ?? false,
								}),
							}),
						),
					);

					new SuccessResponse(result, "Ban rights updated successfully").send(
						reply,
					);
				} catch (error: unknown) {
					ErrorResponse.fromError(error).send(reply);
				}
			},
		);

		/**
		 * Transfers ownership of a channel to another user.
		 *
		 * Telegram requires 2FA to be enabled on the account. Provide the plain-text
		 * 2FA password in twoFaPassword — the server computes the SRP challenge
		 * internally using account.GetPassword, so the raw password is never stored.
		 *
		 * Requirements:
		 *   - 2FA must be enabled on the session's account.
		 *   - The session must be at least 24 hours old.
		 *   - The 2FA password must not have been changed in the last 24 hours.
		 */
		fastify.post(
			"/channels/EditCreator",
			async (request: FastifyRequest, reply: FastifyReply) => {
				const {
					sessionId,
					channelId,
					accessHash,
					userId,
					userAccessHash,
					twoFaPassword,
				} = request.body as {
					sessionId: string;
					channelId: string;
					accessHash: string;
					userId: string;
					userAccessHash: string;
					twoFaPassword: string;
				};

				if (
					!sessionId ||
					!channelId ||
					!accessHash ||
					!userId ||
					!userAccessHash ||
					!twoFaPassword
				) {
					return new ErrorResponse(
						"sessionId, channelId, accessHash, userId, userAccessHash and twoFaPassword are required",
						400,
					).send(reply);
				}

				try {
					const result = await this.withTelegramSession(
						sessionId,
						async (client) => {
							// Fetch the current SRP challenge parameters from Telegram, then
							// derive the proof-of-knowledge hash. This avoids transmitting a
							// raw password hash over the wire.
							const passwordInfo = await client
								.getClient()
								.invoke(new Api.account.GetPassword());

							const srpCheck = await computeCheck(passwordInfo, twoFaPassword);

							return client.getClient().invoke(
								new Api.channels.EditCreator({
									channel: this.inputChannel(channelId, accessHash),
									userId: this.inputUser(userId, userAccessHash),
									password: srpCheck,
								}),
							);
						},
					);

					new SuccessResponse(
						result,
						"Channel ownership transferred successfully",
					).send(reply);
				} catch (error: unknown) {
					ErrorResponse.fromError(error).send(reply);
				}
			},
		);

		/**
		 * Changes the photo of a channel or supergroup.
		 * Provide photoUrl to set a new photo, or omit it to remove the current one.
		 */
		fastify.post(
			"/channels/EditPhoto",
			async (request: FastifyRequest, reply: FastifyReply) => {
				const { sessionId, channelId, accessHash, photoUrl } = request.body as {
					sessionId: string;
					channelId: string;
					accessHash: string;
					photoUrl?: string;
				};

				if (!sessionId || !channelId || !accessHash) {
					return new ErrorResponse(
						"sessionId, channelId and accessHash are required",
						400,
					).send(reply);
				}

				try {
					const result = await this.withTelegramSession(
						sessionId,
						async (client) => {
							let photo: Api.TypeInputChatPhoto;

							if (photoUrl) {
								const { buffer, filename } =
									await TelegramUtils.downloadFromUrl(photoUrl);

								const uploaded = await client.getClient().uploadFile({
									file: new CustomFile(filename, buffer.length, "", buffer),
									workers: 1,
								});

								photo = new Api.InputChatUploadedPhoto({ file: uploaded });
							} else {
								photo = new Api.InputChatPhotoEmpty();
							}

							return client.getClient().invoke(
								new Api.channels.EditPhoto({
									channel: this.inputChannel(channelId, accessHash),
									photo,
								}),
							);
						},
					);

					new SuccessResponse(
						result,
						"Channel photo updated successfully",
					).send(reply);
				} catch (error: unknown) {
					ErrorResponse.fromError(error).send(reply);
				}
			},
		);

		/**
		 * Changes the title (name) of a channel or supergroup.
		 * Requires change-info admin permission.
		 */
		fastify.post(
			"/channels/EditTitle",
			async (request: FastifyRequest, reply: FastifyReply) => {
				const { sessionId, channelId, accessHash, title } = request.body as {
					sessionId: string;
					channelId: string;
					accessHash: string;
					title: string;
				};

				if (!sessionId || !channelId || !accessHash || !title) {
					return new ErrorResponse(
						"sessionId, channelId, accessHash and title are required",
						400,
					).send(reply);
				}

				try {
					const result = await this.withTelegramSession(sessionId, (client) =>
						client.getClient().invoke(
							new Api.channels.EditTitle({
								channel: this.inputChannel(channelId, accessHash),
								title,
							}),
						),
					);

					new SuccessResponse(
						result,
						"Channel title updated successfully",
					).send(reply);
				} catch (error: unknown) {
					ErrorResponse.fromError(error).send(reply);
				}
			},
		);

		/**
		 * Returns full information about a channel, supergroup, or gigagroup,
		 * including description, member count, invite link, pinned message, etc.
		 *
		 * Downloaded files are tracked in media_files and deleted after
		 * MEDIA_RETENTION_DAYS days by MediaCleanupScheduler.
		 */
		fastify.post(
			"/channels/GetFullChannel",
			async (request: FastifyRequest, reply: FastifyReply) => {
				const { sessionId, channelId, accessHash } = request.body as {
					sessionId: string;
					channelId: string;
					accessHash?: string;
				};

				if (!sessionId || !channelId) {
					return new ErrorResponse(
						"sessionId and channelId are required",
						400,
					).send(reply);
				}

				try {
					const result = await this.withTelegramSession(
						sessionId,
						async (client) => {
							const tgClient = client.getClient();

							// Resolve accessHash from gramjs session/API if not supplied
							const resolvedHash = await this.resolveChannelAccessHash(
								tgClient,
								channelId,
								accessHash,
							);

							const channelFull = await tgClient.invoke(
								new Api.channels.GetFullChannel({
									channel: this.inputChannel(channelId, resolvedHash),
								}),
							);

							// Serialize to a plain object so extra fields can be appended.
							// The replacer converts native bigint values to strings,
							// consistent with how GramJS toJSON() behaves.
							const data: Record<string, unknown> = JSON.parse(
								JSON.stringify(channelFull, (_, v) =>
									typeof v === "bigint" ? v.toString() : v,
								),
							);

							// ── Channel avatar ────────────────────────────────────────────
							const channelInfo = channelFull.chats.find(
								(c: Api.TypeChat): c is Api.Channel =>
									c instanceof Api.Channel && c.id.toString() === channelId,
							);

							let avatarUrl: string | null = null;
							if (channelInfo?.photo instanceof Api.ChatPhoto) {
								avatarUrl = await MediaFileService.downloadChannelPhoto(
									tgClient,
									channelId,
									resolvedHash,
									channelInfo.photo,
								).catch((err) => {
									console.error(
										"[GetFullChannel] Avatar download failed:",
										err instanceof Error ? err.message : err,
									);
									return null;
								});
							}

							// Inject avatar_url into the matching chats[] entry so it sits
							// alongside the photo field in the original payload structure.
							// Also inject access_hash so callers can persist it without a
							// separate lookup when accessHash was not supplied in the request.
							const chatsArray = data.chats as Array<Record<string, unknown>>;
							const channelEntry = chatsArray.find(
								(c) => String(c.id) === channelId,
							);
							if (channelEntry) {
								channelEntry.avatar_url = avatarUrl;
								channelEntry.access_hash = resolvedHash;
							}

						// ── Forum topics ──────────────────────────────────────────────
						// Topics are fetched separately and injected into fullChat so they
						// sit within the natural full-channel payload structure.
						if (channelInfo?.forum) {
							const topicsResult = await tgClient.invoke(
								new Api.channels.GetForumTopics({
									channel: this.inputChannel(channelId, resolvedHash),
									offsetDate: 0,
									offsetId: 0,
									offsetTopic: 0,
									limit: 100,
								}),
							);

							const topics = topicsResult.topics.map(
								(topic: Api.TypeForumTopic) =>
									JSON.parse(
										JSON.stringify(topic, (_, v) =>
											typeof v === "bigint" ? v.toString() : v,
										),
									),
							);

							const fullChatEntry = data.fullChat as Record<string, unknown>;
							fullChatEntry.topics = topics;
						}

							// Inject avatar_url into each user that has a profile photo.
							await MediaFileService.injectUserAvatars(
								tgClient,
								channelFull.users,
								data.users as Array<Record<string, unknown>>,
							);

							return data;
						},
					);

					new SuccessResponse(
						result,
						"Full channel info fetched successfully",
					).send(reply);
				} catch (error: unknown) {
					ErrorResponse.fromError(error).send(reply);
				}
			},
		);

		/**
		 * Returns all supergroups that can be used as a discussion group
		 * linked to a broadcast channel.
		 */
		fastify.post(
			"/channels/GetGroupsForDiscussion",
			async (request: FastifyRequest, reply: FastifyReply) => {
				const { sessionId } = request.body as { sessionId: string };

				if (!sessionId) {
					return new ErrorResponse("sessionId is required", 400).send(reply);
				}

				try {
					const result = await this.withTelegramSession(sessionId, (client) =>
						client
							.getClient()
							.invoke(new Api.channels.GetGroupsForDiscussion()),
					);

					new SuccessResponse(
						result,
						"Groups for discussion fetched successfully",
					).send(reply);
				} catch (error: unknown) {
					ErrorResponse.fromError(error).send(reply);
				}
			},
		);

		/**
		 * Returns channels and supergroups that the current user has joined but
		 * has been inactive in for a long time.
		 */
		fastify.post(
			"/channels/GetInactiveChannels",
			async (request: FastifyRequest, reply: FastifyReply) => {
				const { sessionId } = request.body as { sessionId: string };

				if (!sessionId) {
					return new ErrorResponse("sessionId is required", 400).send(reply);
				}

				try {
					const result = await this.withTelegramSession(sessionId, (client) =>
						client.getClient().invoke(new Api.channels.GetInactiveChannels()),
					);

					new SuccessResponse(
						result,
						"Inactive channels fetched successfully",
					).send(reply);
				} catch (error: unknown) {
					ErrorResponse.fromError(error).send(reply);
				}
			},
		);

		/**
		 * Returns channels and supergroups that the current user has left.
		 * Use offset to paginate through results.
		 */
		fastify.post(
			"/channels/GetLeftChannels",
			async (request: FastifyRequest, reply: FastifyReply) => {
				const { sessionId, offset = 0 } = request.body as {
					sessionId: string;
					offset?: number;
				};

				if (!sessionId) {
					return new ErrorResponse("sessionId is required", 400).send(reply);
				}

				try {
					const result = await this.withTelegramSession(sessionId, (client) =>
						client
							.getClient()
							.invoke(new Api.channels.GetLeftChannels({ offset })),
					);

					new SuccessResponse(
						result,
						"Left channels fetched successfully",
					).send(reply);
				} catch (error: unknown) {
					ErrorResponse.fromError(error).send(reply);
				}
			},
		);

		/**
		 * Fetches specific messages from a channel or supergroup by their IDs.
		 */
		fastify.post(
			"/channels/GetMessages",
			async (request: FastifyRequest, reply: FastifyReply) => {
				const { sessionId, channelId, accessHash, id } = request.body as {
					sessionId: string;
					channelId: string;
					accessHash: string;
					id: number[];
				};

				if (!sessionId || !channelId || !accessHash || !id?.length) {
					return new ErrorResponse(
						"sessionId, channelId, accessHash and id are required",
						400,
					).send(reply);
				}

				try {
					const result = await this.withTelegramSession(sessionId, (client) =>
						client.getClient().invoke(
							new Api.channels.GetMessages({
								channel: this.inputChannel(channelId, accessHash),
								id: id.map((msgId) => new Api.InputMessageID({ id: msgId })),
							}),
						),
					);

					new SuccessResponse(result, "Messages fetched successfully").send(
						reply,
					);
				} catch (error: unknown) {
					ErrorResponse.fromError(error).send(reply);
				}
			},
		);

		/**
		 * Returns information about a single participant in a channel or supergroup.
		 */
		fastify.post(
			"/channels/GetParticipant",
			async (request: FastifyRequest, reply: FastifyReply) => {
				const { sessionId, channelId, accessHash, userId, userAccessHash } =
					request.body as {
						sessionId: string;
						channelId: string;
						accessHash: string;
						userId: string;
						userAccessHash: string;
					};

				if (
					!sessionId ||
					!channelId ||
					!accessHash ||
					!userId ||
					!userAccessHash
				) {
					return new ErrorResponse(
						"sessionId, channelId, accessHash, userId and userAccessHash are required",
						400,
					).send(reply);
				}

				try {
					const result = await this.withTelegramSession(sessionId, (client) =>
						client.getClient().invoke(
							new Api.channels.GetParticipant({
								channel: this.inputChannel(channelId, accessHash),
								participant: this.inputPeerUser(userId, userAccessHash),
							}),
						),
					);

					new SuccessResponse(result, "Participant fetched successfully").send(
						reply,
					);
				} catch (error: unknown) {
					ErrorResponse.fromError(error).send(reply);
				}
			},
		);

		/**
		 * Returns the list of peers (users, channels) that can be used to send
		 * messages in the given supergroup or channel.
		 */
		fastify.post(
			"/channels/GetSendAs",
			async (request: FastifyRequest, reply: FastifyReply) => {
				const { sessionId, channelId, accessHash } = request.body as {
					sessionId: string;
					channelId: string;
					accessHash: string;
				};

				if (!sessionId || !channelId || !accessHash) {
					return new ErrorResponse(
						"sessionId, channelId and accessHash are required",
						400,
					).send(reply);
				}

				try {
					const result = await this.withTelegramSession(sessionId, (client) =>
						client.getClient().invoke(
							new Api.channels.GetSendAs({
								peer: new Api.InputPeerChannel({
									channelId: bigInt(channelId),
									accessHash: bigInt(accessHash),
								}),
							}),
						),
					);

					new SuccessResponse(
						result,
						"Send-as peers fetched successfully",
					).send(reply);
				} catch (error: unknown) {
					ErrorResponse.fromError(error).send(reply);
				}
			},
		);

		/**
		 * Invites one or more users to a channel or supergroup.
		 * Each user must be identified by their userId and userAccessHash.
		 */
		fastify.post(
			"/channels/InviteToChannel",
			async (request: FastifyRequest, reply: FastifyReply) => {
				const { sessionId, channelId, accessHash, users } = request.body as {
					sessionId: string;
					channelId: string;
					accessHash: string;
					users: { id: string; accessHash: string }[];
				};

				if (!sessionId || !channelId || !accessHash || !users?.length) {
					return new ErrorResponse(
						"sessionId, channelId, accessHash and users are required",
						400,
					).send(reply);
				}

				try {
					const result = await this.withTelegramSession(sessionId, (client) =>
						client.getClient().invoke(
							new Api.channels.InviteToChannel({
								channel: this.inputChannel(channelId, accessHash),
								users: users.map((u) => this.inputUser(u.id, u.accessHash)),
							}),
						),
					);

					new SuccessResponse(result, "Users invited successfully").send(reply);
				} catch (error: unknown) {
					ErrorResponse.fromError(error).send(reply);
				}
			},
		);

		/**
		 * Joins a public channel or supergroup by its channelId + accessHash.
		 * For private channels, use messages.ImportChatInvite with an invite link instead.
		 */
		fastify.post(
			"/channels/JoinChannel",
			async (request: FastifyRequest, reply: FastifyReply) => {
				const { sessionId, channelId, accessHash } = request.body as {
					sessionId: string;
					channelId: string;
					accessHash: string;
				};

				if (!sessionId || !channelId || !accessHash) {
					return new ErrorResponse(
						"sessionId, channelId and accessHash are required",
						400,
					).send(reply);
				}

				try {
					const result = await this.withTelegramSession(sessionId, (client) =>
						client.getClient().invoke(
							new Api.channels.JoinChannel({
								channel: this.inputChannel(channelId, accessHash),
							}),
						),
					);

					new SuccessResponse(result, "Joined channel successfully").send(
						reply,
					);
				} catch (error: unknown) {
					ErrorResponse.fromError(error).send(reply);
				}
			},
		);

		/**
		 * Leaves a channel or supergroup. The creator cannot leave their own channel.
		 */
		fastify.post(
			"/channels/LeaveChannel",
			async (request: FastifyRequest, reply: FastifyReply) => {
				const { sessionId, channelId, accessHash } = request.body as {
					sessionId: string;
					channelId: string;
					accessHash: string;
				};

				if (!sessionId || !channelId || !accessHash) {
					return new ErrorResponse(
						"sessionId, channelId and accessHash are required",
						400,
					).send(reply);
				}

				try {
					const result = await this.withTelegramSession(sessionId, (client) =>
						client.getClient().invoke(
							new Api.channels.LeaveChannel({
								channel: this.inputChannel(channelId, accessHash),
							}),
						),
					);

					new SuccessResponse(result, "Left channel successfully").send(reply);
				} catch (error: unknown) {
					ErrorResponse.fromError(error).send(reply);
				}
			},
		);

		/**
		 * Marks channel or supergroup messages as read up to (and including) maxId.
		 * Set maxId to 0 to mark all messages as read.
		 */
		fastify.post(
			"/channels/ReadHistory",
			async (request: FastifyRequest, reply: FastifyReply) => {
				const {
					sessionId,
					channelId,
					accessHash,
					maxId = 0,
				} = request.body as {
					sessionId: string;
					channelId: string;
					accessHash: string;
					maxId?: number;
				};

				if (!sessionId || !channelId || !accessHash) {
					return new ErrorResponse(
						"sessionId, channelId and accessHash are required",
						400,
					).send(reply);
				}

				try {
					const result = await this.withTelegramSession(sessionId, (client) =>
						client.getClient().invoke(
							new Api.channels.ReadHistory({
								channel: this.inputChannel(channelId, accessHash),
								maxId,
							}),
						),
					);

					new SuccessResponse(result, "History marked as read").send(reply);
				} catch (error: unknown) {
					ErrorResponse.fromError(error).send(reply);
				}
			},
		);

		/**
		 * Marks the contents (e.g. albums, voice messages) of specific channel
		 * messages as read, removing the unread content indicator.
		 */
		fastify.post(
			"/channels/ReadMessageContents",
			async (request: FastifyRequest, reply: FastifyReply) => {
				const { sessionId, channelId, accessHash, id } = request.body as {
					sessionId: string;
					channelId: string;
					accessHash: string;
					id: number[];
				};

				if (!sessionId || !channelId || !accessHash || !id?.length) {
					return new ErrorResponse(
						"sessionId, channelId, accessHash and id are required",
						400,
					).send(reply);
				}

				try {
					const result = await this.withTelegramSession(sessionId, (client) =>
						client.getClient().invoke(
							new Api.channels.ReadMessageContents({
								channel: this.inputChannel(channelId, accessHash),
								id,
							}),
						),
					);

					new SuccessResponse(result, "Message contents marked as read").send(
						reply,
					);
				} catch (error: unknown) {
					ErrorResponse.fromError(error).send(reply);
				}
			},
		);

		/**
		 * Sets or removes the public username of a channel or supergroup.
		 * Pass an empty string to remove the username and make the channel private.
		 */
		fastify.post(
			"/channels/UpdateUsername",
			async (request: FastifyRequest, reply: FastifyReply) => {
				const { sessionId, channelId, accessHash, username } = request.body as {
					sessionId: string;
					channelId: string;
					accessHash: string;
					username: string;
				};

				if (!sessionId || !channelId || !accessHash || username === undefined) {
					return new ErrorResponse(
						"sessionId, channelId, accessHash and username are required",
						400,
					).send(reply);
				}

				try {
					const result = await this.withTelegramSession(sessionId, (client) =>
						client.getClient().invoke(
							new Api.channels.UpdateUsername({
								channel: this.inputChannel(channelId, accessHash),
								username,
							}),
						),
					);

					new SuccessResponse(result, "Username updated successfully").send(
						reply,
					);
				} catch (error: unknown) {
					ErrorResponse.fromError(error).send(reply);
				}
			},
		);

		/**
		 * Enables or disables slow mode for a supergroup.
		 * When enabled, members can only send one message every `seconds` seconds.
		 * Set seconds to 0 to disable slow mode.
		 * Valid non-zero values: 10, 30, 60, 300, 900, 3600.
		 */
		fastify.post(
			"/channels/ToggleSlowMode",
			async (request: FastifyRequest, reply: FastifyReply) => {
				const { sessionId, channelId, accessHash, seconds } = request.body as {
					sessionId: string;
					channelId: string;
					accessHash: string;
					seconds: number;
				};

				if (!sessionId || !channelId || !accessHash || seconds === undefined) {
					return new ErrorResponse(
						"sessionId, channelId, accessHash and seconds are required",
						400,
					).send(reply);
				}

				try {
					const result = await this.withTelegramSession(sessionId, (client) =>
						client.getClient().invoke(
							new Api.channels.ToggleSlowMode({
								channel: this.inputChannel(channelId, accessHash),
								seconds,
							}),
						),
					);

					new SuccessResponse(result, "Slow mode updated successfully").send(
						reply,
					);
				} catch (error: unknown) {
					ErrorResponse.fromError(error).send(reply);
				}
			},
		);

		/**
		 * Toggles whether users must join the supergroup before they can send messages.
		 * When enabled, new members must explicitly press "Join" even for public groups.
		 */
		fastify.post(
			"/channels/ToggleJoinToSend",
			async (request: FastifyRequest, reply: FastifyReply) => {
				const { sessionId, channelId, accessHash, enabled } = request.body as {
					sessionId: string;
					channelId: string;
					accessHash: string;
					enabled: boolean;
				};

				if (!sessionId || !channelId || !accessHash || enabled === undefined) {
					return new ErrorResponse(
						"sessionId, channelId, accessHash and enabled are required",
						400,
					).send(reply);
				}

				try {
					const result = await this.withTelegramSession(sessionId, (client) =>
						client.getClient().invoke(
							new Api.channels.ToggleJoinToSend({
								channel: this.inputChannel(channelId, accessHash),
								enabled,
							}),
						),
					);

					new SuccessResponse(
						result,
						"Join-to-send setting updated successfully",
					).send(reply);
				} catch (error: unknown) {
					ErrorResponse.fromError(error).send(reply);
				}
			},
		);

		/**
		 * Toggles whether new join requests must be approved by an admin before
		 * the user is admitted to the supergroup.
		 */
		fastify.post(
			"/channels/ToggleJoinRequest",
			async (request: FastifyRequest, reply: FastifyReply) => {
				const { sessionId, channelId, accessHash, enabled } = request.body as {
					sessionId: string;
					channelId: string;
					accessHash: string;
					enabled: boolean;
				};

				if (!sessionId || !channelId || !accessHash || enabled === undefined) {
					return new ErrorResponse(
						"sessionId, channelId, accessHash and enabled are required",
						400,
					).send(reply);
				}

				try {
					const result = await this.withTelegramSession(sessionId, (client) =>
						client.getClient().invoke(
							new Api.channels.ToggleJoinRequest({
								channel: this.inputChannel(channelId, accessHash),
								enabled,
							}),
						),
					);

					new SuccessResponse(
						result,
						"Join-request setting updated successfully",
					).send(reply);
				} catch (error: unknown) {
					ErrorResponse.fromError(error).send(reply);
				}
			},
		);
	}
}
