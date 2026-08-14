import { timingSafeEqual } from 'node:crypto';
import { env } from './env';

/**
 * Cron endpoints are public URLs. Vercel authenticates its own invocations with
 * `Authorization: Bearer $CRON_SECRET`; without this check anyone who guesses a
 * path could trigger sends on a merchant's account.
 */
export function isAuthorisedCron(req: Request): boolean {
  const header = req.headers.get('authorization');
  if (!header?.startsWith('Bearer ')) return false;

  const provided = Buffer.from(header.slice(7));
  const expected = Buffer.from(env.cronSecret());
  if (provided.length !== expected.length) return false;

  return timingSafeEqual(provided, expected);
}

export function unauthorisedCron(): Response {
  return Response.json({ error: 'unauthorised' }, { status: 401 });
}
