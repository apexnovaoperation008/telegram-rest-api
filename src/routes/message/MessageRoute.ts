import { Api } from "telegram";
import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { BaseRoute } from "../BaseRoute";
import { SuccessResponse, ErrorResponse } from "../../http/ApiResponse";
import { TelegramUtils, MediaType } from "../../telegram/TelegramUtils";

interface MediaEntry {
	url: string;
	type: MediaType;
}

export class MessageRoute extends BaseRoute {
	async register(fastify: FastifyInstance): Promise<void> {
		/**
		 * Sends a message to a peer with optional media attachments.
		 *
		 * - No attachments         → messages.SendMessage
		 * - Single attachment      → messages.SendMedia
		 * - Multiple attachments   → messages.SendMultiMedia (album; caption on first item)
		 *
		 * Each URL is downloaded server-side and uploaded to Telegram before sending.
		 */
		fastify.post(
			"/messages/SendMessage",
			async (request: FastifyRequest, reply: FastifyReply) => {
				const {
					sessionId,
					peer,
					message = "",
					replyToMsgId = 0,
					silent = false,
					background = false,
					scheduleDate = 0,
					photos = [],
					videos = [],
					files = [],
				} = request.body as {
					sessionId: string;
					peer: string;
					message?: string;
					replyToMsgId?: number;
					silent?: boolean;
					background?: boolean;
					scheduleDate?: number;
					photos?: string[];
					videos?: string[];
					files?: string[];
				};

				if (!sessionId || !peer) {
					return new ErrorResponse("sessionId and peer are required", 400).send(
						reply,
					);
				}

				const hasVisual = photos.length > 0 || videos.length > 0;
				const hasDocs = files.length > 0;

				// Telegram does not allow mixing visual media (photos/videos) with
				// documents in the same request. Reject early with a clear message.
				if (hasVisual && hasDocs) {
					return new ErrorResponse(
						"Cannot mix photos/videos with files in the same request. Send them in separate requests.",
						400,
					).send(reply);
				}

				const visualMedia: MediaEntry[] = [
					...photos.map((url) => ({ url, type: "photo" as const })),
					...videos.map((url) => ({ url, type: "video" as const })),
				];
				const docMedia: MediaEntry[] = files.map((url) => ({
					url,
					type: "file" as const,
				}));

				try {
					const results = await this.withTelegramSession(
						sessionId,
						async (clientService) => {
							const tc = clientService.getClient();
							const sent: unknown[] = [];

							// GramJS requires peers to be in its in-memory entity cache.
							// On a fresh process start the cache is empty; calling getDialogs
							// populates it. We attempt resolution first (fast path), and only
							// fetch dialogs if it fails (slow path, once per missing peer).
							let resolvedPeer: Awaited<ReturnType<typeof tc.getInputEntity>>;
							try {
								resolvedPeer = await tc.getInputEntity(peer);
							} catch {
								await tc.getDialogs({ limit: 200 });
								resolvedPeer = await tc.getInputEntity(peer);
							}

							const commonFlags = {
								silent,
								background,
								...(scheduleDate && { scheduleDate }),
								...(replyToMsgId && {
									replyTo: new Api.InputReplyToMessage({
										replyToMsgId,
									}),
								}),
							};

							// No media at all → plain text message
							if (visualMedia.length === 0 && docMedia.length === 0) {
								const r = await tc.invoke(
									new Api.messages.SendMessage({
										peer: resolvedPeer,
										message,
										...commonFlags,
										randomId: TelegramUtils.randomId(),
									}),
								);
								sent.push(r);
								return sent;
							}

							/**
							 * Sends a group of MediaEntry items as a single message or album.
							 * Caption is placed on the first item of each group.
							 * Uses messages.UploadMedia to pre-register each file with
							 * Telegram before building the album — required to avoid MEDIA_INVALID.
							 */
							const sendGroup = async (
								group: MediaEntry[],
								caption: string,
							): Promise<void> => {
								if (group.length === 0) return;

								if (group.length === 1) {
									const media = await TelegramUtils.uploadMedia(
										tc,
										group[0].url,
										group[0].type,
									);
									const r = await tc.invoke(
										new Api.messages.SendMedia({
											peer: resolvedPeer,
											media,
											message: caption,
											...commonFlags,
											randomId: TelegramUtils.randomId(),
										}),
									);
									sent.push(r);
									return;
								}

								// Upload each file and pre-register it with Telegram
								const uploadedInputMedia = await Promise.all(
									group.map(({ url, type }) =>
										TelegramUtils.uploadMedia(tc, url, type),
									),
								);

								const registeredMedia = await Promise.all(
									uploadedInputMedia.map((media: Api.TypeInputMedia) =>
										tc.invoke(
											new Api.messages.UploadMedia({
												peer: resolvedPeer,
												media,
											}),
										),
									),
								);

								// Convert MessageMedia → InputMedia for InputSingleMedia
								const resolvedInputMedia = registeredMedia.map(
									(m: Api.TypeMessageMedia) => {
										if (
											m.className === "MessageMediaPhoto" &&
											(m as Api.MessageMediaPhoto).photo?.className === "Photo"
										) {
											const photo = (m as Api.MessageMediaPhoto)
												.photo as Api.Photo;
											return new Api.InputMediaPhoto({
												id: new Api.InputPhoto({
													id: photo.id,
													accessHash: photo.accessHash,
													fileReference: photo.fileReference,
												}),
											});
										}

										if (
											m.className === "MessageMediaDocument" &&
											(m as Api.MessageMediaDocument).document?.className ===
												"Document"
										) {
											const doc = (m as Api.MessageMediaDocument)
												.document as Api.Document;
											return new Api.InputMediaDocument({
												id: new Api.InputDocument({
													id: doc.id,
													accessHash: doc.accessHash,
													fileReference: doc.fileReference,
												}),
											});
										}

										throw new Error(
											`Unexpected media type from UploadMedia: ${m.className}`,
										);
									},
								);

								// Caption on the first item only
								const multiMedia = resolvedInputMedia.map(
									(media: Api.TypeInputMedia, index: number) =>
										new Api.InputSingleMedia({
											media,
											randomId: TelegramUtils.randomId(),
											message: index === 0 ? caption : "",
										}),
								);

								const r = await tc.invoke(
									new Api.messages.SendMultiMedia({
										peer: resolvedPeer,
										multiMedia,
										...commonFlags,
									}),
								);
								sent.push(r);
							};

							// Send visual media (photos + videos) first, carrying the caption.
							// Documents are sent as a follow-up group without a repeated caption.
							await sendGroup(visualMedia, message);
							await sendGroup(
								docMedia,
								visualMedia.length === 0 ? message : "",
							);

							return sent;
						},
					);

					new SuccessResponse(results, "Message sent successfully").send(reply);
				} catch (error: unknown) {
					ErrorResponse.fromError(error).send(reply);
				}
			},
		);
		/**
		 * Reacts to a message with a UTF-8 emoji.
		 * Omit `reaction` to remove an existing reaction.
		 */
		fastify.post(
			"/messages/SendReaction",
			async (request: FastifyRequest, reply: FastifyReply) => {
				const {
					sessionId,
					peer,
					msgId,
					reaction,
					big = false,
				} = request.body as {
					sessionId: string;
					peer: string;
					msgId: number;
					reaction?: string;
					big?: boolean;
				};

				if (!sessionId || !peer || !msgId) {
					return new ErrorResponse(
						"sessionId, peer and msgId are required",
						400,
					).send(reply);
				}

				try {
					const result = await this.withTelegramSession(sessionId, (client) =>
						client.getClient().invoke(
							new Api.messages.SendReaction({
								peer,
								msgId,
								big,
								...(reaction && {
						reaction: [new Api.ReactionEmoji({ emoticon: reaction })],
					}),
							}),
						),
					);

					new SuccessResponse(result, "Reaction sent successfully").send(reply);
				} catch (error: unknown) {
					ErrorResponse.fromError(error).send(reply);
				}
			},
		);
		/**
		 * Marks messages in a chat as read up to (and including) the given message ID.
		 * Pass maxId: 0 to mark the entire history as read.
		 */
		fastify.post(
			"/messages/ReadHistory",
			async (request: FastifyRequest, reply: FastifyReply) => {
				const {
					sessionId,
					peer,
					maxId = 0,
				} = request.body as {
					sessionId: string;
					peer: string;
					maxId?: number;
				};

				if (!sessionId || !peer) {
					return new ErrorResponse("sessionId and peer are required", 400).send(
						reply,
					);
				}

				try {
					const result = await this.withTelegramSession(sessionId, (client) =>
						client
							.getClient()
							.invoke(new Api.messages.ReadHistory({ peer, maxId })),
					);

					new SuccessResponse(result, "History marked as read").send(reply);
				} catch (error: unknown) {
					ErrorResponse.fromError(error).send(reply);
				}
			},
		);

		fastify.post(
			"/messages/ReceivedMessages",
			async (request: FastifyRequest, reply: FastifyReply) => {
				const { sessionId, maxId = 0 } = request.body as {
					sessionId: string;
					maxId?: number;
				};

				if (!sessionId) {
					return new ErrorResponse("sessionId is required", 400).send(reply);
				}

				try {
					const result = await this.withTelegramSession(sessionId, (client) =>
						client
							.getClient()
							.invoke(new Api.messages.ReceivedMessages({ maxId })),
					);

					new SuccessResponse(
						result,
						"Received messages fetched successfully",
					).send(reply);
				} catch (error: unknown) {
					ErrorResponse.fromError(error).send(reply);
				}
			},
		);

		/**
		 * Deletes messages by ID.
		 * `revoke: true`  — deletes for everyone.
		 * `revoke: false` — deletes only for the current user (default).
		 *
		 * Note: this method works for private chats and basic groups.
		 * For supergroups/channels use channels.DeleteMessages instead.
		 */
		fastify.post(
			"/messages/DeleteMessages",
			async (request: FastifyRequest, reply: FastifyReply) => {
				const {
					sessionId,
					id,
					revoke = false,
				} = request.body as {
					sessionId: string;
					id: string[];
					revoke?: boolean;
				};

				if (!sessionId || !id?.length) {
					return new ErrorResponse("sessionId and id are required", 400).send(
						reply,
					);
				}

				try {
					const result = await this.withTelegramSession(sessionId, (client) =>
						client
							.getClient()
							.invoke(
								new Api.messages.DeleteMessages({ id: id.map(Number), revoke }),
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
	}
}
