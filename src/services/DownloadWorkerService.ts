import { Api } from "telegram";
import * as fs from "fs";
import * as path from "path";
import bigInt from "big-integer";
import { Prisma } from "@prisma/client";
import { DatabaseClient } from "../database/DatabaseClient";
import { TelegramClientService } from "../telegram/TelegramClientService";
import { SessionStatus } from "../database/constants/SessionStatus";
import {
	RawInput,
	DownloadTaskRow,
} from "./interface/DownloadTask";

const MAX_CONCURRENT = parseInt(
	process.env.MAX_CONCURRENT_DOWNLOADS ?? "5",
	10,
);
const MAX_RETRIES = parseInt(process.env.MAX_DOWNLOAD_RETRIES ?? "3", 10);
const DOWNLOAD_TIMEOUT_S = parseInt(
	process.env.DOWNLOAD_TIMEOUT_SECONDS ?? "600",
	10,
);
const SERVER_NAME = process.env.SERVER_NAME ?? "";
const POLL_INTERVAL_MS = 500;
const STALE_CHECK_INTERVAL_MS = 60_000;
const FILES_DIR = path.resolve(process.cwd(), "storage", "files");

export class DownloadWorkerService {
	private active = 0;
	private running = false;

	start(): void {
		if (this.running) return;
		this.running = true;

		if (!fs.existsSync(FILES_DIR)) {
			fs.mkdirSync(FILES_DIR, { recursive: true });
		}

		this.pollLoop();
		setInterval(() => this.resetStaleTasks(), STALE_CHECK_INTERVAL_MS);
		console.log(
			`[DownloadWorker] Started (max concurrent: ${MAX_CONCURRENT})`,
		);
	}

	stop(): void {
		this.running = false;
	}

	private async pollLoop(): Promise<void> {
		while (this.running) {
			try {
				if (this.active < MAX_CONCURRENT) {
					const task = await this.claimNextTask();
					if (task) {
						this.active++;
						this.processTask(task).finally(() => {
							this.active--;
						});
					}
				}
			} catch (error) {
				console.error("[DownloadWorker] Poll error:", error);
			}
			await this.sleep(POLL_INTERVAL_MS);
		}
	}

	private async claimNextTask(): Promise<DownloadTaskRow | null> {
		const db = DatabaseClient.getInstance();
		const workerId = process.pid.toString();
		const rows = await db.execute<DownloadTaskRow[]>((prisma) =>
			prisma.$queryRaw`
				UPDATE download_tasks
				SET status = 'processing',
				    started_at = NOW(),
				    worker_id = ${workerId}
				WHERE id = (
					SELECT id FROM download_tasks
				WHERE status = 'pending'
				AND from_accounts && COALESCE(
					(
						SELECT ARRAY_AGG(ts.session_id)
						FROM telegram_sessions ts
						WHERE ts.server_name = ${SERVER_NAME}
						AND ts.status = ${SessionStatus.ACTIVE}
					),
					ARRAY[]::TEXT[]
				)
					ORDER BY created_at ASC
					LIMIT 1
					FOR UPDATE SKIP LOCKED
				)
				RETURNING id, file_unique_id, raw_input_json, from_accounts, file_type
			`,
		);
		return rows.length > 0 ? rows[0] : null;
	}

	private async processTask(task: DownloadTaskRow): Promise<void> {
		try {
			if (!task.raw_input_json) {
				throw new Error(`No raw_input_json for task ${task.id}`);
			}

			const rawInput: RawInput = JSON.parse(task.raw_input_json);
			const client = this.pickClient(task.from_accounts);
			if (!client) {
				throw new Error(
					`No available Telegram client for task ${task.id}`,
				);
			}

			const buffer = await this.downloadFile(client, rawInput);
			if (!buffer || buffer.length === 0) {
				throw new Error(`Empty download result for task ${task.id}`);
			}

			const ext = this.inferExtension(rawInput);
			const fileName = `${task.file_unique_id}.${ext}`;
			const filePath = path.join(FILES_DIR, fileName);
			fs.writeFileSync(filePath, buffer);

			const fileUrl = path.join("storage", "files", fileName);

			await this.markCompleted(task, filePath, fileUrl);

			console.log(
				`[DownloadWorker] Completed task ${task.id} → ${fileName}`,
			);
		} catch (error) {
			console.error(
				`[DownloadWorker] Failed task ${task.id}:`,
				error instanceof Error ? error.message : error,
			);
			await this.markFailed(task);
		}
	}

	private pickClient(
		fromAccounts: string[],
	): TelegramClientService | undefined {
		for (const sessionId of fromAccounts) {
			const svc = TelegramClientService.getFromPool(sessionId);
			if (svc) return svc;
		}
		const allPooled = TelegramClientService.getPooledSessionIds();
		if (allPooled.length > 0) {
			return TelegramClientService.getFromPool(allPooled[0]);
		}
		return undefined;
	}

	private async downloadFile(
		clientService: TelegramClientService,
		rawInput: RawInput,
	): Promise<Buffer> {
		const client = clientService.getClient();

		if (rawInput.type === "photo") {
			const location = new Api.InputPhotoFileLocation({
				id: bigInt(rawInput.id),
				accessHash: bigInt(rawInput.accessHash),
				fileReference: Buffer.from(rawInput.fileReference, "base64"),
				thumbSize: rawInput.thumbSize || "x",
			});

			const result = await client.downloadFile(location, {
				dcId: rawInput.dcId,
			});
			return this.toBuffer(result);
		}

		const location = new Api.InputDocumentFileLocation({
			id: bigInt(rawInput.id),
			accessHash: bigInt(rawInput.accessHash),
			fileReference: Buffer.from(rawInput.fileReference, "base64"),
			thumbSize: rawInput.thumbSize || "",
		});

		const result = await client.downloadFile(location, {
			dcId: rawInput.dcId,
		});
		return this.toBuffer(result);
	}

	private async markCompleted(
		task: { id: bigint; file_unique_id: string },
		filePath: string,
		fileUrl: string,
	): Promise<void> {
		const db = DatabaseClient.getInstance();
		await db.execute(async (prisma) => {
			return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
				await tx.downloadTask.update({
					where: { id: task.id },
					data: {
						status: "completed",
						file_path: filePath,
						file_url: fileUrl,
					},
				});

				const attachments: Array<{ id: bigint; message_id: bigint }> =
					await tx.attachment.findMany({
						where: { file_unique_id: task.file_unique_id },
						select: { id: true, message_id: true },
					});

				if (attachments.length > 0) {
					await tx.attachment.updateMany({
						where: { file_unique_id: task.file_unique_id },
						data: { file_url: fileUrl },
					});

					const messageIds = [
						...new Set(attachments.map((a) => a.message_id)),
					];

					for (const msgId of messageIds) {
						const pendingCount = await tx.attachment.count({
							where: {
								message_id: msgId,
								file_url: null,
							},
						});

						if (pendingCount === 0) {
							await tx.message.update({
								where: { id: msgId },
								data: { status: "downloaded" },
							});
						}
					}
				}
			});
		});
	}

	private async markFailed(task: DownloadTaskRow): Promise<void> {
		const db = DatabaseClient.getInstance();
		await db.execute(async (prisma) => {
			const current = await prisma.downloadTask.findUnique({
				where: { id: task.id },
				select: { retry_count: true },
			});

			const retryCount = (current?.retry_count ?? 0) + 1;
			const newStatus = retryCount >= MAX_RETRIES ? "failed" : "pending";

			await prisma.downloadTask.update({
				where: { id: task.id },
				data: {
					status: newStatus,
					retry_count: retryCount,
					started_at: null,
					worker_id: null,
				},
			});
		});
	}

	private async resetStaleTasks(): Promise<void> {
		const db = DatabaseClient.getInstance();
		const cutoff = new Date(Date.now() - DOWNLOAD_TIMEOUT_S * 1000);

		const sessionIds = await db.execute(
			(prisma) =>
				prisma.telegramSession
					.findMany({
						where: {
							status: SessionStatus.ACTIVE,
							server_name: SERVER_NAME,
						},
						select: { session_id: true },
					})
					.then((rows: { session_id: string }[]) =>
						rows.map((r) => r.session_id),
					) as Promise<string[]>,
		);

		if (sessionIds.length === 0) return;

		await db.execute((prisma) =>
			prisma.downloadTask.updateMany({
				where: {
					status: "processing",
					started_at: { lt: cutoff },
					from_accounts: { hasSome: sessionIds },
				},
				data: {
					status: "pending",
					started_at: null,
					worker_id: null,
				},
			}),
		);
	}

	private inferExtension(rawInput: RawInput): string {
		if (rawInput.type === "photo") return "jpg";
		const mime = rawInput.mimeType ?? "";
		if (rawInput.fileName) {
			const parts = rawInput.fileName.split(".");
			if (parts.length > 1) return parts[parts.length - 1];
		}
		const mimeMap: Record<string, string> = {
			"video/mp4": "mp4",
			"video/webm": "webm",
			"audio/ogg": "ogg",
			"audio/mpeg": "mp3",
			"application/pdf": "pdf",
			"image/png": "png",
			"image/jpeg": "jpg",
			"image/webp": "webp",
		};
		return mimeMap[mime] ?? "bin";
	}

	private toBuffer(result: string | Buffer | undefined): Buffer {
		if (Buffer.isBuffer(result)) return result;
		if (typeof result === "string") return Buffer.from(result, "binary");
		if (result === undefined) return Buffer.alloc(0);
		return Buffer.from(result as unknown as ArrayBuffer);
	}

	private sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}
}
