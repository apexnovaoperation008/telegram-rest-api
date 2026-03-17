export interface AttachmentRecord {
	file_unique_id: string;
	file_type: string;
	file_url: string | null;
}

export interface MessageWithAttachments {
	id: bigint;
	tenant_id: number;
	telegram_chat_id: string;
	telegram_message_id: number;
	from_account: string;
	message: string | null;
	created_at: Date;
	attachments: AttachmentRecord[];
}
