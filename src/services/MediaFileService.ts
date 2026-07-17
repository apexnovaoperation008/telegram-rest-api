import { Api, TelegramClient } from "teleproto";
import bigInt from "big-integer";
import FileType from "file-type";
import { S3UploadService } from "./S3UploadService";

/**
 * Downloads Telegram avatars (channel, chat, user) and uploads them to S3.
 *
 * S3 path layout:
 *   avatar/chats/<chatOrChannelId>/<photoId>.<ext>
 *   avatar/users/<userId>/<photoId>.<ext>
 *
 * If the file already exists in S3, the public URL is returned directly
 * without re-downloading.
 */
export class MediaFileService {
	static async downloadChannelPhoto(
		client: TelegramClient,
		channelId: string,
		accessHash: string,
		photo: Api.ChatPhoto,
	): Promise<string | null> {
		const photoId = photo.photoId.toString();

		return this.getOrUpload(
			`avatar/chats/${channelId}`,
			photoId,
			async () => {
				const location = new Api.InputPeerPhotoFileLocation({
					peer: new Api.InputPeerChannel({
						channelId: bigInt(channelId),
						accessHash: bigInt(accessHash),
					}),
					photoId: bigInt(photoId),
					big: true,
				});
				const result = await client.downloadFile(location, {
					dcId: photo.dcId,
				});
				return this.toBuffer(result);
			},
		);
	}

	static async downloadChatPhoto(
		client: TelegramClient,
		chatId: string,
		photo: Api.ChatPhoto,
	): Promise<string | null> {
		const photoId = photo.photoId.toString();

		return this.getOrUpload(
			`avatar/chats/${chatId}`,
			photoId,
			async () => {
				const location = new Api.InputPeerPhotoFileLocation({
					peer: new Api.InputPeerChat({ chatId: bigInt(chatId) }),
					photoId: bigInt(photoId),
					big: true,
				});
				const result = await client.downloadFile(location, {
					dcId: photo.dcId,
				});
				return this.toBuffer(result);
			},
		);
	}

	static async downloadUserPhoto(
		client: TelegramClient,
		userId: string,
		accessHash: string,
		photo: Api.UserProfilePhoto,
	): Promise<string | null> {
		const photoId = photo.photoId.toString();

		return this.getOrUpload(
			`avatar/users/${userId}`,
			photoId,
			async () => {
				const location = new Api.InputPeerPhotoFileLocation({
					peer: new Api.InputPeerUser({
						userId: bigInt(userId),
						accessHash: bigInt(accessHash),
					}),
					photoId: bigInt(photoId),
					big: true,
				});
				const result = await client.downloadFile(location, {
					dcId: photo.dcId,
				});
				return this.toBuffer(result);
			},
		);
	}

	/**
	 * Checks S3 for an existing file; if found returns its public URL.
	 * Otherwise downloads the file, detects its extension, uploads to S3,
	 * and returns the public URL.
	 */
	private static async getOrUpload(
		subPath: string,
		fileId: string,
		download: () => Promise<Buffer>,
	): Promise<string | null> {
		const placeholderKey = S3UploadService.buildKey(
			`${fileId}.jpg`,
			subPath,
		);
		const existing = await S3UploadService.exists(placeholderKey);
		if (existing) return existing;

		const buffer = await download();
		if (!buffer || buffer.length === 0) return null;

		const detected = await FileType.fromBuffer(buffer);
		const ext = detected?.ext ?? "jpg";
		const fileName = `${fileId}.${ext}`;

		if (ext !== "jpg") {
			const exactKey = S3UploadService.buildKey(fileName, subPath);
			const exactExisting = await S3UploadService.exists(exactKey);
			if (exactExisting) return exactExisting;
		}

		return S3UploadService.upload(buffer, fileName, undefined, subPath);
	}

	private static toBuffer(result: string | Buffer | undefined): Buffer {
		if (Buffer.isBuffer(result)) return result;
		if (typeof result === "string") return Buffer.from(result, "binary");
		return Buffer.alloc(0);
	}
}
