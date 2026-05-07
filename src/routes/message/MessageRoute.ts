import { Api, TelegramClient } from "telegram";
import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { BaseRoute } from "../BaseRoute";
import { SuccessResponse, ErrorResponse } from "../../http/ApiResponse";
import {
	TelegramUtils,
	MediaType,
	RawMessageEntity,
} from "../../telegram/TelegramUtils";
import { S3UploadService } from "../../services/S3UploadService";

interface MediaEntry {
	url: string;
	type: MediaType;
}

interface S3Attachment {
	file_unique_id: string;
	file_type: string;
	url: string;
}

async function downloadAndUploadToS3(
	client: TelegramClient,
	msg: Api.Message,
	peerId: string,
): Promise<S3Attachment[]> {
	const { media } = msg;
	if (!media) return [];

	const subPath = `${peerId}`;

	if (
		media instanceof Api.MessageMediaPhoto &&
		media.photo instanceof Api.Photo
	) {
		const { photo } = media;
		const fileUniqueId = `photo_${photo.id.toString()}`;
		const fileName = `${msg.id}_${fileUniqueId}.jpg`;

		const existingUrl = await S3UploadService.exists(
			S3UploadService.buildKey(fileName, subPath),
		);
		if (existingUrl) {
			return [{ file_unique_id: fileUniqueId, file_type: "photo", url: existingUrl }];
		}

		const bestSize = photo.sizes[photo.sizes.length - 1];
		const thumbType =
			"type" in bestSize ? (bestSize as Api.PhotoSize).type : "y";
		const location = new Api.InputPhotoFileLocation({
			id: photo.id,
			accessHash: photo.accessHash,
			fileReference: photo.fileReference,
			thumbSize: thumbType,
		});
		const result = await client.downloadFile(location, {
			dcId: photo.dcId,
		});
		const buffer = toBuffer(result);
		if (buffer.length === 0) return [];

		const url = await S3UploadService.upload(buffer, fileName, "image/jpeg", subPath);
		return [{ file_unique_id: fileUniqueId, file_type: "photo", url }];
	}

	if (
		media instanceof Api.MessageMediaDocument &&
		media.document instanceof Api.Document
	) {
		const doc = media.document;
		let fileType = "document";
		if (doc.mimeType?.startsWith("video/")) fileType = "video";
		else if (doc.mimeType?.startsWith("audio/")) fileType = "audio";

		const fileUniqueId = `doc_${doc.id.toString()}`;
		const ext = inferDocExtension(doc);
		const fileName = `${msg.id}_${fileUniqueId}.${ext}`;

		const existingUrl = await S3UploadService.exists(
			S3UploadService.buildKey(fileName, subPath),
		);
		if (existingUrl) {
			return [{ file_unique_id: fileUniqueId, file_type: fileType, url: existingUrl }];
		}

		const location = new Api.InputDocumentFileLocation({
			id: doc.id,
			accessHash: doc.accessHash,
			fileReference: doc.fileReference,
			thumbSize: "",
		});
		const result = await client.downloadFile(location, {
			dcId: doc.dcId,
		});
		const buffer = toBuffer(result);
		if (buffer.length === 0) return [];

		const url = await S3UploadService.upload(buffer, fileName, doc.mimeType ?? undefined, subPath);
		return [{ file_unique_id: fileUniqueId, file_type: fileType, url }];
	}

	return [];
}

function inferDocExtension(doc: Api.Document): string {
	for (const attr of doc.attributes) {
		if (attr instanceof Api.DocumentAttributeFilename) {
			const parts = attr.fileName.split(".");
			if (parts.length > 1) return parts[parts.length - 1];
		}
	}
	const mimeMap: Record<string, string> = {
		"video/mp4": "mp4",
		"video/webm": "webm",
		"audio/ogg": "ogg",
		"audio/mpeg": "mp3",
		"application/pdf": "pdf",
		"image/png": "png",
		"image/jpeg": "jpg",
		"image/webp": "webp",
	};
	return mimeMap[doc.mimeType ?? ""] ?? "bin";
}

function toBuffer(result: string | Buffer | undefined): Buffer {
	if (Buffer.isBuffer(result)) return result;
	if (typeof result === "string") return Buffer.from(result, "binary");
	return Buffer.alloc(0);
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
				entities: rawEntities,
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
				entities?: RawMessageEntity[];
			};

			const entities = TelegramUtils.buildEntities(rawEntities);

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
									...(entities && { entities }),
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
										...(caption && entities ? { entities } : {}),
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
										...(index === 0 && caption && entities
											? { entities }
											: {}),
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
		 * Fetches messages by ID from a private chat / basic group, or from a
		 * channel / supergroup when `channel` is supplied.
		 *
		 * - Omit `channel` for private chats and basic groups.
		 * - Supply `channel` (username, numeric ID, or `t.me` link) for
		 *   supergroups and channels.
		 * - Set `downloadMedia: true` to synchronously download each message's
		 *   photo / document and inject an `attachments` array into every message.
		 */
		fastify.post(
			"/messages/GetMessages",
			async (request: FastifyRequest, reply: FastifyReply) => {
				const {
					sessionId,
					id,
					channel,
					downloadMedia = false,
				} = request.body as {
					sessionId: string;
					id: number[];
					channel?: string;
					downloadMedia?: boolean;
				};

				if (!sessionId || !id?.length) {
					return new ErrorResponse("sessionId and id are required", 400).send(
						reply,
					);
				}

				try {
					const result = await this.withTelegramSession(
						sessionId,
						async (clientService) => {
							const tc = clientService.getClient();
							const inputIds = id.map(
								(msgId) => new Api.InputMessageID({ id: msgId }),
							);

							let rawResult: Api.messages.TypeMessages;

							if (channel) {
								let resolvedChannel: Awaited<
									ReturnType<typeof tc.getInputEntity>
								>;
								try {
									resolvedChannel = await tc.getInputEntity(channel);
								} catch {
									await tc.getDialogs({ limit: 200 });
									resolvedChannel = await tc.getInputEntity(channel);
								}

								rawResult = await tc.invoke(
									new Api.channels.GetMessages({
										channel: resolvedChannel,
										id: inputIds,
									}),
								);
							} else {
								rawResult = await tc.invoke(
									new Api.messages.GetMessages({ id: inputIds }),
								);
							}

							if (!downloadMedia) return rawResult;

							const rawMessages: Api.TypeMessage[] =
								"messages" in rawResult
									? (rawResult.messages as Api.TypeMessage[])
									: [];

							const attachmentsMap = new Map<number, S3Attachment[]>();

							await Promise.all(
								rawMessages.map(async (msg) => {
									if (!(msg instanceof Api.Message)) return;
									const peerId = channel ?? sessionId;
									const entries = await downloadAndUploadToS3(tc, msg, peerId);
									if (entries.length > 0) {
										attachmentsMap.set(msg.id, entries);
									}
								}),
							);

							const serialized = JSON.parse(JSON.stringify(rawResult)) as {
								messages?: Array<Record<string, unknown>>;
								[key: string]: unknown;
							};

							if (serialized.messages) {
								for (const msg of serialized.messages) {
									const entries = attachmentsMap.get(msg.id as number);
									if (entries) {
										msg.attachments = entries;
									}
								}
							}

							return serialized;
						},
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

		/**
		 * Downloads all media attachments from the specified messages via GramJS,
		 * uploads them to S3, and returns permanent public URLs.
		 *
		 * Supports photos, documents, videos, and audio files.
		 * Requires S3 to be configured (S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY).
		 *
		 * - Omit `channel` for private chats and basic groups.
		 * - Supply `channel` for supergroups and channels.
		 */
		fastify.post(
			"/messages/DownloadAttachments",
			async (request: FastifyRequest, reply: FastifyReply) => {
				const {
					sessionId,
					peer,
					messageIds,
					channel,
				} = request.body as {
					sessionId: string;
					peer: string;
					messageIds: number[];
					channel?: string;
				};

				if (!sessionId || !peer || !messageIds?.length) {
					return new ErrorResponse(
						"sessionId, peer and messageIds are required",
						400,
					).send(reply);
				}

				if (!S3UploadService.isConfigured()) {
					return new ErrorResponse(
						"S3 storage is not configured. Set S3_BUCKET, S3_ACCESS_KEY_ID, and S3_SECRET_ACCESS_KEY.",
						500,
					).send(reply);
				}

				try {
					const result = await this.withTelegramSession(
						sessionId,
						async (clientService) => {
							const tc = clientService.getClient();

							let resolvedPeer: Awaited<
								ReturnType<typeof tc.getInputEntity>
							>;
							try {
								resolvedPeer = await tc.getInputEntity(peer);
							} catch {
								await tc.getDialogs({ limit: 200 });
								resolvedPeer = await tc.getInputEntity(peer);
							}

							const inputIds = messageIds.map(
								(msgId) => new Api.InputMessageID({ id: msgId }),
							);

							let rawResult: Api.messages.TypeMessages;
							if (channel) {
								let resolvedChannel: Awaited<
									ReturnType<typeof tc.getInputEntity>
								>;
								try {
									resolvedChannel = await tc.getInputEntity(channel);
								} catch {
									await tc.getDialogs({ limit: 200 });
									resolvedChannel = await tc.getInputEntity(channel);
								}
								rawResult = await tc.invoke(
									new Api.channels.GetMessages({
										channel: resolvedChannel,
										id: inputIds,
									}),
								);
							} else {
								rawResult = await tc.invoke(
									new Api.messages.GetMessages({ id: inputIds }),
								);
							}

							const rawMessages: Api.TypeMessage[] =
								"messages" in rawResult
									? (rawResult.messages as Api.TypeMessage[])
									: [];

							const results: Array<{
								messageId: number;
								attachments: Array<{
									file_unique_id: string;
									file_type: string;
									url: string;
								}>;
							}> = [];

							await Promise.all(
								rawMessages.map(async (msg) => {
									if (!(msg instanceof Api.Message)) return;
									const attachments = await downloadAndUploadToS3(tc, msg, peer);
									if (attachments.length > 0) {
										results.push({
											messageId: msg.id,
											attachments,
										});
									}
								}),
							);

							return results;
						},
					);

			new SuccessResponse(
					result,
					"Attachments downloaded and uploaded successfully",
				).send(reply);
			} catch (error: unknown) {
				ErrorResponse.fromError(error).send(reply);
			}
		},
	);

	/**
	 * Returns the conversation history for a given peer.
	 *
	 * Supports pagination via offsetId / offsetDate / addOffset.
	 * Use minId / maxId to bound the result window.
	 */
	fastify.post(
		"/messages/GetHistory",
		async (request: FastifyRequest, reply: FastifyReply) => {
			const {
				sessionId,
				peer,
				offsetId = 0,
				offsetDate = 0,
				addOffset = 0,
				limit = 100,
				maxId = 0,
				minId = 0,
				hash = 0,
			} = request.body as {
				sessionId: string;
				peer: string;
				offsetId?: number;
				offsetDate?: number;
				addOffset?: number;
				limit?: number;
				maxId?: number;
				minId?: number;
				hash?: number;
			};

			if (!sessionId || !peer) {
				return new ErrorResponse("sessionId and peer are required", 400).send(reply);
			}

			try {
				const result = await this.withTelegramSession(
					sessionId,
					async (clientService) => {
						const tc = clientService.getClient();

						let resolvedPeer: Awaited<ReturnType<typeof tc.getInputEntity>>;
						try {
							resolvedPeer = await tc.getInputEntity(peer);
						} catch {
							await tc.getDialogs({ limit: 200 });
							resolvedPeer = await tc.getInputEntity(peer);
						}

						const rawResult = await tc.invoke(
							new Api.messages.GetHistory({
								peer: resolvedPeer,
								offsetId,
								offsetDate,
								addOffset,
								limit,
								maxId,
								minId,
								hash: BigInt(hash),
							}),
						);

						return rawResult;
					},
				);

				new SuccessResponse(result, "History fetched successfully").send(reply);
			} catch (error: unknown) {
				ErrorResponse.fromError(error).send(reply);
			}
		},
	);

	/**
	 * Returns the current user's dialog list (chats, groups, channels).
	 *
	 * Supports pagination via offsetDate / offsetId / offsetPeer.
	 * Set excludePinned: true to omit pinned dialogs.
	 * Use folderId to list dialogs inside a specific folder.
	 */
	fastify.post(
		"/messages/GetDialogs",
		async (request: FastifyRequest, reply: FastifyReply) => {
			const {
				sessionId,
				offsetDate = 0,
				offsetId = 0,
				offsetPeer = "me",
				limit = 100,
				hash = 0,
				excludePinned = false,
				folderId,
			} = request.body as {
				sessionId: string;
				offsetDate?: number;
				offsetId?: number;
				offsetPeer?: string;
				limit?: number;
				hash?: number;
				excludePinned?: boolean;
				folderId?: number;
			};

			if (!sessionId) {
				return new ErrorResponse("sessionId is required", 400).send(reply);
			}

			try {
				const result = await this.withTelegramSession(
					sessionId,
					async (clientService) => {
						const tc = clientService.getClient();

						let resolvedOffsetPeer: Awaited<ReturnType<typeof tc.getInputEntity>>;
						try {
							resolvedOffsetPeer = await tc.getInputEntity(offsetPeer);
						} catch {
							await tc.getDialogs({ limit: 200 });
							resolvedOffsetPeer = await tc.getInputEntity(offsetPeer);
						}

						return tc.invoke(
							new Api.messages.GetDialogs({
								offsetDate,
								offsetId,
								offsetPeer: resolvedOffsetPeer,
								limit,
								hash: BigInt(hash),
								excludePinned,
								...(folderId !== undefined && { folderId }),
							}),
						);
					},
				);

				new SuccessResponse(result, "Dialogs fetched successfully").send(reply);
			} catch (error: unknown) {
				ErrorResponse.fromError(error).send(reply);
			}
		},
	);
}
}
