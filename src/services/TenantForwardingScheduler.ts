import * as fs from "fs";
import * as path from "path";
import { DatabaseClient } from "../database/DatabaseClient";
import { MessageWithAttachments } from "./interface/MessageWithAttachments";

const FORWARDING_INTERVAL_MS = parseInt(
	process.env.FORWARDING_INTERVAL_MS ?? "1000",
	10,
);
const SERVER_NAME = process.env.SERVER_NAME ?? "";
const STORAGE_DIR = path.resolve(process.cwd(), "storage");

interface ForwardingChannel {
	session_id: number;
	from_account: string;
	to_account: string;
}

export class TenantForwardingScheduler {
	private timer: NodeJS.Timeout | null = null;
	private processing = false;

	start(): void {
		if (this.timer) return;

		if (!fs.existsSync(STORAGE_DIR)) {
			fs.mkdirSync(STORAGE_DIR, { recursive: true });
		}

		this.timer = setInterval(
			() => this.tick(),
			FORWARDING_INTERVAL_MS,
		);
		console.log(
			`[ForwardingScheduler] Started (interval: ${FORWARDING_INTERVAL_MS}ms)`,
		);
	}

	stop(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}

	private async tick(): Promise<void> {
		if (this.processing) return;
		this.processing = true;

		try {
			const db = DatabaseClient.getInstance();

			const rows = await db.execute(
				(prisma) =>
					prisma.message.findMany({
						where: {
							status: { not: "forwarded" },
							to_account: { not: null },
							session: { server_name: SERVER_NAME },
						},
						select: { session_id: true, from_account: true, to_account: true },
						distinct: ["session_id", "from_account", "to_account"],
					}) as Promise<{ session_id: number; from_account: string; to_account: string | null }[]>,
			);

			const channels: ForwardingChannel[] = rows.filter(
				(r): r is ForwardingChannel => r.to_account !== null,
			);

			await Promise.all(
				channels.map((ch) =>
					this.processChannel(ch.session_id, ch.from_account, ch.to_account),
				),
			);
		} catch (error) {
			console.error("[ForwardingScheduler] Tick error:", error);
		} finally {
			this.processing = false;
		}
	}

	private async processChannel(
		sessionId: number,
		fromAccount: string,
		toAccount: string,
	): Promise<void> {
		try {
			const db = DatabaseClient.getInstance();

			const state = await db.execute(
				(prisma) =>
					prisma.tenantMessageState.upsert({
						where: {
							session_id_from_account_to_account: {
								session_id: sessionId,
								from_account: fromAccount,
								to_account: toAccount,
							},
						},
						update: {},
						create: {
							session_id: sessionId,
							from_account: fromAccount,
							to_account: toAccount,
							last_forwarded_id: BigInt(0),
						},
					}) as Promise<{ last_forwarded_id: bigint }>,
			);

			let advanced = true;
			while (advanced) {
				advanced = await this.forwardNext(
					sessionId,
					fromAccount,
					toAccount,
					state.last_forwarded_id,
				);
				if (advanced) {
					state.last_forwarded_id++;
				}
			}
		} catch (error) {
			console.error(
				`[ForwardingScheduler] Error for session ${sessionId} ${fromAccount} → ${toAccount}:`,
				error,
			);
		}
	}

	private async forwardNext(
		sessionId: number,
		fromAccount: string,
		toAccount: string,
		lastForwardedId: bigint,
	): Promise<boolean> {
		const db = DatabaseClient.getInstance();

		return db.execute(async (prisma) => {
			const nextMsg = await prisma.message.findFirst({
				where: {
					session_id: sessionId,
					from_account: fromAccount,
					to_account: toAccount,
					id: { gt: lastForwardedId },
				},
				orderBy: { id: "asc" },
				include: { attachments: true },
			});

			if (!nextMsg) return false;

			if (nextMsg.status === "forwarded") {
				await prisma.tenantMessageState.update({
					where: {
						session_id_from_account_to_account: {
							session_id: sessionId,
							from_account: fromAccount,
							to_account: toAccount,
						},
					},
					data: { last_forwarded_id: nextMsg.id },
				});
				return true;
			}

			if (nextMsg.status !== "downloaded") return false;

			this.writeFinalLog(nextMsg);

			await prisma.$transaction([
				prisma.message.update({
					where: { id: nextMsg.id },
					data: { status: "forwarded" },
				}),
				prisma.tenantMessageState.update({
					where: {
						session_id_from_account_to_account: {
							session_id: sessionId,
							from_account: fromAccount,
							to_account: toAccount,
						},
					},
					data: { last_forwarded_id: nextMsg.id },
				}),
			]);

			console.log(
				`[ForwardingScheduler] Forwarded message ${nextMsg.id} for session ${sessionId} ${fromAccount} → ${toAccount}`,
			);
			return true;
		});
	}

	private writeFinalLog(msg: MessageWithAttachments): void {
		const payload = {
			id: msg.id.toString(),
			session_id: msg.session_id,
			chat_id: msg.telegram_chat_id,
			message_id: msg.telegram_message_id,
			from_account: msg.from_account,
			text: msg.message,
			received_at: msg.created_at.toISOString(),
			attachments: msg.attachments.map((a) => ({
				file_unique_id: a.file_unique_id,
				file_type: a.file_type,
				file_path: a.file_url,
			})),
		};

		const logPath = path.join(STORAGE_DIR, `${msg.id}.log`);
		fs.writeFileSync(logPath, JSON.stringify(payload, null, 2), "utf-8");
	}
}
