import type { Prisma } from '@prisma/client';
import { goalFactsSchema } from '@/domain/agents';

/** Materialize an explicitly confirmed target; this never adopts a plan or reserves money. */
export async function materializeConfirmedGoal(tx: Prisma.TransactionClient, workspaceId: string, decisionId: string) {
  const decision = await tx.goalDecision.findFirst({ where: { id: decisionId, workspaceId, status: { not: 'REDACTED' } } });
  if (!decision || decision.legacyDecisionId || decision.goalId || decision.activePlanId) return decision?.goalId ?? null;
  const parsed = goalFactsSchema.safeParse(JSON.parse(decision.factsJson));
  if (!parsed.success || !parsed.data.confirmed) return null;
  const facts = parsed.data;
  if (!facts.targetAmountMinor || BigInt(facts.targetAmountMinor) <= 0n || !facts.targetDate) return null;
  const goal = await tx.goal.create({ data: {
    workspaceId, name: facts.name, type: /汽车|购车|买车|换车/.test(facts.name) ? 'CAR_PURCHASE' : 'OTHER',
    targetAmountMinor: BigInt(facts.targetAmountMinor), targetDate: new Date(`${facts.targetDate}T00:00:00+08:00`),
    priority: facts.priority ?? 2, priorityConfirmedAt: facts.priority ? new Date() : null,
    preparedAmountMinor: BigInt(facts.preparedAmountMinor ?? '0'), source: 'AGENT_CONFIRMED',
  } });
  await tx.goalDecision.update({ where: { id: decision.id }, data: { goalId: goal.id, version: { increment: 1 } } });
  await tx.agentSession.updateMany({ where: { workspaceId, decisionId, goalId: null }, data: { goalId: goal.id } });
  const workspace = await tx.workspace.update({ where: { id: workspaceId }, data: { portfolioRevision: { increment: 1 } } });
  await tx.auditEvent.create({ data: { workspaceId, entityType: 'GOAL', entityId: goal.id, action: 'CONFIRMED_TARGET_LINKED', revision: workspace.portfolioRevision } });
  return goal.id;
}
