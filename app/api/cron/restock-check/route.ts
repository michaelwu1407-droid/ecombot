import { isAuthorisedCron, unauthorisedCron } from '@/lib/cron';
import { forEachActiveMerchant } from '@/lib/cron-runner';
import { runRestockCheck } from '@/lib/proactive/restock';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function GET(req: Request): Promise<Response> {
  if (!isAuthorisedCron(req)) return unauthorisedCron();

  try {
    return Response.json(await forEachActiveMerchant('restock', runRestockCheck));
  } catch (error) {
    console.error('[cron/restock-check] failed', error);
    return Response.json({ error: 'failed' }, { status: 500 });
  }
}
