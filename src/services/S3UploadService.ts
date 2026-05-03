import {
	S3Client,
	PutObjectCommand,
	HeadObjectCommand,
	ObjectCannedACL,
} from "@aws-sdk/client-s3";

const S3_BUCKET = process.env.S3_BUCKET ?? "";
const S3_REGION = process.env.S3_REGION ?? "us-east-1";
const S3_ACCESS_KEY_ID = process.env.S3_ACCESS_KEY_ID ?? "";
const S3_SECRET_ACCESS_KEY = process.env.S3_SECRET_ACCESS_KEY ?? "";
const S3_ENDPOINT = process.env.S3_ENDPOINT ?? "";
const S3_PUBLIC_URL = (process.env.S3_PUBLIC_URL ?? "").replace(/\/+$/, "");
const S3_FOLDER_PATH = (process.env.S3_FOLDER_PATH ?? "telegram-media").replace(
	/\/+$/,
	"",
);

const MIME_MAP: Record<string, string> = {
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	png: "image/png",
	webp: "image/webp",
	gif: "image/gif",
	mp4: "video/mp4",
	webm: "video/webm",
	ogg: "audio/ogg",
	mp3: "audio/mpeg",
	pdf: "application/pdf",
	bin: "application/octet-stream",
};

export class S3UploadService {
	private static client: S3Client | null = null;

	static isConfigured(): boolean {
		return !!(S3_BUCKET && S3_ACCESS_KEY_ID && S3_SECRET_ACCESS_KEY);
	}

	private static getClient(): S3Client {
		if (!this.client) {
			const config: ConstructorParameters<typeof S3Client>[0] = {
				region: S3_REGION,
				credentials: {
					accessKeyId: S3_ACCESS_KEY_ID,
					secretAccessKey: S3_SECRET_ACCESS_KEY,
				},
			};

			if (S3_ENDPOINT) {
				config.endpoint = S3_ENDPOINT;
				config.forcePathStyle = true;
			}

			this.client = new S3Client(config);
		}
		return this.client;
	}

	/**
	 * Builds the public URL for an uploaded object.
	 *
	 * - If S3_PUBLIC_URL is set, uses it directly (for CDN, reverse proxy, or
	 *   when the MinIO/S3 public URL differs from the API endpoint).
	 * - If S3_ENDPOINT is set (MinIO / self-hosted), uses path-style:
	 *   `{endpoint}/{bucket}/{key}`
	 * - Otherwise falls back to AWS virtual-hosted-style:
	 *   `https://{bucket}.s3.{region}.amazonaws.com/{key}`
	 */
	private static buildPublicUrl(key: string): string {
		if (S3_PUBLIC_URL) {
			return `${S3_PUBLIC_URL}/${S3_BUCKET}/${key}`;
		}
		if (S3_ENDPOINT) {
			return `${S3_ENDPOINT.replace(/\/+$/, "")}/${S3_BUCKET}/${key}`;
		}
		return `https://${S3_BUCKET}.s3.${S3_REGION}.amazonaws.com/${key}`;
	}

	/**
	 * Builds the full S3 object key from an optional sub-path and filename.
	 * Result: `S3_FOLDER_PATH[/subPath]/fileName`
	 */
	static buildKey(fileName: string, subPath?: string): string {
		if (subPath) {
			return `${S3_FOLDER_PATH}/${subPath}/${fileName}`;
		}
		return `${S3_FOLDER_PATH}/${fileName}`;
	}

	/**
	 * Checks whether an object exists in S3.
	 * Returns the public URL if it exists, or null if it does not.
	 */
	static async exists(key: string): Promise<string | null> {
		const client = this.getClient();
		try {
			await client.send(
				new HeadObjectCommand({ Bucket: S3_BUCKET, Key: key }),
			);
			return this.buildPublicUrl(key);
		} catch {
			return null;
		}
	}

	/**
	 * Uploads a buffer to S3 with public-read ACL and returns the permanent
	 * public URL. The file is placed under the configured S3_FOLDER_PATH prefix.
	 *
	 * @param buffer   File contents
	 * @param fileName Basename of the file (e.g. `photo_123.jpg`)
	 * @param contentType Optional MIME type (inferred from extension if omitted)
	 * @param subPath  Optional sub-directory under S3_FOLDER_PATH (e.g. `123456/42`)
	 */
	static async upload(
		buffer: Buffer,
		fileName: string,
		contentType?: string,
		subPath?: string,
	): Promise<string> {
		const client = this.getClient();
		const ext = fileName.split(".").pop()?.toLowerCase() ?? "bin";
		const resolvedContentType =
			contentType ?? MIME_MAP[ext] ?? "application/octet-stream";

		const key = this.buildKey(fileName, subPath);

		await client.send(
			new PutObjectCommand({
				Bucket: S3_BUCKET,
				Key: key,
				Body: buffer,
				ContentType: resolvedContentType,
				ACL: ObjectCannedACL.public_read,
			}),
		);

		return this.buildPublicUrl(key);
	}
}
