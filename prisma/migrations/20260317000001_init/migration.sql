-- CreateEnum
CREATE TYPE "MessageStatus" AS ENUM ('pending', 'downloaded', 'forwarded');

-- CreateEnum
CREATE TYPE "DownloadTaskStatus" AS ENUM ('pending', 'processing', 'completed', 'failed');

-- CreateTable
CREATE TABLE "tenants" (
    "id" SERIAL NOT NULL,
    "secret_id" VARCHAR(20) NOT NULL,
    "secret_code" VARCHAR(50) NOT NULL,
    "server_name" VARCHAR(255) NOT NULL,
    "callback_url" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "telegram_sessions" (
    "id" SERIAL NOT NULL,
    "tenant_id" INTEGER NOT NULL,
    "session_id" TEXT NOT NULL,
    "telegram_user_id" VARCHAR(255) NOT NULL,
    "telegram_username" VARCHAR(255) NOT NULL,
    "telegram_access_hash" VARCHAR(255) NOT NULL,
    "status" VARCHAR(50) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "telegram_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "queue_jobs" (
    "id" SERIAL NOT NULL,
    "type" VARCHAR(100) NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "status" VARCHAR(50) NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 3,
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "queue_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" INTEGER NOT NULL,
    "telegram_chat_id" TEXT NOT NULL,
    "telegram_message_id" INTEGER NOT NULL,
    "from_account" TEXT NOT NULL,
    "to_account" TEXT,
    "message" TEXT,
    "raw_payload" TEXT,
    "status" "MessageStatus" NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attachments" (
    "id" BIGSERIAL NOT NULL,
    "message_id" BIGINT NOT NULL,
    "file_unique_id" TEXT NOT NULL,
    "file_type" VARCHAR(50) NOT NULL,
    "file_url" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "download_tasks" (
    "id" BIGSERIAL NOT NULL,
    "file_unique_id" TEXT NOT NULL,
    "status" "DownloadTaskStatus" NOT NULL DEFAULT 'pending',
    "file_path" TEXT,
    "file_url" TEXT,
    "file_type" VARCHAR(50),
    "raw_input_json" TEXT,
    "from_accounts" TEXT[],
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    "started_at" TIMESTAMP(3),
    "worker_id" VARCHAR(255),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "download_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_message_state" (
    "id" SERIAL NOT NULL,
    "tenant_id" INTEGER NOT NULL,
    "from_account" TEXT NOT NULL,
    "to_account" TEXT NOT NULL,
    "last_forwarded_id" BIGINT NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_message_state_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenants_secret_id_key" ON "tenants"("secret_id");

-- CreateIndex
CREATE UNIQUE INDEX "tenants_secret_code_key" ON "tenants"("secret_code");

-- CreateIndex
CREATE UNIQUE INDEX "tenants_server_name_key" ON "tenants"("server_name");

-- CreateIndex
CREATE INDEX "queue_jobs_status_created_at_idx" ON "queue_jobs"("status", "created_at");

-- CreateIndex
CREATE INDEX "messages_tenant_id_id_status_idx" ON "messages"("tenant_id", "id", "status");

-- CreateIndex
CREATE INDEX "messages_tenant_id_to_account_id_status_idx" ON "messages"("tenant_id", "to_account", "id", "status");

-- CreateIndex
CREATE INDEX "attachments_file_unique_id_idx" ON "attachments"("file_unique_id");

-- CreateIndex
CREATE UNIQUE INDEX "download_tasks_file_unique_id_key" ON "download_tasks"("file_unique_id");

-- CreateIndex
CREATE INDEX "download_tasks_status_created_at_idx" ON "download_tasks"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_message_state_tenant_id_from_account_to_account_key" ON "tenant_message_state"("tenant_id", "from_account", "to_account");

-- AddForeignKey
ALTER TABLE "telegram_sessions" ADD CONSTRAINT "telegram_sessions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_message_state" ADD CONSTRAINT "tenant_message_state_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
