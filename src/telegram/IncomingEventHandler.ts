import { Api, TelegramClient } from "telegram";
import { NewMessage, NewMessageEvent, Raw } from "telegram/events";
import { Prisma } from "@prisma/client";
import { DatabaseClient } from "../database/DatabaseClient";

const ALBUM_BUFFER_MS = parseInt(process.env.ALBUM_BUFFER_MS ?? "300", 10);
const INIT_DELAY_MS = 5000;

interface AlbumEntry {
	events: NewMessageEvent[];
	timer: NodeJS.Timeout;
}

interface ParsedMedia {
	fileUniqueId: string;
	fileType: string;
	rawInputJson: string;
}

/**
 * Unified handler for all incoming Telegram events on a single user session.
 *
 * Responsibilities:
 *  - New messages (including album batches) → stored with attachment download tasks
 *  - Edit messages → stored with attachment download tasks (same dedup logic)
 *  - Delete, reaction, participant, pin events → stored directly as raw_payload
 *
 * After a file is downloaded, DownloadWorkerService patches the `attachments`
 * key on the associated message's raw_payload automatically.
 */
export class IncomingEventHandler {
	private readonly client: TelegramClient;
	private readonly telegramUserId: string;
	private readonly sessionId: string;

	private newMessageHandler: ((event: NewMessageEvent) => void) | null = null;
	private rawHandler: ((update: Api.TypeUpdate) => void) | null = null;

	private readonly albumBuffers = new Map<string, AlbumEntry>();

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
		this.newMessageHandler = (event: NewMessageEvent) => {
			this.bufferNewMessage(event);
		};

		this.rawHandler = (update: Api.TypeUpdate) => {
			this.handleRawUpdate(update);
		};

		this.client.addEventHandler(
			this.newMessageHandler,
			new NewMessage({ incoming: true }),
		);
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
		if (this.newMessageHandler) {
			this.client.removeEventHandler(
				this.newMessageHandler,
				new NewMessage({ incoming: true }),
			);
			this.newMessageHandler = null;
		}
		if (this.rawHandler) {
			this.client.removeEventHandler(this.rawHandler, new Raw({}));
			this.rawHandler = null;
		}
		for (const [, entry] of this.albumBuffers) {
			clearTimeout(entry.timer);
		}
		this.albumBuffers.clear();
	}

	// ── Album Buffer ─────────────────────────────────────────────────────

	/**
	 * Buffers messages that share a `grouped_id` (albums) and flushes them
	 * as a batch after a short debounce window.  Non-grouped messages are
	 * flushed immediately as single-element batches.
	 */
	private bufferNewMessage(event: NewMessageEvent): void {
		const groupedId = event.message.groupedId?.toString();

		if (!groupedId) {
			this.persistNewMessageBatch([event]).catch((err) =>
				console.error("[EventHandler] Error persisting message:", err),
			);
			return;
		}

		const existing = this.albumBuffers.get(groupedId);
		if (existing) {
			clearTimeout(existing.timer);
			existing.events.push(event);
		} else {
			this.albumBuffers.set(groupedId, { events: [event], timer: null! });
		}

		const entry = this.albumBuffers.get(groupedId)!;
		entry.timer = setTimeout(() => {
			const buffered = this.albumBuffers.get(groupedId);
			if (!buffered) return;
			this.albumBuffers.delete(groupedId);
			this.persistNewMessageBatch(buffered.events).catch((err) =>
				console.error("[EventHandler] Error persisting album batch:", err),
			);
		}, ALBUM_BUFFER_MS);
	}

	// ── New Message Persistence ──────────────────────────────────────────

	/**
	 * Each message in the batch (including album members) is stored as its own
	 * row so that raw_payload is exactly the Telegram message object.
	 */
	private async persistNewMessageBatch(
		events: NewMessageEvent[],
	): Promise<void> {
		const sessionRecordId = await this.resolveSessionRecordId();
		if (sessionRecordId === null) {
			console.error(
				`[EventHandler] No active session record found for ${this.sessionId}`,
			);
			return;
		}

		for (const event of events) {
			const media = this.extractMedia(event.message);
			const rawPayload = this.serializeBigInt(event.message);
			await this.persistMessageWithMedia(
				sessionRecordId,
				rawPayload,
				media ? [media] : [],
			);
		}
	}

	// ── Edit Message Persistence ─────────────────────────────────────────

	private async persistEditMessage(
		update: Api.UpdateEditMessage | Api.UpdateEditChannelMessage,
	): Promise<void> {
		const sessionRecordId = await this.resolveSessionRecordId();
		if (sessionRecordId === null) return;

		const message = update.message as Api.Message;
		const media = this.extractMedia(message);
		const rawPayload = this.serializeBigInt(message);

		await this.persistMessageWithMedia(
			sessionRecordId,
			rawPayload,
			media ? [media] : [],
		);
	}

	// ── Shared: Message + Attachment Download Task ───────────────────────

	/**
	 * Creates a message row, links attachment rows, and upserts download tasks.
	 *
	 * Dedup behaviour:
	 *  - Task already completed → reuse file_url immediately, mark downloaded
	 *  - Task pending / processing → add this session to from_accounts so any
	 *    active worker can use it; DownloadWorkerService patches the payload
	 *    once complete
	 *  - Task does not exist → create it
	 */
	private async persistMessageWithMedia(
		sessionRecordId: number,
		rawPayload: string,
		mediaList: ParsedMedia[],
	): Promise<void> {
		const hasAttachments = mediaList.length > 0;
		const db = DatabaseClient.getInstance();

		await db.execute(async (prisma) => {
			return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
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
					const existingTask = await tx.downloadTask.findUnique({
						where: { file_unique_id: media.fileUniqueId },
					});

					let fileUrl: string | null = null;

					if (existingTask?.status === "completed") {
						fileUrl = existingTask.file_url ?? null;
					} else if (!existingTask) {
						await tx.downloadTask.create({
							data: {
								file_unique_id: media.fileUniqueId,
								file_type: media.fileType,
								raw_input_json: media.rawInputJson,
								from_accounts: [sessionRecordId],
							},
						});
					} else if (!existingTask.from_accounts.includes(sessionRecordId)) {
						// Let an already-running worker serve this session too
						await tx.downloadTask.update({
							where: { file_unique_id: media.fileUniqueId },
							data: { from_accounts: { push: sessionRecordId } },
						});
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

				// All attachments were already downloaded — patch payload immediately
				if (resolvedUrls.every((u) => u !== null)) {
					let updatedPayload = rawPayload;
					try {
						const parsed = JSON.parse(rawPayload);
						parsed.attachments = mediaList.map((m, i) => ({
							file_unique_id: m.fileUniqueId,
							file_type: m.fileType,
							url: resolvedUrls[i],
						}));
						updatedPayload = JSON.stringify(parsed);
					} catch {
						// Leave raw_payload unchanged if JSON round-trip fails
					}

					await tx.message.update({
						where: { id: msgRecord.id },
						data: { status: "downloaded", raw_payload: updatedPayload },
					});
				}
			});
		});
	}

	// ── Raw Update Dispatch ──────────────────────────────────────────────

	private handleRawUpdate(update: Api.TypeUpdate): void {
		// NewMessage is already handled by the dedicated event handler above
		if (
			update instanceof Api.UpdateNewMessage ||
			update instanceof Api.UpdateNewChannelMessage
		) {
			return;
		}

		// Edit messages may carry attachments — handle like new messages
		if (
			(update instanceof Api.UpdateEditMessage ||
				update instanceof Api.UpdateEditChannelMessage) &&
			update.message instanceof Api.Message
		) {
			this.persistEditMessage(update).catch((err) =>
				console.error("[EventHandler] Edit message error:", err),
			);
			return;
		}

		// Store other notable event types directly
		if (this.isTrackedUpdate(update)) {
			this.persistRawUpdate(update).catch((err) =>
				console.error("[EventHandler] Raw update error:", err),
			);
		}
	}

	/**
	 * Returns true for events that are worth persisting but do not require
	 * attachment downloads:
	 *  - Message deletion
	 *  - Reactions
	 *  - Group / channel participant changes (join, leave, admin change)
	 *  - Pinned message changes
	 */
	private isTrackedUpdate(update: Api.TypeUpdate): boolean {
		return (
			update instanceof Api.UpdateDeleteMessages ||
			update instanceof Api.UpdateDeleteChannelMessages ||
			update instanceof Api.UpdateMessageReactions ||
			update instanceof Api.UpdateChatParticipant ||
			update instanceof Api.UpdateChannelParticipant ||
			update instanceof Api.UpdatePinnedMessages ||
			update instanceof Api.UpdatePinnedChannelMessages
		);
	}

	private async persistRawUpdate(update: Api.TypeUpdate): Promise<void> {
		const sessionRecordId = await this.resolveSessionRecordId();
		if (sessionRecordId === null) return;

		const db = DatabaseClient.getInstance();
		await db.execute((prisma) =>
			prisma.message.create({
				data: {
					session_id: sessionRecordId,
					raw_payload: this.serializeBigInt(update),
					status: "downloaded",
				},
			}),
		);
	}

	// ── Media Extraction ─────────────────────────────────────────────────

	private extractMedia(msg: Api.Message): ParsedMedia | null {
		const { media } = msg;
		if (!media) return null;

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
				}),
			};
		}

		return null;
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
		return JSON.stringify(value, (_, v) =>
			typeof v === "bigint" ? v.toString() : v,
		);
	}

	private async resolveSessionRecordId(): Promise<number | null> {
		const db = DatabaseClient.getInstance();
		const session = await db.execute(
			(prisma) =>
				prisma.telegramSession.findFirst({
					where: { session_id: this.sessionId, status: "active" },
					select: { id: true },
				}) as Promise<{ id: number } | null>,
		);
		return session?.id ?? null;
	}

	private delay(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}
}
