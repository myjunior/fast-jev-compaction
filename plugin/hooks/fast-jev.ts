import type {
  On,
  PluginOptions,
  Register,
  SessionMessage,
  ToolResultSummary,
  ToolUseSummary,
  TurnCompleteInput,
} from 'claude-code';

import { compact, reductionRatio, resolveOptions } from '../src/compact.js';
import { buildJevRequest, DEFAULT_MODEL, parseJevResponse } from '../src/request.js';
import type {
  CompactOptions,
  CompactResult,
  JevAsker,
  Message,
  ToolResult,
  ToolUse,
} from '../src/types.js';

const HOOK_DEFAULTS = {
  compactAtPercent: 60,
  minReductionRatio: 0.25,
  model: DEFAULT_MODEL,
};

export type HookFetchInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
};

export type HookFetchResponse = {
  status: number;
  ok: boolean;
  text: string;
};

/** The shape of `$.http.fetch`, so the hook can be driven without an engine. */
export type HookFetch = (url: string, init?: HookFetchInit) => Promise<HookFetchResponse>;

export type HookConfig = CompactOptions & {
  apiKey?: string;
  compactAtPercent: number;
  minReductionRatio: number;
  model: string;
};

function optionNumber(options: PluginOptions, key: string, fallback: number): number {
  const value = options[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function optionString(options: PluginOptions, key: string): string | undefined {
  const value = options[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Reads the plugin's `userConfig` values; anything missing takes the defaults. */
export function resolveHookConfig(options: PluginOptions): HookConfig {
  const numbers: Partial<Omit<CompactOptions, 'goal'>> = {};
  for (const key of [
    'keepThreshold',
    'preserveRecentMessages',
    'maxStateTokens',
    'maxRequestTokens',
    'truncateHeadChars',
  ] as const) {
    const value = options[key];
    if (typeof value === 'number' && Number.isFinite(value)) numbers[key] = value;
  }
  const config: HookConfig = {
    ...numbers,
    compactAtPercent: optionNumber(options, 'compactAtPercent', HOOK_DEFAULTS.compactAtPercent),
    minReductionRatio: optionNumber(
      options,
      'minReductionRatio',
      HOOK_DEFAULTS.minReductionRatio,
    ),
    model: optionString(options, 'model') ?? HOOK_DEFAULTS.model,
  };
  const apiKey = optionString(options, 'apiKey');
  if (apiKey) config.apiKey = apiKey;
  const goal = optionString(options, 'goal');
  if (goal) config.goal = goal;
  return config;
}

/** A `JevAsker` over the engine's `$.http.fetch`. */
export function jevAsker(fetchFn: HookFetch, apiKey: string, model: string): JevAsker {
  return {
    async ask(state, questions) {
      const request = buildJevRequest({ apiKey, model }, state, questions);
      const response = await fetchFn(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
      });
      return parseJevResponse(response.status, response.ok, response.text);
    },
  };
}

function toolUseSummary(tool: ToolUse): ToolUseSummary {
  const summary: ToolUseSummary = {
    tool_use_id: tool.tool_use_id,
    tool: tool.tool,
    input: tool.input,
  };
  if (tool.text !== undefined) summary.text = tool.text;
  if (tool.isError) summary.isError = true;
  return summary;
}

function toolResultSummary(result: ToolResult): ToolResultSummary {
  return {
    tool_use_id: result.tool_use_id,
    text: result.text,
    isError: result.isError ?? false,
  };
}

/**
 * Whether a kept message can go back with the engine's `handle`. Only a plain
 * user message can. A kept tool_result row with its handle keeps a parentUuid
 * behind the compact boundary, and a kept assistant row keeps its message.id,
 * so `--resume` walks back into the full pre-compaction history or repeats a
 * server_tool_use id (upstream #89, #129, #145; anthropics/claude-code#95328).
 * Rebuilt rows keep their text and tool pairs but lose hidden reasoning and
 * images inside tool results.
 */
function keepsHandle(message: SessionMessage): boolean {
  return message.role === 'user' && !message.toolResults?.length;
}

/**
 * Maps the library's output back onto session messages. A plain user message
 * that came back unchanged is the engine's own object, handle included; every
 * other message is a fresh copy without a handle (see `keepsHandle`), so the
 * engine writes it as a new record after the compact boundary.
 */
export function toSessionMessages(
  input: readonly SessionMessage[],
  output: readonly Message[],
): SessionMessage[] {
  const messages = new Map<Message, SessionMessage>();
  const uses = new Map<ToolUse, ToolUseSummary>();
  const results = new Map<ToolResult, ToolResultSummary>();
  for (const message of input) {
    messages.set(message, message);
    for (const tool of message.toolUses) uses.set(tool, tool);
    for (const result of message.toolResults ?? []) results.set(result, result);
  }
  return output.map((message) => {
    const own = messages.get(message);
    if (own && keepsHandle(own)) return own;
    const rebuilt: SessionMessage = {
      role: message.role,
      text: message.text,
      toolUses: message.toolUses.map((tool) => uses.get(tool) ?? toolUseSummary(tool)),
    };
    if (message.toolResults && message.toolResults.length > 0) {
      rebuilt.toolResults = message.toolResults.map(
        (result) => results.get(result) ?? toolResultSummary(result),
      );
    }
    return rebuilt;
  });
}

/** A prompt typed or delivered while a turn ran; `after` is the last tool result it saw. */
export type Delivery = { text: string; human: boolean; after?: string };

/** The tool_use_id of the transcript's last tool result. */
export function lastResultId(messages: readonly SessionMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const results = messages[i]!.toolResults;
    if (results?.length) return results[results.length - 1]!.tool_use_id;
  }
  return undefined;
}

/**
 * Puts mid-turn deliveries back as plain user messages. The engine keeps them
 * as attachments that `session.compact` never lists, so a list handed back
 * drops them (upstream #133). One arrives with the first tool results after
 * `after`; one with none yet is still queued and comes back as `waiting`.
 */
export function withDeliveries(
  messages: readonly SessionMessage[],
  deliveries: readonly Delivery[],
): { messages: SessionMessage[]; waiting: Delivery[] } {
  const typed = messages
    .filter((m) => m.role === 'user' && !m.toolResults?.length)
    .map((m) => m.text);
  const placed = new Map<number, SessionMessage[]>();
  const waiting: Delivery[] = [];
  for (const delivery of deliveries) {
    if (typed.some((text) => text.includes(delivery.text))) continue; // it ran as its own turn
    let at = 0;
    if (delivery.after !== undefined) {
      at = messages.findIndex((m) => m.toolResults?.some((r) => r.tool_use_id === delivery.after)) + 1;
    }
    // Anchor compacted away: keep the words, at the end, rather than lose them.
    if (delivery.after !== undefined && at === 0) at = messages.length - 1;
    else while (at < messages.length && !messages[at]!.toolResults?.length) at++;
    if (at >= messages.length) {
      waiting.push(delivery);
      continue;
    }
    const text = delivery.human
      ? `The user sent a new message while you were working:\n${delivery.text}`
      : delivery.text;
    placed.set(at, [...(placed.get(at) ?? []), { role: 'user', text, toolUses: [] }]);
  }
  return { messages: messages.flatMap((m, i) => [m, ...(placed.get(i) ?? [])]), waiting };
}

export type SessionCompaction = {
  result: CompactResult;
  messages: SessionMessage[];
};

/** Runs the library over a session transcript; throws when the key is missing or Jev fails. */
export async function compactSession(
  messages: readonly SessionMessage[],
  config: HookConfig,
  fetchFn: HookFetch,
): Promise<SessionCompaction> {
  if (!config.apiKey) throw new Error('TYPESAFE_API_KEY is not configured');
  const result = await compact(messages, jevAsker(fetchFn, config.apiKey, config.model), config);
  return { result, messages: toSessionMessages(messages, result.messages) };
}

function percent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

export function summarize(result: CompactResult): string {
  const { stats } = result;
  const parts = [
    stats.kept > 0 ? `${stats.kept} kept` : '',
    stats.resultsDropped > 0 ? `${stats.resultsDropped} results truncated` : '',
    stats.callsDropped > 0 ? `${stats.callsDropped} call_dropped` : '',
    stats.pinned > 0 ? `${stats.pinned} pinned` : '',
  ].filter(Boolean);
  return `${percent(reductionRatio(result))} reduction; ${
    parts.join(', ') || 'no tool calls'
  }; state ~${stats.stateTokens} tokens (${stats.stateStage}) in ${stats.requests} request(s)`;
}

const UI_LOG_MAX_CHARS = 4096;

export function decisionLog(result: CompactResult): string {
  return result.decisions
    .filter((d) => d.reason !== 'pinned')
    .map(
      (d) =>
        `${d.id}:${d.tool}:${d.action}/call=${d.keepCall.toFixed(2)}/result=${d.keepResult.toFixed(2)}`,
    )
    .join(' ');
}

export function decisionLogLines(
  result: CompactResult,
  maxChars: number = UI_LOG_MAX_CHARS,
): string[] {
  const entries = decisionLog(result).split(' ').filter(Boolean);
  if (entries.length === 0) return ['decisions: (none)'];
  const chunks: string[] = [];
  let current = '';
  for (const entry of entries) {
    const next = current ? `${current} ${entry}` : entry;
    if (current && next.length > maxChars - 24) {
      chunks.push(current);
      current = entry;
    } else current = next;
  }
  chunks.push(current);
  return chunks.map((chunk, index) =>
    chunks.length === 1
      ? `decisions: ${chunk}`
      : `decisions (${index + 1}/${chunks.length}): ${chunk}`,
  );
}

async function getApiKey(
  $: {
    env: { get: (name: string) => Promise<string | undefined> };
    settings: { read: () => Promise<Readonly<Record<string, unknown>>> };
  },
  config: HookConfig,
): Promise<string | undefined> {
  if (config.apiKey) return config.apiKey;
  const fromEnv = await $.env.get('TYPESAFE_API_KEY');
  if (fromEnv) return fromEnv;
  const settings = await $.settings.read();
  const env = settings['env'];
  if (env && typeof env === 'object') {
    const value = (env as Record<string, unknown>)['TYPESAFE_API_KEY'];
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
}

function notify(
  $: {
    ui: {
      log: (text: string) => void;
      toast: (text: string, options?: { timeoutMs?: number }) => void;
    };
  },
  text: string,
): void {
  $.ui.log(text);
  $.ui.toast(text, { timeoutMs: 15_000 });
}

export const register: Register = (on: On, options: PluginOptions) => {
  const configured = resolveHookConfig(options);
  let compacting = false;
  let reseated = false;
  let deliveries: Delivery[] = [];

  // Claude Code fixes a plugin's tier when it loads, sometimes before the managed
  // settings fetch lands; then this plugin sits in the user tier and sec-default
  // skips its session.compact. One /reload-plugins seats it in `append`.
  on('session.start', async ($, event, next) => {
    const result = await next(event);
    if (!reseated && (await getApiKey($, configured).catch(() => undefined))) {
      reseated = true;
      $.command.run({ command: 'reload-plugins' }).catch((error: unknown) => {
        $.ui.log(`reload skipped (${error instanceof Error ? error.message : String(error)})`);
      });
    }
    return result;
  });

  // The org enables this plugin for everyone; without a TypeSafe key it stays
  // out of the way so compaction behaves exactly as built-in.
  // A prompt typed or delivered mid-turn is invisible to session.compact; note
  // where it arrived so the compaction can put it back (see withDeliveries).
  on('prompt.submit', async ($, event, next) => {
    if (!event.turnId || event.wait) return next(event);
    if (!(await getApiKey($, configured).catch(() => undefined))) return next(event);
    const after = await $.session.messages().then(lastResultId, () => undefined);
    const result = await next(event);
    if (result.text !== undefined) {
      const human = event.origin.kind === 'composer' || event.origin.kind === 'bridge';
      deliveries.push(after === undefined ? { text: result.text, human } : { text: result.text, human, after });
    }
    return result;
  });

  on('session.compact', async ($, event, next) => {
    const apiKey = await getApiKey($, configured).catch(() => undefined);
    if (!apiKey) return next(event);
    // A subagent's transcript never holds the main loop's deliveries.
    const main = !event.agentId;
    const seen = deliveries.length;
    const { messages: input, waiting } = main
      ? withDeliveries(event.messages, deliveries)
      : { messages: [...event.messages], waiting: [] };
    // Placed deliveries are in the new transcript (or the built-in summary);
    // waiting ones now arrive after its last tool result.
    const settle = (kept?: readonly SessionMessage[]): void => {
      if (!main) return;
      const after = kept && lastResultId(kept);
      deliveries = [
        ...waiting.map(({ text, human }) => (after === undefined ? { text, human } : { text, human, after })),
        ...deliveries.slice(seen),
      ];
    };
    const builtIn = async () => {
      const compacted = await next(event);
      if (!compacted.skip) settle();
      return compacted;
    };
    try {
      const config = { ...configured, apiKey };
      const { result, messages } = await compactSession(input, config, async (url, init) => {
        const response = await $.http.fetch(url, init);
        return { status: response.status, ok: response.ok, text: response.text };
      });
      for (const line of decisionLogLines(result)) $.ui.log(line);
      if (reductionRatio(result) < config.minReductionRatio) {
        notify(
          $,
          `fallback to built-in summary (below ${percent(config.minReductionRatio)} minimum: ${summarize(result)})`,
        );
        return builtIn();
      }
      notify(
        $,
        `kept ${messages.length}/${event.messages.length} messages, no summary (${summarize(result)})`,
      );
      settle(messages);
      return { messages };
    } catch (error) {
      notify(
        $,
        `fallback to built-in summary (${error instanceof Error ? error.message : String(error)})`,
      );
      return builtIn();
    }
  });

  on('turn.complete', async ($, event: TurnCompleteInput, next) => {
    if (compacting) return next(event);
    try {
      if (!(await getApiKey($, configured))) return next(event);
      const { context } = await $.session.usage();
      if ((context.percent ?? 0) < configured.compactAtPercent) return next(event);
      compacting = true;
      await $.session.compact();
    } catch (error) {
      $.ui.log(
        `auto-compact skipped (${error instanceof Error ? error.message : String(error)})`,
      );
    } finally {
      compacting = false;
    }
    return next(event);
  });
};

export { resolveOptions };
