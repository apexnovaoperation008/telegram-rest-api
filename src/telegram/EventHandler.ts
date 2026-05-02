import { Api, TelegramClient } from "telegram";
import { Raw } from "telegram/events";
import { UpdateConnectionState } from "telegram/network";
import { Prisma } from "@prisma/client";
import { DatabaseClient } from "../database/DatabaseClient";

const INIT_DELAY_MS = 5000;
const SERVER_NAME = process.env.SERVER_NAME ?? "";

function patchPayloadWithMedia(
	parsed: Record<string, unknown>,
	mediaList: ParsedMedia[],
	urls: string[],
): void {
	const chatPhoto = mediaList.find((m) => m.fileType === "chat_photo");
	if (chatPhoto) {
		parsed.image_link = urls[mediaList.indexOf(chatPhoto)];
	}

	const regular = mediaList.filter((m) => m.fileType !== "chat_photo");
	if (regular.length > 0) {
		parsed.attachments = regular.map((m) => ({
			file_unique_id: m.fileUniqueId,
			file_type: m.fileType,
			url: urls[mediaList.indexOf(m)],
		}));
	}

	// This function is only called when every URL is already resolved,
	// meaning all downloads completed successfully.
	parsed.download_failed = false;
}

interface ParsedMedia {
	fileUniqueId: string;
	fileType: string;
	rawInputJson: string;
}

export class EventHandler {
	private readonly client: TelegramClient;
	private readonly telegramUserId: string;
	private readonly sessionId: string;

	private rawHandler: ((update: Api.TypeUpdate) => void) | null = null;

	constructor(
		client: TelegramClient,
		telegramUserId: string,
		sessionId: string,
	) {
		this.client = client;
		this.telegramUserId = telegramUserId;
		this.sessionId = sessionId;
	}

	async start(): Promise<void> {
		this.rawHandler = (update: Api.TypeUpdate) => {
			this.handleRawUpdate(update);
		};

		this.client.addEventHandler(this.rawHandler, new Raw({}));

		await this.delay(INIT_DELAY_MS);

		try {
			await this.client.getDialogs({ limit: 100 });
		} catch {
			// Non-fatal — events still work if update state is already present
		}

		console.log(`[EventHandler] Started for user ${this.telegramUserId}`);
	}

	stop(): void {
		if (this.rawHandler) {
			this.client.removeEventHandler(this.rawHandler, new Raw({}));
			this.rawHandler = null;
		}
	}

	private handleRawUpdate(update: Api.TypeUpdate): void {
		// Block these events from being persisted
		if (
			update instanceof Api.UpdateUserTyping ||
			update instanceof Api.UpdateChatUserTyping ||
			update instanceof UpdateConnectionState ||
			update instanceof Api.UpdateUserStatus
		) {
			return;
		}

		this.persistUpdate(update).catch((err) =>
			console.error("[EventHandler] Error persisting update:", err),
		);
	}

	private async persistUpdate(update: Api.TypeUpdate): Promise<void> {
		const sessionRecord = await this.resolveSessionRecord();
		if (sessionRecord === null) return;

		const mediaList = this.extractMediaFromUpdate(update);
		const payload = this.extractSerializablePayload(update);
		const serialized = this.serializeBigInt(payload);
		const parsed = JSON.parse(serialized) as Record<string, unknown>;
		parsed.receiverId = {
			userId: sessionRecord.telegram_user_id,
			className: "PeerUser",
		};
		parsed.isOutgoingMessage = this.isOutgoingMessage(update);
		const rawPayload = JSON.stringify(parsed);

		await this.persistMessageWithMedia(sessionRecord.id, rawPayload, mediaList);
	}

	/**
	 * Raw updates that carry a `.message` hold circular refs back to the
	 * TelegramClient. Extract just the message for those; other update
	 * types (deletes, reactions, etc.) are safe to serialize directly.
	 */
	private extractSerializablePayload(update: Api.TypeUpdate): unknown {
		if (
			(update instanceof Api.UpdateNewMessage ||
				update instanceof Api.UpdateNewChannelMessage ||
				update instanceof Api.UpdateEditMessage ||
				update instanceof Api.UpdateEditChannelMessage) &&
			update.message
		) {
			return update.message;
		}
		return update;
	}

	private extractMediaFromUpdate(update: Api.TypeUpdate): ParsedMedia[] {
		const message = this.extractMessageFromUpdate(update);
		if (!message) return [];

		if (message instanceof Api.MessageService) {
			const { action } = message;
			if (
				action instanceof Api.MessageActionChatEditPhoto &&
				action.photo instanceof Api.Photo
			) {
				return [this.extractChatPhoto(action.photo, message)];
			}
			return [];
		}

		if (message instanceof Api.Message) {
			const media = this.extractMedia(message);
			return media ? [media] : [];
		}

		return [];
	}

	private extractMessageFromUpdate(
		update: Api.TypeUpdate,
	): Api.Message | Api.MessageService | null {
		if (
			(update instanceof Api.UpdateNewMessage ||
				update instanceof Api.UpdateNewChannelMessage ||
				update instanceof Api.UpdateEditMessage ||
				update instanceof Api.UpdateEditChannelMessage) &&
			(update.message instanceof Api.Message ||
				update.message instanceof Api.MessageService)
		) {
			return update.message;
		}
		return null;
	}

	// ── Persistence ─────────────────────────────────────────────────────

	private static readonly UNIQUE_CONFLICT_MAX_RETRIES = 3;

	private async persistMessageWithMedia(
		sessionRecordId: bigint,
		rawPayload: string,
		mediaList: ParsedMedia[],
	): Promise<void> {
		const hasAttachments = mediaList.length > 0;
		const db = DatabaseClient.getInstance();

		for (
			let attempt = 0;
			attempt <= EventHandler.UNIQUE_CONFLICT_MAX_RETRIES;
			attempt++
		) {
			try {
				await db.execute(async (prisma) => {
					return prisma.$transaction(
						async (tx: Prisma.TransactionClient) => {
							const msgRecord = await tx.message.create({
								data: {
									session_id: sessionRecordId,
									raw_payload: rawPayload,
									status: hasAttachments ? "pending" : "downloaded",
								},
							});

							if (!hasAttachments) return;

							const resolvedUrls: (string | null)[] = [];

							for (const media of mediaList) {
								const existing = await tx.downloadTask.findUnique({
									where: { file_unique_id: media.fileUniqueId },
								});

								let task;
								if (!existing) {
									task = await tx.downloadTask.create({
										data: {
											file_unique_id: media.fileUniqueId,
											file_type: media.fileType,
											raw_input_json: media.rawInputJson,
											from_accounts: [sessionRecordId],
											owner_session_id: sessionRecordId,
											server_name: SERVER_NAME,
										},
									});
								} else if (existing.status === "failed") {
									task = await tx.downloadTask.update({
										where: { id: existing.id },
										data: {
											status: "pending",
											retry_count: 0,
											raw_input_json: media.rawInputJson,
											owner_session_id: sessionRecordId,
											server_name: SERVER_NAME,
											started_at: null,
											worker_id: null,
											...(existing.from_accounts.includes(
												sessionRecordId,
											)
												? {}
												: {
														from_accounts: {
															push: sessionRecordId,
														},
													}),
										},
									});
								} else {
									// Pending / processing / completed — never overwrite raw_input_json;
									// the existing data is tied to a specific account's fileReference,
									// accessHash, and messageId.
									task = existing.from_accounts.includes(
										sessionRecordId,
									)
										? existing
										: await tx.downloadTask.update({
												where: { id: existing.id },
												data: {
													from_accounts: {
														push: sessionRecordId,
													},
												},
											});
								}

								let fileUrl: string | null = null;
								if (task.status === "completed") {
									fileUrl = task.file_url ?? null;
								}

								await tx.attachment.create({
									data: {
										message_id: msgRecord.id,
										file_unique_id: media.fileUniqueId,
										file_type: media.fileType,
										file_url: fileUrl,
									},
								});

								resolvedUrls.push(fileUrl);
							}

							if (resolvedUrls.every((u) => u !== null)) {
								let updatedPayload = rawPayload;
								try {
									const parsed = JSON.parse(rawPayload);
									patchPayloadWithMedia(
										parsed,
										mediaList,
										resolvedUrls as string[],
									);
									updatedPayload = JSON.stringify(parsed);
								} catch {
									// Leave raw_payload unchanged if JSON round-trip fails
								}

								await tx.message.update({
									where: { id: msgRecord.id },
									data: {
										status: "downloaded",
										raw_payload: updatedPayload,
									},
								});
							}
						},
					);
				});
				return;
			} catch (error) {
				const isUniqueViolation =
					error instanceof Prisma.PrismaClientKnownRequestError &&
					error.code === "P2002" &&
					(error.meta?.target as string[] | undefined)?.includes(
						"file_unique_id",
					);

				if (
					isUniqueViolation &&
					attempt < EventHandler.UNIQUE_CONFLICT_MAX_RETRIES
		) {
			continue;
				}
				throw error;
			}
		}
	}

	// ── Outgoing Detection ──────────────────────────────────────────────

	private isOutgoingMessage(update: Api.TypeUpdate): boolean {
		const message = this.extractMessageFromUpdate(update);
		if (!message) return false;
		return "out" in message && message.out === true;
	}

	// ── Media Extraction ────────────────────────────────────────────────

	private extractMedia(msg: Api.Message): ParsedMedia | null {
		const { media } = msg;
		if (!media) return null;

		const { peerId, peerType } = this.extractPeerInfo(msg.peerId);

		if (
			media instanceof Api.MessageMediaPhoto &&
			media.photo instanceof Api.Photo
		) {
			const { photo } = media;
			const bestSize = photo.sizes[photo.sizes.length - 1];
			const thumbType =
				"type" in bestSize ? (bestSize as Api.PhotoSize).type : "x";

			return {
				fileUniqueId: `photo_${photo.id.toString()}`,
				fileType: "photo",
				rawInputJson: JSON.stringify({
					type: "photo",
					id: photo.id.toString(),
					accessHash: photo.accessHash.toString(),
					fileReference: Buffer.from(photo.fileReference).toString("base64"),
					thumbSize: thumbType,
					dcId: photo.dcId,
					messageId: msg.id,
					peerId,
					peerType,
				}),
			};
		}

		if (
			media instanceof Api.MessageMediaDocument &&
			media.document instanceof Api.Document
		) {
			const { document: doc } = media;
			let fileType = "document";
			if (doc.mimeType?.startsWith("video/")) fileType = "video";
			else if (doc.mimeType?.startsWith("audio/")) fileType = "audio";

			return {
				fileUniqueId: `doc_${doc.id.toString()}`,
				fileType,
				rawInputJson: JSON.stringify({
					type: "document",
					id: doc.id.toString(),
					accessHash: doc.accessHash.toString(),
					fileReference: Buffer.from(doc.fileReference).toString("base64"),
					thumbSize: "",
					dcId: doc.dcId,
					mimeType: doc.mimeType,
					fileName: this.extractFileName(doc),
					messageId: msg.id,
					peerId,
					peerType,
				}),
			};
		}

		return null;
	}

	private extractChatPhoto(
		photo: Api.Photo,
		message: Api.MessageService,
	): ParsedMedia {
		const { peerId, peerType } = this.extractPeerInfo(message.peerId);

		return {
			fileUniqueId: `photo_${photo.id.toString()}`,
			fileType: "chat_photo",
			rawInputJson: JSON.stringify({
				type: "chat_photo",
				photoId: photo.id.toString(),
				peerId,
				peerType,
				dcId: photo.dcId,
			}),
		};
	}

	private extractPeerInfo(peer: Api.TypePeer): {
		peerId: string;
		peerType: "user" | "chat" | "channel";
	} {
		if (peer instanceof Api.PeerChannel) {
			return { peerId: peer.channelId.toString(), peerType: "channel" };
		}
		if (peer instanceof Api.PeerChat) {
			return { peerId: peer.chatId.toString(), peerType: "chat" };
		}
		return {
			peerId: (peer as Api.PeerUser).userId.toString(),
			peerType: "user",
		};
	}

	private extractFileName(doc: Api.Document): string {
		for (const attr of doc.attributes) {
			if (attr instanceof Api.DocumentAttributeFilename) {
				return attr.fileName;
			}
		}
		const ext =
			(doc.mimeType ?? "application/octet-stream").split("/")[1] ?? "bin";
		return `${doc.id}.${ext}`;
	}

	// ── Helpers ──────────────────────────────────────────────────────────

	private serializeBigInt(value: unknown): string {
		const seen = new WeakSet();
		return JSON.stringify(value, (k, v) => {
			if (k === "_client") return undefined;
			if (typeof v === "bigint") return v.toString();
			if (typeof v === "object" && v !== null) {
				if (seen.has(v)) return undefined;
				seen.add(v);
			}
			return v;
		});
	}

	private async resolveSessionRecord(): Promise<{
		id: bigint;
		telegram_user_id: string;
	} | null> {
		const db = DatabaseClient.getInstance();
		return db.execute(
			(prisma) =>
				prisma.telegramSession.findFirst({
					where: { session_id: this.sessionId, status: "active" },
					select: { id: true, telegram_user_id: true },
				}) as Promise<{ id: bigint; telegram_user_id: string } | null>,
		);
	}

	private delay(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}
}
