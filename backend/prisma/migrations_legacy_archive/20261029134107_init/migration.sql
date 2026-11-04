-- CreateTable
CREATE TABLE "system_health_records" (
    "id" TEXT NOT NULL,
    "service" TEXT NOT NULL DEFAULT 'relay-backend',
    "status" TEXT NOT NULL DEFAULT 'ok',
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" JSONB,

    CONSTRAINT "system_health_records_pkey" PRIMARY KEY ("id")
);
