/**
 * Shared types for both agents (BUILD_SPEC §2.1).
 *
 * The shopper agent and the operator agent run the same loop with different
 * toolsets and different guardrail profiles — one codebase, two configurations.
 */

export interface AgentConfig {
  brand_voice: string | null;
  voice_examples: unknown;
  discount_floor_pct: number;
  escalation_rules: string | null;
  auto_send: boolean;
  active_hours: unknown;
  shipping_policy: string | null;
  returns_policy: string | null;
}

export interface CustomerProfile {
  id: string;
  handle: string | null;
  name: string | null;
  size: string | null;
  preferences: Record<string, unknown>;
  budget_range: string | null;
  lifetime_value_cents: number;
}

export interface Skill {
  name: string;
  content: string;
}

export interface ConversationMessage {
  direction: 'inbound' | 'outbound';
  sender: 'customer' | 'agent' | 'merchant';
  content: string;
}

export interface ShopperContext {
  merchantId: string;
  businessName: string;
  conversationId: string;
  customer: CustomerProfile;
  config: AgentConfig;
  skills: Skill[];
  history: ConversationMessage[];
  source: 'dm' | 'comment' | 'story_reply';
}

// ---------------------------------------------------------------------------
// Tool plumbing
// ---------------------------------------------------------------------------

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties: false;
  };
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * What a tool actually returned. Structured data, never prose (§4.4) — the model
 * writes the sentence, the tool supplies the facts.
 */
export interface ToolResult {
  callId: string;
  name: string;
  result: unknown;
}

/**
 * The record of what tools established during this turn.
 *
 * This is what makes guardrails possible in code rather than prompt (§3.3). A
 * price in the reply is checked against `pricesCents`; a claim that something is
 * in stock is checked against `availableVariants`. Without a ledger you can only
 * ask the model to behave, and eventually it will not.
 */
export interface TurnLedger {
  /** Every price, in cents, any tool returned this turn. */
  pricesCents: Set<number>;
  /** Variants a tool confirmed as purchasable. */
  availableVariantIds: Set<string>;
  /** Variants a tool confirmed as out of stock. */
  unavailableVariantIds: Set<string>;
  /** Policy text returned by get_policy, keyed by kind. */
  policies: Map<'shipping' | 'returns', string>;
  /** Set when the model called escalate(). */
  escalation: { reason: string } | null;
  /** Payment links minted this turn, so their amounts count as tool-established. */
  paymentLinkUrls: Set<string>;
}

export function emptyLedger(): TurnLedger {
  return {
    pricesCents: new Set(),
    availableVariantIds: new Set(),
    unavailableVariantIds: new Set(),
    policies: new Map(),
    escalation: null,
    paymentLinkUrls: new Set(),
  };
}

export interface ToolContext {
  merchantId: string;
  conversationId: string;
  customerId: string;
  config: AgentConfig;
  ledger: TurnLedger;
  /**
   * Operator agent only: the merchant's own words for this turn, recorded on any
   * operator_task the tools create so the confirmation screen shows what was asked
   * alongside what was understood.
   */
  request?: string;
}

export type ToolHandler = (
  args: Record<string, unknown>,
  context: ToolContext
) => Promise<unknown>;

export interface Tool {
  definition: ToolDefinition;
  handler: ToolHandler;
}
