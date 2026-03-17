import { Api, TelegramClient } from "telegram";
import { Raw } from "telegram/events";
import * as fs from "fs";
import * as path from "path";

const STORAGE_DIR = path.resolve(process.cwd(), "storage");

export class IncomingReactionHandler {
	private readonly client: TelegramClient;
	private readonly telegramUserId: string;
	private handler: ((update: Api.TypeUpdate) => void) | null = null;

	constructor(client: TelegramClient, telegramUserId: string) {
		this.client = client;
		this.telegramUserId = telegramUserId;
	}

	start(): void {
		this.handler = (update: Api.TypeUpdate) => {
			try {
				if (update instanceof Api.UpdateMessageReactions) {
					//Direct reaction update (private chats, some group types)
					this.handleReactionUpdate(update);
				} else if (
					update instanceof Api.UpdateEditMessage &&
					update.message instanceof Api.Message &&
					update.message.reactions
				) {
					// Reaction on a non-channel message (groups, PMs in some cases)
					this.handleReactionFromMessage(update.message);
				} else if (
					// Reaction on a channel/supergroup message
					update instanceof Api.UpdateEditChannelMessage &&
					update.message instanceof Api.Message &&
					update.message.reactions
				) {
					this.handleReactionFromMessage(update.message);
				}
			} catch (error) {
				console.error(
					`[ReactionHandler] Error for user ${this.telegramUserId}:`,
					error,
				);
			}
		};

		this.client.addEventHandler(this.handler, new Raw({}));
		console.log(`[ReactionHandler] Started for user ${this.telegramUserId}`);
	}

	stop(): void {
		if (this.handler) {
			this.client.removeEventHandler(this.handler, new Raw({}));
			this.handler = null;
		}
	}

	private handleReactionUpdate(update: Api.UpdateMessageReactions): void {
		const chatId = this.extractPeerId(update.peer) ?? "unknown";

		const results = (update.reactions?.results ?? []).map(
			(r: Api.ReactionCount) => ({
				reaction: this.extractReactionEmoji(r.reaction),
				count: r.count,
				chosen: r.chosen ?? false,
			}),
		);

		const recentReactions = (update.reactions?.recentReactions ?? []).map(
			(r: Api.MessagePeerReaction) => ({
				peer: this.extractPeerId(r.peerId),
				reaction: this.extractReactionEmoji(r.reaction),
				unread: r.unread ?? false,
				date: r.date,
			}),
		);

		this.writeLog(chatId, update.msgId, update.date, results, recentReactions);
	}

	private handleReactionFromMessage(message: Api.Message): void {
		const chatId = message.chatId?.toString() ?? "unknown";
		const reactions = message.reactions as Api.MessageReactions;

		const results = (reactions.results ?? []).map((r: Api.ReactionCount) => ({
			reaction: this.extractReactionEmoji(r.reaction),
			count: r.count,
			chosen: r.chosen ?? false,
		}));

		const recentReactions = (reactions.recentReactions ?? []).map(
			(r: Api.MessagePeerReaction) => ({
				peer: this.extractPeerId(r.peerId),
				reaction: this.extractReactionEmoji(r.reaction),
				unread: r.unread ?? false,
				date: r.date,
			}),
		);

		this.writeLog(chatId, message.id, message.date, results, recentReactions);
	}

	private writeLog(
		chatId: string,
		messageId: number,
		date: number,
		results: { reaction: string; count: number; chosen: boolean }[],
		recentReactions: {
			peer: string | null;
			reaction: string;
			unread: boolean;
			date: number;
		}[],
	): void {
		const payload = {
			to_account: this.telegramUserId,
			chat_id: chatId,
			message_id: messageId,
			date,
			results,
			recent_reactions: recentReactions,
		};

		const logName = `reaction_${chatId}_${messageId}_${Date.now()}.log`;
		const logPath = path.join(STORAGE_DIR, logName);
		fs.writeFileSync(logPath, JSON.stringify(payload, null, 2), "utf-8");

		console.log(
			`[ReactionHandler] Reaction on msg ${messageId} in chat ${chatId} for user ${this.telegramUserId}`,
		);
	}

	private extractPeerId(peer: Api.TypePeer | null | undefined): string | null {
		if (!peer) return null;
		if (peer instanceof Api.PeerUser) return peer.userId.toString();
		if (peer instanceof Api.PeerChat) return peer.chatId.toString();
		if (peer instanceof Api.PeerChannel) return peer.channelId.toString();
		return null;
	}

	private extractReactionEmoji(
		reaction: Api.TypeReaction | null | undefined,
	): string {
		if (!reaction) return "";
		if (reaction instanceof Api.ReactionEmoji) return reaction.emoticon;
		if (reaction instanceof Api.ReactionCustomEmoji)
			return `custom:${reaction.documentId.toString()}`;
		return "";
	}
}
