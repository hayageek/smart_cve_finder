-- Cursor + Claude runtime overrides (null = inherit from environment)
ALTER TABLE "WorkerConfig" ADD COLUMN IF NOT EXISTS "cursorAgentModel" TEXT;
ALTER TABLE "WorkerConfig" ADD COLUMN IF NOT EXISTS "cursorApiKey" TEXT;
ALTER TABLE "WorkerConfig" ADD COLUMN IF NOT EXISTS "cursorAgentTimeoutMs" INTEGER;
ALTER TABLE "WorkerConfig" ADD COLUMN IF NOT EXISTS "debugCursor" BOOLEAN;
ALTER TABLE "WorkerConfig" ADD COLUMN IF NOT EXISTS "claudeMaxTokens" INTEGER;
