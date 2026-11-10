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

	it("rounds a fractional duration", async () => {
		const response = await send({ voices: ["https://s3.test/a.oga"], voiceDurations: [2.6] });

		expect(response.statusCode).toBe(200);
		expect(sentDurations()).toEqual([3]);
	});

	it("accepts the int32 maximum", async () => {
		const response = await send({ voices: ["https://s3.test/a.oga"], voiceDurations: [2147483647] });

		expect(response.statusCode).toBe(200);
		expect(sentDurations()).toEqual([2147483647]);
	});

	it.each([
		["a string entry", ["7"]],
		["a null entry", [null]],
		["a negative entry", [-1]],
		["an entry past int32", [2147483648]],
		["a fraction past int32", [2147483647.6]],
		["a non-array", 7],
		["null", null],
	])("rejects %s before sending anything", async (_label, voiceDurations) => {
		const response = await send({
			voices: ["https://s3.test/a.oga", "https://s3.test/b.oga"],
			voiceDurations: Array.isArray(voiceDurations) ? [1, ...voiceDurations] : voiceDurations,
		});

		expect(response.statusCode).toBe(400);
		expect(invoke).not.toHaveBeenCalled();
	});
});
