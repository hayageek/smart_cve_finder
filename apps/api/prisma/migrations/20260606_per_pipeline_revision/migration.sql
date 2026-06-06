-- Per-pipeline revision tracking (CVE vs secrets scanned independently).
ALTER TABLE "Repo" ADD COLUMN "lastCveScannedRevision" TEXT;
ALTER TABLE "Repo" ADD COLUMN "lastSecretScannedRevision" TEXT;

-- Backfill from the latest completed scan job per repo.
UPDATE "Repo" r
SET
  "lastCveScannedRevision" = CASE
    WHEN sj."scanMode" IN ('cve', 'both') THEN r."lastScannedRevision"
    ELSE NULL
  END,
  "lastSecretScannedRevision" = CASE
    WHEN sj."scanMode" IN ('secrets', 'both') THEN r."lastScannedRevision"
    ELSE NULL
  END
FROM (
  SELECT DISTINCT ON ("repoId") "repoId", "scanMode"
  FROM "ScanJob"
  WHERE "status" = 'done'
  ORDER BY "repoId", "finishedAt" DESC NULLS LAST, "createdAt" DESC
) sj
WHERE r.id = sj."repoId"
  AND r."lastScannedRevision" IS NOT NULL;

-- Repos with a stored revision but no completed job (legacy): assume CVE was scanned.
UPDATE "Repo"
SET "lastCveScannedRevision" = "lastScannedRevision"
WHERE "lastScannedRevision" IS NOT NULL
  AND "lastCveScannedRevision" IS NULL
  AND "lastSecretScannedRevision" IS NULL;
