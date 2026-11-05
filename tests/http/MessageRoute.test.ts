import Fastify, { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Api } from "teleproto";
import { MessageRoute } from "../../src/routes/message/MessageRoute";
import { TelegramClientService } from "../../src/telegram/TelegramClientService";

describe("POST /messages/SendMessage voice notes", () => {
	let app: FastifyInstance;
	const invoke = vi.fn();

	function sentDurations(): number[] {
		return invoke.mock.calls.map(([request]) => {
			const media = (request as Api.messages.SendMedia).media as Api.InputMediaUploadedDocument;
			return (media.attributes[0] as Api.DocumentAttributeAudio).duration;
		});
	}

	beforeEach(async () => {
		invoke.mockReset().mockResolvedValue({});
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: true,
				arrayBuffer: async () => new ArrayBuffer(8),
				headers: new Headers({ "content-type": "audio/ogg" }),
			}),
		);
		vi.spyOn(TelegramClientService, "isPooled").mockReturnValue(true);
		vi.spyOn(TelegramClientService, "initialize").mockResolvedValue({
			captureSentResult: vi.fn(),
			getClient: () => ({
				getInputEntity: vi.fn().mockResolvedValue(new Api.InputPeerSelf()),
				invoke,
				uploadFile: vi.fn().mockResolvedValue(
					new Api.InputFile({ id: BigInt(1) as never, parts: 1, name: "upload", md5Checksum: "" }),
				),
			}),
		} as unknown as TelegramClientService);

		app = Fastify();
		await new MessageRoute().register(app);
	});

	afterEach(async () => {
		await app.close();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	function send(body: Record<string, unknown>) {
		return app.inject({
			method: "POST",
			url: "/messages/SendMessage",
			payload: { sessionId: "session", peer: "456", ...body },
		});
	}

	it("puts each voiceDurations entry on the voice attribute Telegram receives", async () => {
		const response = await send({
			voices: ["https://s3.test/a.oga", "https://s3.test/b.oga"],
			voiceDurations: [7, 1],
		});

		expect(response.statusCode).toBe(200);
		expect(sentDurations()).toEqual([7, 1]);
	});

	it("sends duration 0 for a caller that posts no voiceDurations", async () => {
		const response = await send({ voices: ["https://s3.test/a.oga"] });

		expect(response.statusCode).toBe(200);
		expect(sentDurations()).toEqual([0]);
	});
});
