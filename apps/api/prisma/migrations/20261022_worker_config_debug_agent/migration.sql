-- Rename debug flag to match DEBUG_AGENT (both Cursor and Claude runners).
ALTER TABLE "WorkerConfig" RENAME COLUMN "debugCursor" TO "debugAgent";
