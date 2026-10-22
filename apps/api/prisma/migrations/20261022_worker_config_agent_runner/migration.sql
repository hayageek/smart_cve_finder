-- Agent runner selection and optional OpenAI-compatible Claude proxy settings.
-- NULL means inherit the environment. Empty string means explicitly unset.
ALTER TABLE "WorkerConfig" ADD COLUMN "agentRunner" TEXT;
ALTER TABLE "WorkerConfig" ADD COLUMN "claudeAgentModel" TEXT;
ALTER TABLE "WorkerConfig" ADD COLUMN "anthropicBaseUrl" TEXT;
ALTER TABLE "WorkerConfig" ADD COLUMN "anthropicAuthToken" TEXT;
