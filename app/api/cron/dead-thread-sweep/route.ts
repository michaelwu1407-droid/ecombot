import { isAuthorisedCron, unauthorisedCron } from '@/lib/cron';
import { forEachActiveMerchant } from '@/lib/cron-runner';
import { runDeadThreadSweep } from '@/lib/proactive/revival';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function GET(req: Request): Promise<Response> {
  if (!isAuthorisedCron(req)) return unauthorisedCron();

  try {
    return Response.json(
      await forEachActiveMerchant('revival', (merchantId) => runDeadThreadSweep(merchantId))
    );
  } catch (error) {
    console.error('[cron/dead-thread-sweep] failed', error);
    return Response.json({ error: 'failed' }, { status: 500 });
  }
}
