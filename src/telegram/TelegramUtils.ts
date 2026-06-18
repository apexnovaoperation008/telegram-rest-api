import { Api, TelegramClient } from "telegram";
import { CustomFile } from "telegram/client/uploads";
import bigInt from "big-integer";
import mime from "mime-types";

export type MediaType = "photo" | "video" | "file";

export interface RawMessageEntity {
	type: string;
	offset: number;
	length: number;
	url?: string;
	userId?: string | number;
	language?: string;
}

const ENTITY_FACTORIES: Record<
	string,
	(e: RawMessageEntity) => Api.TypeMessageEntity | null
> = {
	bold: (e) =>
		new Api.MessageEntityBold({ offset: e.offset, length: e.length }),
	italic: (e) =>
		new Api.MessageEntityItalic({ offset: e.offset, length: e.length }),
	underline: (e) =>
		new Api.MessageEntityUnderline({ offset: e.offset, length: e.length }),
	strike: (e) =>
		new Api.MessageEntityStrike({ offset: e.offset, length: e.length }),
	code: (e) =>
		new Api.MessageEntityCode({ offset: e.offset, length: e.length }),
	pre: (e) =>
		new Api.MessageEntityPre({
			offset: e.offset,
			length: e.length,
			language: e.language ?? "",
		}),
	spoiler: (e) =>
		new Api.MessageEntitySpoiler({ offset: e.offset, length: e.length }),
	textUrl: (e) => {
		if (!e.url) return null;
		return new Api.MessageEntityTextUrl({
			offset: e.offset,
			length: e.length,
			url: e.url,
		});
	},
	mentionName: (e) => {
		if (e.userId == null) return null;
		return new Api.InputMessageEntityMentionName({
			offset: e.offset,
			length: e.length,
			userId: new Api.InputUser({
				userId: bigInt(String(e.userId)),
				accessHash: bigInt.zero,
			}),
		});
	},
};

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
	/**
	 * Converts raw JSON entity descriptors into GramJS MessageEntity instances.
	 * Unknown types or entities missing required fields are silently skipped.
	 */
	static buildEntities(
		raw: RawMessageEntity[] | undefined,
	): Api.TypeMessageEntity[] | undefined {
		if (!raw || raw.length === 0) return undefined;

		const mapped: Api.TypeMessageEntity[] = [];
		for (const entry of raw) {
			const factory = ENTITY_FACTORIES[entry.type];
			if (!factory) continue;
			const entity = factory(entry);
			if (entity) mapped.push(entity);
		}
		return mapped.length > 0 ? mapped : undefined;
	}

	static randomId() {
		return bigInt(Date.now())
			.multiply(bigInt(1_000))
			.plus(bigInt(Math.floor(Math.random() * 1_000)));
	}

	/**
	 * Resolves a file extension for any document, regardless of type
	 * (zip, txt, docx, etc.).
	 *
	 * The original filename Telegram attaches to the document is the most
	 * reliable source and is preferred. When a document carries no filename,
	 * the extension is looked up from its MIME type via the `mime-types`
	 * database, defaulting to `bin` for unknown types.
	 */
	static inferDocExtension(doc: Api.Document): string {
		for (const attr of doc.attributes) {
			if (attr instanceof Api.DocumentAttributeFilename) {
				const parts = attr.fileName.split(".");
				if (parts.length > 1) {
					return parts[parts.length - 1].toLowerCase();
				}
			}
		}

		return mime.extension(doc.mimeType ?? "") || "bin";
	}

	/**
	 * Classifies a document into a coarse media type used for downstream
	 * attachment metadata.
	 */
	static classifyDocType(doc: Api.Document): "video" | "audio" | "document" {
		const mimeType = doc.mimeType ?? "";
		if (mimeType.startsWith("video/")) return "video";
		if (mimeType.startsWith("audio/")) return "audio";
		return "document";
	}
}
