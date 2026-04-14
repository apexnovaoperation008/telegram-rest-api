import { Api, TelegramClient } from "telegram";
import { CustomFile } from "telegram/client/uploads";
import bigInt from "big-integer";

export type MediaType = "photo" | "video" | "file";

export class TelegramUtils {
	/**
	 * Returns true when the error represents a Telegram 401 Unauthorized,
	 * which means the session is no longer valid and must be invalidated.
	 */
	static isUnauthorized(error: unknown): boolean {
		return (
			error instanceof Error &&
			"code" in error &&
			(error as Error & { code: unknown }).code === 401
		);
	}

	/**
	 * Downloads the content at `url` and returns a Buffer along with the
	 * filename inferred from the URL path and the MIME type from the
	 * Content-Type response header.
	 */
	static async downloadFromUrl(
		url: string,
	): Promise<{ buffer: Buffer; filename: string; mimeType: string }> {
		const response = await fetch(url);

		if (!response.ok) {
			throw new Error(
				`Failed to download file from "${url}": ${response.status} ${response.statusText}`,
			);
		}

		const buffer = Buffer.from(await response.arrayBuffer());
		const filename =
			new URL(url).pathname.split("/").pop() ?? "attachment";
		const mimeType =
			response.headers.get("content-type")?.split(";")[0].trim() ??
			"application/octet-stream";

		return { buffer, filename, mimeType };
	}

	/**
	 * Downloads a file from `url`, uploads it to Telegram via the provided
	 * client, and returns the appropriate `InputMedia` constructor based on
	 * the declared media type.
	 */
	static async uploadMedia(
		telegramClient: TelegramClient,
		url: string,
		type: MediaType,
	): Promise<Api.TypeInputMedia> {
		const { buffer, filename, mimeType } =
			await TelegramUtils.downloadFromUrl(url);

		const uploadedFile = await telegramClient.uploadFile({
			file: new CustomFile(filename, buffer.length, "", buffer),
			workers: 1,
		});

		if (type === "photo") {
			return new Api.InputMediaUploadedPhoto({ file: uploadedFile });
		}

		const attributes: Api.TypeDocumentAttribute[] =
			type === "video"
				? [new Api.DocumentAttributeVideo({ duration: 0, w: 0, h: 0 })]
				: [new Api.DocumentAttributeFilename({ fileName: filename })];

		return new Api.InputMediaUploadedDocument({
			file: uploadedFile,
			mimeType,
			attributes,
		});
	}

	/**
	 * Generates a unique random ID suitable for Telegram's `randomId` field.
	 * Combines the current timestamp with a random component to avoid collisions.
	 */
	static randomId() {
		return bigInt(Date.now())
			.multiply(bigInt(1_000))
			.plus(bigInt(Math.floor(Math.random() * 1_000)));
	}
}
