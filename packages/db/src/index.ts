import { PrismaClient } from "@prisma/client";

declare global {
  // eslint-disable-next-line no-var
  var __smmPrisma: PrismaClient | undefined;
}

export const prisma: PrismaClient =
  globalThis.__smmPrisma ?? new PrismaClient({ log: ["warn", "error"] });

if (process.env.NODE_ENV !== "production") {
  globalThis.__smmPrisma = prisma;
}

export * from "@prisma/client";
