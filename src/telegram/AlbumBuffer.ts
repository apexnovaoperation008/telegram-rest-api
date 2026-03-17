import { NewMessageEvent } from "telegram/events";
import { FlushCallback } from "./interface/MessagePipeline";

/**
 * Collects Telegram events that share a `grouped_id` (albums) and
 * flushes them as a batch after a short debounce window.  Events
 * without a `grouped_id` are flushed immediately as single-element
 * arrays.
 */
export class AlbumBuffer {
	private readonly buffers = new Map<
		string,
		{ events: NewMessageEvent[]; timer: NodeJS.Timeout }
	>();

	constructor(
		private readonly flushDelayMs: number,
		private readonly onFlush: FlushCallback,
	) {}

	push(event: NewMessageEvent): void {
		const groupedId = event.message.groupedId?.toString();

		if (!groupedId) {
			this.onFlush([event]).catch((err) =>
				console.error("[AlbumBuffer] Flush error (single):", err),
			);
			return;
		}

		const existing = this.buffers.get(groupedId);
		if (existing) {
			clearTimeout(existing.timer);
			existing.events.push(event);
		} else {
			this.buffers.set(groupedId, { events: [event], timer: null! });
		}

		const entry = this.buffers.get(groupedId)!;
		entry.timer = setTimeout(() => this.flush(groupedId), this.flushDelayMs);
	}

	private flush(groupedId: string): void {
		const entry = this.buffers.get(groupedId);
		if (!entry) return;
		this.buffers.delete(groupedId);

		this.onFlush(entry.events).catch((err) =>
			console.error("[AlbumBuffer] Flush error (album):", err),
		);
	}
}
