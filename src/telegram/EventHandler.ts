import { Api, TelegramClient } from "telegram";
import { Raw } from "telegram/events";
import { UpdateConnectionState } from "telegram/network";
import bigInt from "big-integer";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { eq, and } from "drizzle-orm";
import { DatabaseClient } from "../database/DatabaseClient";
import { S3UploadService } from "../services/S3UploadService";
import { telegramSessions, messages } from "../database/schema";

const INIT_DELAY_MS = 5000;

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

	parsed.download_failed = false;
	parsed.media_downloaded = true;
}

interface ParsedMedia {
	fileUniqueId: string;
	fileType: string;
	rawInputJson: string;
}

interface RawInputPhoto {
	type: "photo";
	id: string;
	accessHash: string;
	fileReference: string;
	thumbSize: string;
	dcId: number;
	messageId: number;
	peerId: string;
	peerType: "user" | "chat" | "channel";
}

interface RawInputChatPhoto {
	type: "chat_photo";
	photoId: string;
	peerId: string;
	peerType: "chat" | "channel" | "user";
	dcId: number;
}

type RawInput = RawInputPhoto | RawInputChatPhoto;

/**
 * The minimal request context needed to reconstruct a sent message when
 * Telegram replies with a compact `UpdateShortSentMessage` (which omits the
 * peer and body).
 */
export interface SentMessageContext {
	peer: unknown;
	message?: string;
	entities?: Api.TypeMessageEntity[];
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

	/**
	 * Persists messages this session sent itself via the API (SendMessage /
	 * SendMedia / SendMultiMedia).
	 *
	 * GramJS returns the result of a send as the RPC response and never routes
	 * it through the realtime update stream this handler listens on, so without
	 * this the session's own outgoing messages are never stored or forwarded.
	 *
	 * Telegram replies in one of two shapes:
	 *   - `Updates` / `UpdatesCombined` — carries the full message (media, the
	 *     self/saved-messages chat, supergroups). We pull the message updates
	 *     straight out and persist them like any realtime update.
	 *   - `UpdateShortSentMessage` — a compact ack with only id/date/out and no
	 *     peer or body (the usual reply for private chats and basic groups). We
	 *     rebuild the `Message` from the original request the same way GramJS's
	 *     own `client.sendMessage()` does, tagging `fromId` with the session
	 *     user so downstream sender attribution is correct.
	 */
	async captureSentResult(
		result: unknown,
		context: SentMessageContext,
	): Promise<void> {
		for (const update of this.buildSentUpdates(result, context)) {
			await this.persistUpdate(update).catch((err) =>
				console.error(
					"[EventHandler] Error persisting sent message:",
					err instanceof Error ? err.message : err,
				),
			);
		}
	}

	private buildSentUpdates(
		result: unknown,
		context: SentMessageContext,
	): Api.TypeUpdate[] {
		if (
			result instanceof Api.Updates ||
			result instanceof Api.UpdatesCombined
		) {
			return result.updates.filter(
				(u) =>
					u instanceof Api.UpdateNewMessage ||
					u instanceof Api.UpdateNewChannelMessage ||
					u instanceof Api.UpdateChannel,
			);
		}

		if (result instanceof Api.UpdateShortSentMessage) {
			const peerId = this.inputPeerToPeer(context.peer);
			if (!peerId) return [];

			const message = new Api.Message({
				id: result.id,
				peerId,
				fromId: new Api.PeerUser({ userId: bigInt(this.telegramUserId) }),
				message: context.message ?? "",
				date: result.date,
				out: result.out,
				media: result.media ?? undefined,
				entities: result.entities ?? context.entities,
				ttlPeriod: result.ttlPeriod ?? undefined,
			});

			return [
				new Api.UpdateNewMessage({
					message,
					pts: result.pts,
					ptsCount: result.ptsCount,
				}),
			];
		}

		return [];
	}

	private inputPeerToPeer(peer: unknown): Api.TypePeer | null {
		if (peer instanceof Api.InputPeerUser) {
			return new Api.PeerUser({ userId: peer.userId });
		}
		if (peer instanceof Api.InputPeerChat) {
			return new Api.PeerChat({ chatId: peer.chatId });
		}
		if (peer instanceof Api.InputPeerChannel) {
			return new Api.PeerChannel({ channelId: peer.channelId });
		}
		if (peer instanceof Api.InputPeerSelf) {
			return new Api.PeerUser({ userId: bigInt(this.telegramUserId) });
		}
		return null;
	}

	private handleRawUpdate(update: Api.TypeUpdate): void {
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
		const hasMedia = this.messageHasMedia(update);
		const payload = this.extractSerializablePayload(update);
		const serialized = this.serializeBigInt(payload);
		const parsed = JSON.parse(serialized) as Record<string, unknown>;
		parsed.receiverId = {
			userId: sessionRecord.telegram_user_id,
			className: "PeerUser",
		};
		parsed.isOutgoingMessage = this.isOutgoingMessage(update);
		parsed.has_media = hasMedia;
		parsed.media_downloaded = false;

		if (mediaList.length > 0) {
			const urls = await this.downloadMediaInline(mediaList);
			const allResolved = urls.every((u) => u !== null);

			if (allResolved) {
				patchPayloadWithMedia(parsed, mediaList, urls as string[]);
			} else {
				parsed.download_failed = true;
			}
		}

		const rawPayload = JSON.stringify(parsed);
		const db = DatabaseClient.getInstance();
		await db.execute((d) =>
			d.insert(messages).values({
				session_id: sessionRecord.id,
				raw_payload: rawPayload,
				status: "downloaded",
				updated_at: new Date(),
			}),
		);
	}

	// ── Inline Download ─────────────────────────────────────────────────

	private async downloadMediaInline(
		mediaList: ParsedMedia[],
	): Promise<(string | null)[]> {
		return Promise.all(
			mediaList.map(async (media) => {
				try {
					const rawInput: RawInput = JSON.parse(media.rawInputJson);
					const buffer = await this.downloadFile(rawInput);
					if (!buffer || buffer.length === 0) return null;
					return await this.uploadFile(
						buffer,
						media.fileUniqueId,
						rawInput,
					);
				} catch (err) {
					console.error(
						`[EventHandler] Inline download failed for ${media.fileUniqueId}:`,
						err instanceof Error ? err.message : err,
					);
					return null;
				}
			}),
		);
	}

	private async downloadFile(rawInput: RawInput): Promise<Buffer> {
		if (rawInput.type === "chat_photo") {
			const peer = await this.resolveInputPeer(rawInput);
			const location = new Api.InputPeerPhotoFileLocation({
				peer,
				photoId: bigInt(rawInput.photoId),
				big: true,
			});
			const result = await this.client.downloadFile(location, {
				dcId: rawInput.dcId,
			});
			return this.toBuffer(result);
		}

		const location = new Api.InputPhotoFileLocation({
			id: bigInt(rawInput.id),
			accessHash: bigInt(rawInput.accessHash),
			fileReference: Buffer.from(rawInput.fileReference, "base64"),
			thumbSize: rawInput.thumbSize || "x",
		});
		const result = await this.client.downloadFile(location, {
			dcId: rawInput.dcId,
		});
		return this.toBuffer(result);
	}

	private async uploadFile(
		buffer: Buffer,
		fileUniqueId: string,
		rawInput: RawInput,
	): Promise<string> {
		const messageId = "messageId" in rawInput ? rawInput.messageId : 0;
		const fileName = `${messageId}_${fileUniqueId}.jpg`;
		const subPath = rawInput.peerId;

		const tmpPath = path.join(os.tmpdir(), `tg_upload_${fileName}`);
		fs.writeFileSync(tmpPath, buffer);
		try {
			return await S3UploadService.upload(
				buffer,
				fileName,
				"image/jpeg",
				subPath,
			);
		} finally {
			fs.unlink(tmpPath, () => {});
		}
	}

	private async resolveInputPeer(
		rawInput: RawInputChatPhoto,
	): Promise<Api.TypeInputPeer> {
		if (rawInput.peerType === "chat") {
			return new Api.InputPeerChat({ chatId: bigInt(rawInput.peerId) });
		}
		const peer =
			rawInput.peerType === "channel"
				? new Api.PeerChannel({ channelId: bigInt(rawInput.peerId) })
				: new Api.PeerUser({ userId: bigInt(rawInput.peerId) });
		return (await this.client.getInputEntity(peer)) as Api.TypeInputPeer;
	}

	private toBuffer(result: string | Buffer | undefined): Buffer {
		if (Buffer.isBuffer(result)) return result;
		if (typeof result === "string") return Buffer.from(result, "binary");
		if (result === undefined) return Buffer.alloc(0);
		return Buffer.from(result as unknown as ArrayBuffer);
	}

	// ── Serializable Payload ────────────────────────────────────────────

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

	// ── Outgoing Detection ──────────────────────────────────────────────

	private isOutgoingMessage(update: Api.TypeUpdate): boolean {
		const message = this.extractMessageFromUpdate(update);
		if (!message) return false;
		return "out" in message && message.out === true;
	}

	/**
	 * Returns true if the message in the update carries any media
	 * (photo, document, video, audio, or chat photo action).
	 */
	private messageHasMedia(update: Api.TypeUpdate): boolean {
		const message = this.extractMessageFromUpdate(update);
		if (!message) return false;

		if (message instanceof Api.MessageService) {
			return (
				message.action instanceof Api.MessageActionChatEditPhoto &&
				message.action.photo instanceof Api.Photo
			);
		}

		if (message instanceof Api.Message && message.media) {
			if (
				message.media instanceof Api.MessageMediaPhoto &&
				message.media.photo instanceof Api.Photo
			) {
				return true;
			}
			if (
				message.media instanceof Api.MessageMediaDocument &&
				message.media.document instanceof Api.Document
			) {
				return true;
			}
		}

		return false;
	}

	// ── Media Extraction ────────────────────────────────────────────────

	/**
	 * Only extracts photos for automatic download. Documents, videos, and
	 * audio are not auto-downloaded — use the /messages/DownloadAttachments
	 * endpoint to download them on demand.
	 */
	private extractMedia(msg: Api.Message): ParsedMedia | null {
		const { media } = msg;
		if (!media) return null;

		if (
			media instanceof Api.MessageMediaPhoto &&
			media.photo instanceof Api.Photo
		) {
			const { peerId, peerType } = this.extractPeerInfo(msg.peerId);
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
		const rows = await db.execute((d) =>
			d
				.select({
					id: telegramSessions.id,
					telegram_user_id: telegramSessions.telegram_user_id,
				})
				.from(telegramSessions)
				.where(
					and(
						eq(telegramSessions.session_id, this.sessionId),
						eq(telegramSessions.status, "active"),
					),
				)
				.limit(1),
		);
		return rows[0] ?? null;
	}

	private delay(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}
}
