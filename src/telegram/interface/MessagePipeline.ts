import { NewMessageEvent } from "telegram/events";

export interface ParsedMedia {
	fileUniqueId: string;
	fileType: string;
	rawInputJson: string;
}

export type FlushCallback = (events: NewMessageEvent[]) => Promise<void>;
