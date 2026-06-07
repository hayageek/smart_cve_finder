#!/usr/bin/env node
/**
 * Delete Secret rows whose redactedValue fails isInvalidSecretShape
 * (covers `;`, `\`, leading `.`, `/` path fragments, etc.).
 * Applies to both confirmed (dropped=false) and dropped (dropped=true) rows.
 *
 * Usage: node scripts/cleanup-invalid-secret-shapes.mjs [--dry-run]
 */
import { PrismaClient } from '@prisma/client';
import { isInvalidSecretShape } from '../packages/secret-scan/dist/validate.js';

const dryRun = process.argv.includes('--dry-run');
const prisma = new PrismaClient();

try {
  const rows = await prisma.secret.findMany({
    where: { redactedValue: { not: null } },
    select: { id: true, ruleId: true, redactedValue: true, dropped: true, verifyStatus: true },
  });

  const toDelete = rows.filter((r) => isInvalidSecretShape(r.redactedValue));
  const confirmed = toDelete.filter((r) => !r.dropped).length;
  const dropped = toDelete.filter((r) => r.dropped).length;
  const verified = toDelete.filter((r) => r.verifyStatus === 'verified').length;

  console.log(`Scanned ${rows.length} secret(s) with redactedValue`);
  console.log(`Invalid shape: ${toDelete.length} (${confirmed} confirmed, ${dropped} dropped)`);
  if (verified > 0) {
    console.warn(`WARNING: ${verified} verified row(s) would be deleted — aborting`);
    process.exit(1);
  }

  if (dryRun) {
    console.log('Dry run — no rows deleted');
    const byRule = new Map();
    for (const r of toDelete) byRule.set(r.ruleId, (byRule.get(r.ruleId) || 0) + 1);
    [...byRule.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).forEach(([k, v]) => console.log(`  ${v}\t${k}`));
  } else if (toDelete.length > 0) {
    const { count } = await prisma.secret.deleteMany({
      where: { id: { in: toDelete.map((r) => r.id) } },
    });
    console.log(`Deleted ${count} secret(s)`);
  } else {
    console.log('Nothing to delete');
  }
} finally {
  await prisma.$disconnect();
}
