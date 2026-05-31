-- Severity sort order: CRITICAL (4) > HIGH (3) > MEDIUM (2) > LOW (1)
ALTER TABLE "Vulnerability" ADD COLUMN "severityRank" INTEGER NOT NULL DEFAULT 0;

UPDATE "Vulnerability" SET "severityRank" = CASE "severity"
  WHEN 'CRITICAL' THEN 4
  WHEN 'HIGH' THEN 3
  WHEN 'MEDIUM' THEN 2
  WHEN 'LOW' THEN 1
  ELSE 0
END;

CREATE INDEX "Vulnerability_severityRank_idx" ON "Vulnerability"("severityRank");
