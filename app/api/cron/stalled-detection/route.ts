import { isAuthorisedCron, unauthorisedCron } from '@/lib/cron';
import { markStalledConversations } from '@/lib/conversations';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  if (!isAuthorisedCron(req)) return unauthorisedCron();

  try {
    const stalled = await markStalledConversations();
    return Response.json({ ok: true, stalled });
  } catch (error) {
    console.error('[cron/stalled-detection] failed', error);
    return Response.json({ error: 'failed' }, { status: 500 });
  }
}
