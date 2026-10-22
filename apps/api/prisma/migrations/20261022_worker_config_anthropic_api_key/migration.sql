-- Store the Claude credential as an API key. Existing token values are kept.
ALTER TABLE "WorkerConfig" RENAME COLUMN "anthropicAuthToken" TO "anthropicApiKey";
