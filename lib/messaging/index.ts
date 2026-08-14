import { env } from '../env';
import type { MessagingProvider } from './types';
import { zernioProvider } from './providers/zernio';
import { metaProvider } from './providers/meta';
import { mockProvider } from './providers/mock';

/**
 * The only entry point to messaging (BUILD_SPEC §4.2).
 *
 * No file outside lib/messaging/ may import a provider directly. Everything
 * upstream — the webhook route, the agent, the cron jobs — talks to the
 * interface, which is what makes the Meta migration a one-file change.
 */

export type { InboundEvent, Message, MessagingProvider, SendResult } from './types';
export { MessagingError } from './types';
export { isWithinMessagingWindow, messagingWindowState } from './window';

let override: MessagingProvider | null = null;

export function getMessagingProvider(): MessagingProvider {
  if (override) return override;

  switch (env.messagingProvider()) {
    case 'meta':
      return metaProvider;
    case 'mock':
      return mockProvider;
    case 'zernio':
      return zernioProvider;
    default:
      throw new Error(
        `Unknown MESSAGING_PROVIDER '${env.messagingProvider()}'. Expected one of: zernio, meta, mock.`
      );
  }
}

/** Test seam. Production code never calls this. */
export function setMessagingProvider(provider: MessagingProvider | null): void {
  override = provider;
}
