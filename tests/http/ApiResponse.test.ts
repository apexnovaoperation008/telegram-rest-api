import { describe, it, expect } from "vitest";

import { ErrorResponse } from "../../src/http/ApiResponse";

/**
 * Reproduces the teleproto migration regression: teleproto maps 714 RPC errors
 * to classes that overwrite `.message` with prose and keep the raw Telegram code
 * on `.errorMessage` only. gramjs had no mapped class for most codes, so the code
 * leaked into `.message` — and downstream consumers (chat-x-base
 * `isTelegramTwoFactorRequired`, echo-hub PEER_FLOOD handling) match on it there.
 */

/** Mirrors teleproto's mapped SessionPasswordNeededError. */
class FakeSessionPasswordNeededError extends Error {
	readonly code = 401;
	readonly errorMessage = "SESSION_PASSWORD_NEEDED";

	constructor() {
		super("2FA is enabled, use a password to login. (caused by auth.SignIn)");
	}
}

/** Mirrors gramjs's generic RPCError for an unmapped code. */
class FakeGenericRpcError extends Error {
	readonly code = 401;
	readonly errorMessage = "SESSION_PASSWORD_NEEDED";

	constructor() {
		super("401: SESSION_PASSWORD_NEEDED (caused by auth.SignIn)");
	}
}

/**
 * Mirrors teleproto's capture-based FloodWaitError, which does NOT set a machine
 * errorMessage — it inherits the prose from the RPCError constructor.
 */
class FakeFloodWaitError extends Error {
	readonly code = 420;
	readonly errorMessage =
		"Please wait 42 seconds before repeating the action. (caused by messages.SendMessage)";

	constructor() {
		super("Please wait 42 seconds before repeating the action. (caused by messages.SendMessage)");
	}
}

describe("ErrorResponse.fromError", () => {
	it("keeps the Telegram error code matchable when teleproto moved it off .message", () => {
		const response = ErrorResponse.fromError(new FakeSessionPasswordNeededError());

		expect(response.message).toContain("SESSION_PASSWORD_NEEDED");
		// teleproto's prose must survive — it is what the operator reads.
		expect(response.message).toContain("2FA is enabled, use a password to login.");
		expect(response.statusCode).toBe(401);
	});

	it("does not duplicate a code that gramjs already left in .message", () => {
		const response = ErrorResponse.fromError(new FakeGenericRpcError());

		expect(response.message).toBe("401: SESSION_PASSWORD_NEEDED (caused by auth.SignIn)");
	});

	it("does not append when errorMessage is prose, not a machine code", () => {
		const response = ErrorResponse.fromError(new FakeFloodWaitError());

		expect(response.message).toBe(
			"Please wait 42 seconds before repeating the action. (caused by messages.SendMessage)",
		);
		expect(response.statusCode).toBe(420);
	});

	it("leaves plain errors untouched", () => {
		const response = ErrorResponse.fromError(new Error("phoneNumber is required"));

		expect(response.message).toBe("phoneNumber is required");
		expect(response.statusCode).toBe(400);
	});

	it("falls back for non-Error values", () => {
		const response = ErrorResponse.fromError("boom");

		expect(response.message).toBe("Unknown error");
		expect(response.statusCode).toBe(400);
	});

	it("serializes the matchable message in the response body", () => {
		const body = ErrorResponse.fromError(new FakeSessionPasswordNeededError()).toJSON();

		expect(body.success).toBe(false);
		expect(body.message).toContain("SESSION_PASSWORD_NEEDED");
	});
});
