import { isAuthorisedCron, unauthorisedCron } from '@/lib/cron';
import { markStalledConversations } from '@/lib/conversations';
import { releaseStuckComments } from '@/lib/capture/comments';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  if (!isAuthorisedCron(req)) return unauthorisedCron();

  try {
    const stalled = await markStalledConversations();
    // A claim left unresolved means a run died mid-flight; the comment would stay
    // claimed forever and never be retried.
    const releasedComments = await releaseStuckComments();
    return Response.json({ ok: true, stalled, releasedComments });
  } catch (error) {
    console.error('[cron/stalled-detection] failed', error);
    return Response.json({ error: 'failed' }, { status: 500 });
  }
}
