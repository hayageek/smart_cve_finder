-- CVE hunt skill chosen for a scan job (null keeps the worker CVE_SCAN_MODE default).
ALTER TABLE "ScanJob" ADD COLUMN "cveSkill" TEXT;
