import { PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
});

export async function ensureWorkerConfig() {
  const count = await prisma.workerConfig.count();
  if (count === 0) {
    await prisma.workerConfig.create({ data: {} });
  }
}
