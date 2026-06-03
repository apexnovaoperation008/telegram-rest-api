CREATE TYPE "public"."MessageStatus" AS ENUM('downloaded', 'forwarded', 'delivery_failed');--> statement-breakpoint
CREATE TABLE "messages" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"session_id" bigint NOT NULL,
	"raw_payload" text,
	"status" "MessageStatus" DEFAULT 'downloaded' NOT NULL,
	"delivery_retry_count" integer DEFAULT 0 NOT NULL,
	"next_delivery_attempt_at" timestamp (3),
	"delivery_failed_at" timestamp (3),
	"last_delivery_error" text,
	"created_at" timestamp (3) DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "telegram_sessions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"telegram_user_id" varchar(255) NOT NULL,
	"telegram_username" varchar(255) NOT NULL,
	"telegram_access_hash" varchar(255) NOT NULL,
	"server_name" varchar(255) NOT NULL,
	"callback_url" text NOT NULL,
	"status" varchar(50) NOT NULL,
	"created_at" timestamp (3) DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenant_message_state" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"session_id" bigint NOT NULL,
	"last_forwarded_id" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp (3) NOT NULL,
	CONSTRAINT "tenant_message_state_session_id_unique" UNIQUE("session_id")
);
--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_session_id_telegram_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."telegram_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_message_state" ADD CONSTRAINT "tenant_message_state_session_id_telegram_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."telegram_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "messages_session_id_id_status_idx" ON "messages" USING btree ("session_id","id","status");