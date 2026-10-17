import { ZodError } from 'zod';
import { body } from '@/server/http';
import { ServiceError } from '@/server/store';
import { simulationEndpoint } from '@/server/simulations/access';
import { describeIssues } from '@/server/worldlines/input';
import { runWorldlines, worldlineCards, worldlineOpening } from '@/server/worldlines/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 把"读不懂参数"翻译成能改的话，别让用户看到车贷文案 */
async function guarded<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof ZodError) throw new ServiceError(422, `参数没读懂：${describeIssues(error.issues)}`);
    throw error;
  }
}

export const GET = simulationEndpoint(async (request, _owner, context) => {
  const parts = request.nextUrl.pathname.slice('/api/worldlines/'.length).split('/');
  const goalId = request.nextUrl.searchParams.get('goalId');
  if (parts[0] === 'opening') return worldlineOpening(context.workspaceId, goalId);
  if (parts[0] === 'cards') {
    const target = request.nextUrl.searchParams.get('target') === 'home' ? 'home' : 'car';
    return worldlineCards(target);
  }
  throw new ServiceError(404, '接口不存在');
});

export const POST = simulationEndpoint(async (request, _owner, context) => {
  const parts = request.nextUrl.pathname.slice('/api/worldlines/'.length).split('/');
  const payload = (await body(request)) as Record<string, unknown>;
  if (parts[0] === 'runs') {
    const { model } = await guarded(() => runWorldlines(context.workspaceId, payload));
    return model;
  }
  throw new ServiceError(404, '接口不存在');
});
