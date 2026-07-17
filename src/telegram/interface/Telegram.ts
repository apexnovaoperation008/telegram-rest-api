import { TelegramClient } from "teleproto";

export interface TelegramClientInterface {
	connect(): Promise<void>;
	destroy(): Promise<void>;
	getClient(): TelegramClient;
	getSession(): string;
}
