/**
 * Research delegation to a Hermes Agent instance (BUILD_SPEC addendum §3.7).
 *
 * Hermes is a tool, not the runtime. It is genuinely better than a bare model call
 * at open-ended external investigation — browser automation, web search, following
 * a question somewhere it did not start. It is not better at anything to do with
 * this product, because it has no Instagram or commerce tools, its memory lives
 * somewhere the dashboard cannot read, and roughly 95% of what a merchant asks is
 * a read or a write against our own Postgres.
 *
 * So the boundary is hard:
 *
 *   * Operator agent only. Never the shopper agent, never in the path of a
 *     customer conversation. A customer waiting five seconds cannot wait on a
 *     browser session.
 *   * Read-only. It returns text. It never writes to our database and is never
 *     given our credentials.
 *   * Degrades alone. If the VPS is down, this one tool fails and everything else
 *     keeps working — which is why there is no shared client, no startup check,
 *     and no throw on a missing environment variable.
 *
 * Security: the answer contains text Hermes read off the open web. It is untrusted
 * input arriving through a trusted-looking channel, and the operator agent is
 * told to treat it as data rather than instructions.
 */

const REQUEST_TIMEOUT_MS = 60_000;
const MAX_ANSWER_LENGTH = 4_000;

export interface ResearchResult {
  ok: boolean;
  answer: string;
  /** Set when the tool degraded, so the operator agent can say so plainly. */
  error?: 'not_configured' | 'unreachable' | 'timeout' | 'bad_response';
}

const UNAVAILABLE =
  "I couldn't get an answer to that — the research service didn't respond. Everything else still works.";

export function isResearchConfigured(): boolean {
  return Boolean(process.env.HERMES_API_URL && process.env.HERMES_API_KEY);
}

export async function research(question: string): Promise<ResearchResult> {
  const baseUrl = process.env.HERMES_API_URL;
  const apiKey = process.env.HERMES_API_KEY;

  if (!baseUrl || !apiKey) {
    return {
      ok: false,
      answer: "Research isn't set up for this account yet.",
      error: 'not_configured',
    };
  }

  const trimmed = question.trim();
  if (!trimmed) {
    return { ok: false, answer: 'No question was provided.', error: 'bad_response' };
  }

  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: process.env.HERMES_MODEL || 'hermes',
        messages: [
          {
            role: 'system',
            content:
              'You research questions about the outside world for a small retail business. Use the web. Answer in a few short paragraphs, plainly, with figures where you have them. Say what you could not find rather than guessing.',
          },
          { role: 'user', content: trimmed },
        ],
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      return { ok: false, answer: UNAVAILABLE, error: 'unreachable' };
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string | null } }>;
    };

    const answer = payload.choices?.[0]?.message?.content?.trim();
    if (!answer) {
      return { ok: false, answer: UNAVAILABLE, error: 'bad_response' };
    }

    return { ok: true, answer: answer.slice(0, MAX_ANSWER_LENGTH) };
  } catch (error) {
    // A 60-second wait that ends in nothing is still better than hanging the
    // merchant's assistant indefinitely.
    const timedOut = error instanceof Error && error.name === 'TimeoutError';
    return { ok: false, answer: UNAVAILABLE, error: timedOut ? 'timeout' : 'unreachable' };
  }
}
