export interface RawInputPhoto {
	type: "photo";
	id: string;
	accessHash: string;
	fileReference: string;
	thumbSize: string;
	dcId: number;
}

export interface RawInputDocument {
	type: "document";
	id: string;
	accessHash: string;
	fileReference: string;
	thumbSize: string;
	dcId: number;
	mimeType: string;
	fileName: string;
}

export type RawInput = RawInputPhoto | RawInputDocument;

export interface DownloadTaskRow {
	id: bigint;
	file_unique_id: string;
	raw_input_json: string | null;
	from_accounts: string[];
	file_type: string | null;
}
