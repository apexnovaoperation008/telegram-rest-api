-- PostgreSQL does not support AFTER for column ordering.
-- Rebuild the messages table with the desired column order.

-- Drop dependent foreign key first
ALTER TABLE "attachments" DROP CONSTRAINT "attachments_message_id_fkey";

-- Create new table with correct column order
CREATE TABLE "messages_new" (
    "id"                  BIGSERIAL       NOT NULL,
    "tenant_id"           INTEGER         NOT NULL,
    "telegram_chat_id"    TEXT            NOT NULL,
    "telegram_message_id" INTEGER         NOT NULL,
    "from_account"        TEXT            NOT NULL,
    "to_account"          TEXT,
    "message"             TEXT,
    "raw_payload"         TEXT,
    "status"              "MessageStatus" NOT NULL DEFAULT 'pending',
    "created_at"          TIMESTAMP(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"          TIMESTAMP(3)    NOT NULL,

    CONSTRAINT "messages_new_pkey" PRIMARY KEY ("id")
);

-- Copy existing data
INSERT INTO "messages_new" (
    "id", "tenant_id", "telegram_chat_id", "telegram_message_id",
    "from_account", "message", "status", "created_at", "updated_at"
)
SELECT
    "id", "tenant_id", "telegram_chat_id", "telegram_message_id",
    "from_account", "message", "status", "created_at", "updated_at"
FROM "messages";

-- Swap tables
DROP TABLE "messages";
ALTER TABLE "messages_new" RENAME TO "messages";
ALTER TABLE "messages" RENAME CONSTRAINT "messages_new_pkey" TO "messages_pkey";

-- Rename sequence to match the original name
ALTER SEQUENCE "messages_new_id_seq" RENAME TO "messages_id_seq";
SELECT setval('"messages_id_seq"', COALESCE((SELECT MAX("id") FROM "messages"), 0) + 1, false);

-- Recreate index
CREATE INDEX "messages_tenant_id_id_status_idx" ON "messages"("tenant_id", "id", "status");

-- Restore foreign keys
ALTER TABLE "messages"
    ADD CONSTRAINT "messages_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "attachments"
    ADD CONSTRAINT "attachments_message_id_fkey"
    FOREIGN KEY ("message_id") REFERENCES "messages"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
