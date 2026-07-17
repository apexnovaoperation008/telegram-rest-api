import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.hoisted(() => {
	process.env.SERVER_NAME = "test-server";
	process.env.FORWARDING_INTERVAL_MS = "30000";
});

let selectDistinctResult: { session_id: bigint }[] = [];

vi.mock("../../src/database/DatabaseClient", () => ({
	DatabaseClient: {
		getInstance: () => ({
			execute: (cb: (db: unknown) => Promise<unknown>) =>
				cb({
					selectDistinct: () => ({
						from: () => ({
							innerJoin: () => ({
								where: () => Promise.resolve(selectDistinctResult),
							}),
						}),
					}),
				}),
		}),
	},
}));

import { TenantForwardingScheduler } from "../../src/services/TenantForwardingScheduler";
import { DeliveryDispatcher } from "../../src/services/DeliveryDispatcher";

describe("TenantForwardingScheduler (recovery sweeper)", () => {
	beforeEach(() => {
		selectDistinctResult = [];
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("wakes the dispatcher for every session with deliverable messages", async () => {
		const wakeSpy = vi
			.spyOn(DeliveryDispatcher, "wake")
			.mockImplementation(() => {});

		selectDistinctResult = [
			{ session_id: BigInt(1) },
			{ session_id: BigInt(2) },
			{ session_id: BigInt(3) },
		];

		const sweeper = new TenantForwardingScheduler();
		await (sweeper as any)["sweep"]();

		expect(wakeSpy).toHaveBeenCalledTimes(3);
		expect(wakeSpy).toHaveBeenCalledWith(BigInt(1));
		expect(wakeSpy).toHaveBeenCalledWith(BigInt(2));
		expect(wakeSpy).toHaveBeenCalledWith(BigInt(3));
	});

	it("wakes nothing when no sessions have pending messages", async () => {
		const wakeSpy = vi
			.spyOn(DeliveryDispatcher, "wake")
			.mockImplementation(() => {});

		const sweeper = new TenantForwardingScheduler();
		await (sweeper as any)["sweep"]();

		expect(wakeSpy).not.toHaveBeenCalled();
	});

	it("sweeps immediately on start, then stops cleanly", async () => {
		const wakeSpy = vi
			.spyOn(DeliveryDispatcher, "wake")
			.mockImplementation(() => {});
		vi.spyOn(console, "log").mockImplementation(() => {});

		selectDistinctResult = [{ session_id: BigInt(7) }];

		const sweeper = new TenantForwardingScheduler();
		sweeper.start();
		await new Promise((r) => setTimeout(r, 10));
		sweeper.stop();

		expect(wakeSpy).toHaveBeenCalledWith(BigInt(7));
	});
});
