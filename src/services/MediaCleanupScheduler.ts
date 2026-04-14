import * as fs from "fs";
import { DatabaseClient } from "../database/DatabaseClient";

const CLEANUP_HOUR = parseInt(process.env.MEDIA_CLEANUP_HOUR ?? "3", 10);
const TIMEZONE = process.env.APP_TIMEZONE ?? "UTC";

/**
 * Runs a daily cleanup job that deletes media files whose expires_at timestamp
 * has passed. The job fires at MEDIA_CLEANUP_HOUR (0-23) in the APP_TIMEZONE.
 * On each run it:
 *   1. Finds all media_files rows with expires_at < now()
 *   2. Deletes the files from disk
 *   3. Removes the DB records
 */
export class MediaCleanupScheduler {
	private timer: NodeJS.Timeout | null = null;

	start(): void {
		this.scheduleNext();
		console.log(
			`[MediaCleanup] Scheduled daily at ${CLEANUP_HOUR}:00 (${TIMEZONE})`,
		);
	}

	stop(): void {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
	}

	private scheduleNext(): void {
		const ms = this.msUntilNextRun();
		this.timer = setTimeout(async () => {
			try {
				await this.cleanup();
			} catch (err) {
				console.error(
					"[MediaCleanup] Cleanup error:",
					err instanceof Error ? err.message : err,
				);
			}
			this.scheduleNext();
		}, ms);
	}

	/**
	 * Computes milliseconds until the next occurrence of CLEANUP_HOUR:00:00
	 * in the configured timezone, using Intl.DateTimeFormat for accuracy
	 * across DST boundaries.
	 */
	private msUntilNextRun(): number {
		const now = new Date();

		const parts = new Intl.DateTimeFormat("en-US", {
			timeZone: TIMEZONE,
			hour: "numeric",
			minute: "numeric",
			second: "numeric",
			hour12: false,
		}).formatToParts(now);

		const hour = parseInt(
			parts.find((p) => p.type === "hour")?.value ?? "0",
			10,
		);
		const minute = parseInt(
			parts.find((p) => p.type === "minute")?.value ?? "0",
			10,
		);
		const second = parseInt(
			parts.find((p) => p.type === "second")?.value ?? "0",
			10,
		);

		const currentSecondsInDay = hour * 3600 + minute * 60 + second;
		const targetSecondsInDay = CLEANUP_HOUR * 3600;

		let diffSeconds = targetSecondsInDay - currentSecondsInDay;
		if (diffSeconds <= 0) diffSeconds += 86_400;

		return diffSeconds * 1000;
	}

	private async cleanup(): Promise<void> {
		const db = DatabaseClient.getInstance();
		const now = new Date();

		const expired = await db.execute((prisma) =>
			prisma.mediaFile.findMany({
				where: { expires_at: { lt: now } },
				select: { id: true, file_path: true, file_key: true },
			}),
		);

		if (expired.length === 0) {
			console.log("[MediaCleanup] No expired media files found");
			return;
		}

		let deleted = 0;
		let missing = 0;

		for (const record of expired) {
			try {
				if (fs.existsSync(record.file_path)) {
					fs.unlinkSync(record.file_path);
					deleted++;
				} else {
					missing++;
				}
			} catch (err) {
				console.error(
					`[MediaCleanup] Failed to delete file ${record.file_path}:`,
					err instanceof Error ? err.message : err,
				);
			}
		}

		const ids = expired.map((r) => r.id);
		await db.execute((prisma) =>
			prisma.mediaFile.deleteMany({ where: { id: { in: ids } } }),
		);

		console.log(
			`[MediaCleanup] Removed ${expired.length} record(s) — ` +
				`${deleted} file(s) deleted, ${missing} already absent`,
		);
	}
}
