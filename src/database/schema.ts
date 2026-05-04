import { sql } from "drizzle-orm";
import {
	pgTable,
	pgEnum,
	bigserial,
	bigint,
	varchar,
	text,
	timestamp,
	integer,
	index,
} from "drizzle-orm/pg-core";

export const messageStatusEnum = pgEnum("MessageStatus", [
	"downloaded",
	"forwarded",
	"delivery_failed",
]);

export const telegramSessions = pgTable("telegram_sessions", {
	id: bigserial("id", { mode: "bigint" }).primaryKey(),
	session_id: text("session_id").notNull(),
	telegram_user_id: varchar("telegram_user_id", { length: 255 }).notNull(),
	telegram_username: varchar("telegram_username", { length: 255 }).notNull(),
	telegram_access_hash: varchar("telegram_access_hash", {
		length: 255,
	}).notNull(),
	server_name: varchar("server_name", { length: 255 }).notNull(),
	callback_url: text("callback_url").notNull(),
	status: varchar("status", { length: 50 }).notNull(),
	created_at: timestamp("created_at", { precision: 3 })
		.defaultNow()
		.notNull(),
	updated_at: timestamp("updated_at", { precision: 3 })
		.notNull()
		.$onUpdate(() => new Date()),
});

export const messages = pgTable(
	"messages",
	{
		id: bigserial("id", { mode: "bigint" }).primaryKey(),
		session_id: bigint("session_id", { mode: "bigint" })
			.notNull()
			.references(() => telegramSessions.id, { onDelete: "cascade" }),
		raw_payload: text("raw_payload"),
		status: messageStatusEnum("status").default("downloaded").notNull(),
		delivery_retry_count: integer("delivery_retry_count")
			.default(0)
			.notNull(),
		next_delivery_attempt_at: timestamp("next_delivery_attempt_at", {
			precision: 3,
		}),
		delivery_failed_at: timestamp("delivery_failed_at", { precision: 3 }),
		last_delivery_error: text("last_delivery_error"),
		created_at: timestamp("created_at", { precision: 3 })
			.defaultNow()
			.notNull(),
		updated_at: timestamp("updated_at", { precision: 3 })
			.notNull()
			.$onUpdate(() => new Date()),
	},
	(t) => [
		index("messages_session_id_id_status_idx").on(
			t.session_id,
			t.id,
			t.status,
		),
	],
);

export const tenantMessageState = pgTable("tenant_message_state", {
	id: bigserial("id", { mode: "bigint" }).primaryKey(),
	session_id: bigint("session_id", { mode: "bigint" })
		.notNull()
		.unique()
		.references(() => telegramSessions.id, { onDelete: "cascade" }),
	last_forwarded_id: bigint("last_forwarded_id", { mode: "bigint" })
		.default(sql`0`)
		.notNull(),
	updated_at: timestamp("updated_at", { precision: 3 })
		.notNull()
		.$onUpdate(() => new Date()),
});

