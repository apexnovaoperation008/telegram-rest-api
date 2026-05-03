-- Resolve any messages stuck in 'pending' status before removing the enum value.
-- Mark them as 'downloaded' so the forwarding scheduler can process them.
UPDATE "messages"
SET status = 'downloaded',
    raw_payload = CASE
      WHEN raw_payload IS NOT NULL
      THEN jsonb_set(raw_payload::jsonb, '{download_failed}', 'true')::text
      ELSE raw_payload
    END
WHERE status = 'pending';

-- Drop tables that are no longer needed
DROP TABLE IF EXISTS "attachments";
DROP TABLE IF EXISTS "download_tasks";

-- Remove 'pending' from MessageStatus enum
ALTER TYPE "MessageStatus" RENAME TO "MessageStatus_old";
CREATE TYPE "MessageStatus" AS ENUM ('downloaded', 'forwarded', 'delivery_failed');
ALTER TABLE "messages" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "messages" ALTER COLUMN "status" TYPE "MessageStatus" USING ("status"::text::"MessageStatus");
ALTER TABLE "messages" ALTER COLUMN "status" SET DEFAULT 'downloaded';
DROP TYPE "MessageStatus_old";

-- Drop the DownloadTaskStatus enum
DROP TYPE IF EXISTS "DownloadTaskStatus";
