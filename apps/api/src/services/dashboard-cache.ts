import { prisma } from "@smm/db";

// Tiny helper around DashboardAiCache. Each AI-powered dashboard section
// reads via getCachedOrNull() and the user explicitly triggers regen via
// a refresh button -> regenAndCache() in the route. No background refresh.

export type CachedAiPayload<T> = {
  payload: T;
  generatedAt: string;
  inputTokens: number | null;
  outputTokens: number | null;
} | null;

export async function getCachedOrNull<T>(kind: string): Promise<CachedAiPayload<T>> {
  const row = await prisma.dashboardAiCache.findUnique({ where: { kind } });
  if (!row) return null;
  return {
    payload: row.payload as T,
    generatedAt: row.generatedAt.toISOString(),
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
  };
}

export async function writeCached<T>(
  kind: string,
  payload: T,
  tokens: { input?: number; output?: number } = {}
): Promise<void> {
  await prisma.dashboardAiCache.upsert({
    where: { kind },
    create: {
      kind,
      payload: payload as never,
      inputTokens: tokens.input ?? null,
      outputTokens: tokens.output ?? null,
    },
    update: {
      payload: payload as never,
      inputTokens: tokens.input ?? null,
      outputTokens: tokens.output ?? null,
      generatedAt: new Date(),
    },
  });
}
