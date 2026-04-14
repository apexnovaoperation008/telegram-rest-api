-- CreateTable
CREATE TABLE "media_files" (
    "id" BIGSERIAL NOT NULL,
    "file_key" VARCHAR(255) NOT NULL,
    "file_path" TEXT NOT NULL,
    "file_url" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "media_files_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "media_files_file_key_key" ON "media_files"("file_key");

-- CreateIndex
CREATE INDEX "media_files_expires_at_idx" ON "media_files"("expires_at");
