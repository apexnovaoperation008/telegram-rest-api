import { Api, TelegramClient } from "telegram";
import bigInt from "big-integer";
import * as fs from "fs";
import * as path from "path";
import FileType from "file-type";
import { DatabaseClient } from "../database/DatabaseClient";

const PROFILES_DIR = path.resolve(process.cwd(), "storage", "profiles");
const STORAGE_BASE_URL = process.env.STORAGE_BASE_URL ?? "";
const RETENTION_DAYS = parseInt(process.env.MEDIA_RETENTION_DAYS ?? "1", 10);

/**
 * Handles synchronous on-demand media downloads (channel avatars, topic icons).
 * Files are stored under storage/profiles/ and tracked in the media_files table
 * for scheduled cleanup after MEDIA_RETENTION_DAYS days.
 * Repeated calls for the same file_key refresh the expiry rather than
 * re-downloading, unless the existing record has already expired.
 */
export class MediaFileService {
	/**
	 * Downloads the full-size photo of a channel/supergroup using
	 * InputPeerPhotoFileLocation (no expiring fileReference required).
	 * The file extension is detected from the downloaded bytes.
	 */
	static async downloadChannelPhoto(
		client: TelegramClient,
		channelId: string,
		accessHash: string,
		photo: Api.ChatPhoto,
	): Promise<string | null> {
		const fileKey = `channel_photo_${channelId}_${photo.photoId.toString()}`;

		return this.getOrDownload(fileKey, async () => {
			const location = new Api.InputPeerPhotoFileLocation({
				peer: new Api.InputPeerChannel({
					channelId: bigInt(channelId),
					accessHash: bigInt(accessHash),
				}),
				photoId: bigInt(photo.photoId.toString()),
				big: true,
			});
			const result = await client.downloadFile(location, {
				dcId: photo.dcId,
			});
			return this.toBuffer(result);
		});
	}

	/**
	 * Downloads the full-size photo of a basic group chat using
	 * InputPeerPhotoFileLocation. Basic groups only need the chatId —
	 * no access hash is required.
	 * The file extension is detected from the downloaded bytes.
	 */
	static async downloadChatPhoto(
		client: TelegramClient,
		chatId: string,
		photo: Api.ChatPhoto,
	): Promise<string | null> {
		const fileKey = `chat_photo_${chatId}_${photo.photoId.toString()}`;

		return this.getOrDownload(fileKey, async () => {
			const location = new Api.InputPeerPhotoFileLocation({
				peer: new Api.InputPeerChat({ chatId: bigInt(chatId) }),
				photoId: bigInt(photo.photoId.toString()),
				big: true,
			});
			const result = await client.downloadFile(location, {
				dcId: photo.dcId,
			});
			return this.toBuffer(result);
		});
	}

	/**
	 * Downloads the full-size profile photo of a Telegram user.
	 * The file extension is detected from the downloaded bytes.
	 */
	static async downloadUserPhoto(
		client: TelegramClient,
		userId: string,
		accessHash: string,
		photo: Api.UserProfilePhoto,
	): Promise<string | null> {
		const fileKey = `user_photo_${userId}_${photo.photoId.toString()}`;

		return this.getOrDownload(fileKey, async () => {
			const location = new Api.InputPeerPhotoFileLocation({
				peer: new Api.InputPeerUser({
					userId: bigInt(userId),
					accessHash: bigInt(accessHash),
				}),
				photoId: bigInt(photo.photoId.toString()),
				big: true,
			});
			const result = await client.downloadFile(location, {
				dcId: photo.dcId,
			});
			return this.toBuffer(result);
		});
	}

	/**
	 * Downloads the icon for a forum topic by resolving the custom emoji
	 * document and downloading it from Telegram.
	 * The file extension is detected from the downloaded bytes.
	 */
	static async downloadTopicIcon(
		client: TelegramClient,
		iconEmojiId: string,
	): Promise<string | null> {
		const fileKey = `topic_icon_${iconEmojiId}`;

		try {
			const docs = await client.invoke(
				new Api.messages.GetCustomEmojiDocuments({
					documentId: [bigInt(iconEmojiId)],
				}),
			);

			if (!docs.length) return null;
			const doc = docs[0];
			if (!(doc instanceof Api.Document)) return null;

			return this.getOrDownload(fileKey, async () => {
				const location = new Api.InputDocumentFileLocation({
					id: bigInt(doc.id.toString()),
					accessHash: bigInt(doc.accessHash.toString()),
					fileReference: doc.fileReference,
					thumbSize: "",
				});
				const result = await client.downloadFile(location, {
					dcId: doc.dcId ?? 1,
				});
				return this.toBuffer(result);
			});
		} catch (err) {
			console.error(
				`[MediaFileService] Failed to download topic icon ${iconEmojiId}:`,
				err instanceof Error ? err.message : err,
			);
			return null;
		}
	}

	/**
	 * Iterates a raw GramJS users array, downloads each user's profile photo,
	 * and injects avatar_url into the corresponding entry in the already-serialized
	 * plain-object users array. Failures are logged and silently skipped.
	 */
	static async injectUserAvatars(
		client: TelegramClient,
		rawUsers: Api.TypeUser[],
		serializedUsers: Array<Record<string, unknown>>,
	): Promise<void> {
		await Promise.all(
			rawUsers.map(async (user) => {
				if (!(user instanceof Api.User)) return;
				if (!(user.photo instanceof Api.UserProfilePhoto)) return;

				const avatarUrl = await this.downloadUserPhoto(
					client,
					user.id.toString(),
					user.accessHash?.toString() ?? "0",
					user.photo,
				).catch((err) => {
					console.error(
						`[MediaFileService] User photo download failed for ${user.id}:`,
						err instanceof Error ? err.message : err,
					);
					return null;
				});

				const entry = serializedUsers.find(
					(u) => String(u.id) === user.id.toString(),
				);
				if (entry) entry.avatar_url = avatarUrl;
			}),
		);
	}

	/**
	 * Returns the URL for an existing non-expired record (refreshing its expiry),
	 * or runs the download callback, detects the extension from the buffer's magic
	 * bytes, persists the file under storage/profiles/, and tracks it in the DB.
	 */
	private static async getOrDownload(
		fileKey: string,
		download: () => Promise<Buffer>,
	): Promise<string | null> {
		const db = DatabaseClient.getInstance();
		const expiresAt = new Date(Date.now() + RETENTION_DAYS * 86_400_000);

		const existing = await db.execute((prisma) =>
			prisma.mediaFile.findUnique({ where: { file_key: fileKey } }),
		);

		if (existing && existing.expires_at > new Date()) {
			await db.execute((prisma) =>
				prisma.mediaFile.update({
					where: { file_key: fileKey },
					data: { expires_at: expiresAt },
				}),
			);
			return existing.file_url;
		}

		const buffer = await download();
		if (!buffer || buffer.length === 0) return null;

		const detected = await FileType.fromBuffer(buffer);
		const ext = detected?.ext ?? "bin";

		if (!fs.existsSync(PROFILES_DIR)) {
			fs.mkdirSync(PROFILES_DIR, { recursive: true });
		}

		const fileName = `${fileKey}.${ext}`;
		const filePath = path.join(PROFILES_DIR, fileName);
		fs.writeFileSync(filePath, buffer);

		const relativePath = `storage/profiles/${fileName}`;
		const fileUrl = STORAGE_BASE_URL
			? `${STORAGE_BASE_URL.replace(/\/+$/, "")}/${relativePath}`
			: relativePath;

		await db.execute((prisma) =>
			prisma.mediaFile.upsert({
				where: { file_key: fileKey },
				create: {
					file_key: fileKey,
					file_path: filePath,
					file_url: fileUrl,
					expires_at: expiresAt,
				},
				update: {
					file_path: filePath,
					file_url: fileUrl,
					expires_at: expiresAt,
				},
			}),
		);

		return fileUrl;
	}

	private static toBuffer(result: string | Buffer | undefined): Buffer {
		if (Buffer.isBuffer(result)) return result;
		if (typeof result === "string") return Buffer.from(result, "binary");
		return Buffer.alloc(0);
	}
}
