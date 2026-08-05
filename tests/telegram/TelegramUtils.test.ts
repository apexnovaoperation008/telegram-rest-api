import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Api, TelegramClient } from "teleproto";
import { TelegramUtils } from "../../src/telegram/TelegramUtils";

function makeClient(): TelegramClient {
	return {
		uploadFile: vi.fn().mockResolvedValue(
			new Api.InputFile({
				id: BigInt(1) as never,
				parts: 1,
				name: "upload",
				md5Checksum: "",
			}),
		),
	} as unknown as TelegramClient;
}

describe("TelegramUtils.uploadMedia", () => {
	beforeEach(() => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: true,
				arrayBuffer: async () => new ArrayBuffer(8),
				headers: new Headers({ "content-type": "audio/ogg" }),
			}),
		);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("marks voice media with DocumentAttributeAudio(voice) and audio/ogg", async () => {
		const media = await TelegramUtils.uploadMedia(
			makeClient(),
			"https://s3.test/chat/456/abc.oga",
			"voice",
		);

		expect(media).toBeInstanceOf(Api.InputMediaUploadedDocument);
		const doc = media as Api.InputMediaUploadedDocument;
		expect(doc.mimeType).toBe("audio/ogg");
		expect(doc.attributes).toHaveLength(1);
		const attr = doc.attributes[0] as Api.DocumentAttributeAudio;
		expect(attr).toBeInstanceOf(Api.DocumentAttributeAudio);
		expect(attr.voice).toBe(true);
	});

	it("keeps plain files as documents with a filename attribute", async () => {
		const media = await TelegramUtils.uploadMedia(
			makeClient(),
			"https://s3.test/chat/456/doc.pdf",
			"file",
		);

		expect(media).toBeInstanceOf(Api.InputMediaUploadedDocument);
		const doc = media as Api.InputMediaUploadedDocument;
		expect(doc.attributes).toHaveLength(1);
		expect(doc.attributes[0]).toBeInstanceOf(Api.DocumentAttributeFilename);
		expect(
			(doc.attributes[0] as Api.DocumentAttributeFilename).fileName,
		).toBe("doc.pdf");
	});
});
