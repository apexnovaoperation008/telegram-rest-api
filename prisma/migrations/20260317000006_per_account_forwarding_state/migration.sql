-- Migrate tenant_message_state from per-tenant to per-(tenant, from_account, to_account) tracking.
-- Existing cursor state is dropped; the scheduler will rebuild it on the first run.

-- Drop existing table (PK was tenant_id only); use IF EXISTS so re-runs are safe
ALTER TABLE IF EXISTS "tenant_message_state" DROP CONSTRAINT IF EXISTS "tenant_message_state_tenant_id_fkey";
DROP TABLE IF EXISTS "tenant_message_state";

-- Recreate with auto-increment PK and composite unique on (tenant_id, from_account, to_account)
CREATE TABLE "tenant_message_state" (
    "id"                SERIAL       NOT NULL,
    "tenant_id"         INTEGER      NOT NULL,
    "from_account"      TEXT         NOT NULL,
    "to_account"        TEXT         NOT NULL,
    "last_forwarded_id" BIGINT       NOT NULL DEFAULT 0,
    "updated_at"        TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_message_state_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "tenant_message_state_tenant_id_from_account_to_account_key"
    ON "tenant_message_state"("tenant_id", "from_account", "to_account");

ALTER TABLE "tenant_message_state"
    ADD CONSTRAINT "tenant_message_state_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- Add composite index for the per-channel forwarding query
CREATE INDEX "messages_tenant_id_to_account_id_status_idx"
    ON "messages"("tenant_id", "to_account", "id", "status");
