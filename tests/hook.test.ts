import { describe, expect, it } from 'vitest';
import {
  compactSession,
  decisionLog,
  decisionLogLines,
  lastResultId,
  register,
  resolveHookConfig,
  summarize,
  toSessionMessages,
  withDeliveries,
} from '../plugin/hooks/fast-jev.ts';
import { applyDecisions, collectToolCalls, decideCall, type Message } from '../plugin/src/index.js';

type SessionMessage = Message & { handle?: string };

function message(role: Message['role'], text: string, extra: Partial<SessionMessage> = {}): SessionMessage {
  return { role, text, toolUses: [], ...extra };
}

function call(id: string, tool: string, input: Record<string, unknown>, text: string): SessionMessage {
  return message('assistant', '', {
    toolUses: [{ tool_use_id: id, tool, input, text }],
    handle: `h-${id}`,
  });
}

function result(id: string, text: string, isError = false): SessionMessage {
  return message('user', '', { toolResults: [{ tool_use_id: id, text, isError }], handle: `r-${id}` });
}

const fileA = 'export const a = 1;\n'.repeat(50);

function transcript(): SessionMessage[] {
  return [
    message('user', 'Fix the failing test.', { handle: 'h-0' }),
    call('tool-1', 'Read', { file_path: 'src/a.ts' }, fileA),
    result('tool-1', fileA),
    call('tool-2', 'Bash', { command: 'npm test' }, 'FAIL'),
    result('tool-2', 'FAIL b.test.ts: expected 2 to be 3', true),
    message('assistant', 'Fixing now.', { handle: 'h-5' }),
    message('user', 'go ahead', { handle: 'h-6' }),
  ];
}

function jevFetch(answer: (name: string) => number, bodies: string[] = []) {
  return async (_url: string, init?: { body?: string }) => {
    bodies.push(init?.body ?? '');
    const { questions } = JSON.parse(init?.body ?? '{}') as { questions: Record<string, unknown> };
    const answers = Object.fromEntries(
      Object.keys(questions).map((key) => [key, { type: 'noul', noul: answer(key) }]),
    );
    return { status: 200, ok: true, text: JSON.stringify({ answers }) };
  };
}

describe('hook config', () => {
  it('reads userConfig values and falls back to defaults', () => {
    expect(resolveHookConfig({})).toEqual({ compactAtPercent: 60, minReductionRatio: 0.25, model: 'jev-latest' });
    expect(
      resolveHookConfig({ apiKey: 'k', keepThreshold: 0.3, maxStateTokens: 1000, model: 'jev-x', goal: 'g', compactAtPercent: 'no' }),
    ).toEqual({
      apiKey: 'k',
      keepThreshold: 0.3,
      maxStateTokens: 1000,
      model: 'jev-x',
      goal: 'g',
      compactAtPercent: 60,
      minReductionRatio: 0.25,
    });
  });
});

describe('session message mapping', () => {
  it('returns the engine objects for untouched messages and handle-less copies for rebuilt ones', () => {
    const messages = transcript();
    const calls = collectToolCalls(messages, 0);
    const decisions = [
      decideCall(calls[0]!, { keepCall: 0.9, keepResult: 0.1 }, { keepThreshold: 0.5 }),
      decideCall(calls[1]!, { keepCall: 0.9, keepResult: 0.9 }, { keepThreshold: 0.5 }),
    ];
    messages[1]!.toolUses[0]!.text = 'x'.repeat(2000);
    messages[2]!.toolResults![0]!.text = 'x'.repeat(2000);
    const out = toSessionMessages(messages, applyDecisions(messages, decisions, calls, 300));
    expect(out).toHaveLength(messages.length);
    expect(out[0]).toBe(messages[0]);
    expect(out[1]?.handle).toBeUndefined();
    expect(out[1]?.toolUses[0]?.text).toMatch(
      new RegExp(`^${'x'.repeat(300)}\\n\\[fast-jev-compaction truncated 1700 chars`),
    );
    expect(out[2]?.handle).toBeUndefined();
    expect(out[2]?.toolResults?.[0]?.text).toMatch(
      new RegExp(`^${'x'.repeat(300)}\\n\\[fast-jev-compaction truncated 1700 chars`),
    );
    expect(out[2]?.toolResults?.[0]).toMatchObject({ tool_use_id: 'tool-1', isError: false });
    expect(out[3]?.handle).toBeUndefined();
    expect(out[3]?.toolUses).toEqual(messages[3]?.toolUses);
    expect(out[4]?.handle).toBeUndefined();
    expect(out[4]?.toolResults).toEqual(messages[4]?.toolResults);
  });

  it('keeps short unchanged messages whole, with handles only on plain user messages', () => {
    const messages = transcript();
    messages[1]!.toolUses[0]!.text = 'y'.repeat(100);
    messages[2]!.toolResults![0]!.text = 'y'.repeat(100);
    const calls = collectToolCalls(messages, 0);
    const decisions = [
      decideCall(calls[0]!, { keepCall: 0.9, keepResult: 0.1 }, { keepThreshold: 0.5 }),
      decideCall(calls[1]!, { keepCall: 0.9, keepResult: 0.9 }, { keepThreshold: 0.5 }),
    ];
    const out = toSessionMessages(messages, applyDecisions(messages, decisions, calls, 300));
    expect(out[1]).toEqual({ ...messages[1], handle: undefined });
    expect(out[2]).toEqual({ ...messages[2], handle: undefined });
  });

  it('never returns a handle on tool_result or assistant rows, so --resume stays compacted', () => {
    const messages = transcript();
    const out = toSessionMessages(messages, [...messages]);
    expect(out.map((m) => m.handle)).toEqual(['h-0', undefined, undefined, undefined, undefined, undefined, 'h-6']);
    expect(out[0]).toBe(messages[0]);
    expect(out[5]).toEqual({ role: 'assistant', text: 'Fixing now.', toolUses: [] });
    expect(out[4]?.toolResults).toEqual(messages[4]?.toolResults);
  });
});

describe('mid-turn deliveries', () => {
  it('places each after the first tool results past its anchor, waits when none yet', () => {
    const messages = transcript();
    const { messages: out, waiting } = withDeliveries(messages, [
      { text: 'also the ids', human: true, after: 'tool-1' },
      { text: '<task-notification>report</task-notification>', human: false },
      { text: 'still queued', human: true, after: 'tool-2' },
      { text: 'go ahead', human: true, after: 'tool-2' },
      { text: 'anchor gone', human: true, after: 'tool-0' },
    ]);
    expect(out.map((m) => m.text)).toEqual([
      'Fix the failing test.',
      '',
      '',
      '<task-notification>report</task-notification>',
      '',
      '',
      'The user sent a new message while you were working:\nalso the ids',
      'Fixing now.',
      'go ahead',
      'The user sent a new message while you were working:\nanchor gone',
    ]);
    expect(waiting).toEqual([{ text: 'still queued', human: true, after: 'tool-2' }]);
    expect(lastResultId(messages)).toBe('tool-2');
  });

  it('puts a prompt queued mid-turn back into the compacted transcript', async () => {
    type Handler = ($: unknown, event: unknown, next: (e: unknown) => Promise<unknown>) => Promise<unknown>;
    const handlers: Record<string, Handler> = {};
    (register as unknown as (on: unknown, options: unknown) => void)(
      (name: string, handler: Handler) => (handlers[name] = handler),
      { apiKey: 'k', preserveRecentMessages: 1, minReductionRatio: 0 },
    );
    const before = transcript().slice(0, 2);
    const $ = {
      env: { get: async () => undefined },
      settings: { read: async () => ({}) },
      session: { messages: async () => before },
      http: { fetch: jevFetch(() => 0.9) },
      ui: { log: () => {}, toast: () => {} },
    };
    const prompt = { text: 'QUEUED', turnId: 't', wait: false, origin: { kind: 'composer' } };
    await handlers['prompt.submit']!($, prompt, async (e) => e);
    const first = (await handlers['session.compact']!($, { messages: transcript() }, async () => {
      throw new Error('built-in');
    })) as { messages: SessionMessage[] };
    expect(first.messages[3]?.text).toBe('The user sent a new message while you were working:\nQUEUED');
    // Placed once: a later compaction sees it as an ordinary message.
    const second = (await handlers['session.compact']!($, { messages: first.messages }, async () => {
      throw new Error('built-in');
    })) as { messages: SessionMessage[] };
    expect(second.messages.filter((m) => m.text.includes('QUEUED'))).toHaveLength(1);
  });
});

describe('compactSession', () => {
  it('runs the library over the engine fetch and reports the outcome', async () => {
    const bodies: string[] = [];
    const config = { ...resolveHookConfig({ preserveRecentMessages: 1 }), apiKey: 'k', model: 'jev-x' };
    const { result: output, messages } = await compactSession(
      transcript(),
      config,
      jevFetch((name) => (name === 'call_t2' || name === 'result_t2' ? 0.9 : 0.1), bodies),
    );
    expect(bodies).toHaveLength(1);
    expect(JSON.parse(bodies[0]!).model).toBe('jev-x');
    expect(output.decisions.map((d) => d.action)).toEqual(['drop_call', 'keep']);
    expect(messages.map((m) => m.handle)).toEqual(['h-0', undefined, undefined, undefined, 'h-6']);
    expect(summarize(output)).toMatch(/^\d+% reduction; 1 kept, 1 call_dropped; state ~\d+ tokens \(full\) in 1 request\(s\)$/);
    expect(decisionLog(output)).toBe('t1:Read:drop_call/call=0.10/result=0.10 t2:Bash:keep/call=0.90/result=0.90');
    expect(decisionLogLines(output)).toEqual([`decisions: ${decisionLog(output)}`]);
  });

  it('splits a long decision log into ui.log lines under the host limit', async () => {
    const config = { ...resolveHookConfig({ preserveRecentMessages: 1 }), apiKey: 'k' };
    const { result: output } = await compactSession(transcript(), config, jevFetch(() => 0.1));
    const lines = decisionLogLines(output, 60);
    expect(lines).toEqual([
      'decisions (1/2): t1:Read:drop_call/call=0.10/result=0.10',
      'decisions (2/2): t2:Bash:drop_call/call=0.10/result=0.10',
    ]);
    expect(lines.every((line) => line.length <= 60)).toBe(true);
    expect(decisionLogLines({ ...output, decisions: [] })).toEqual(['decisions: (none)']);
  });

  it('throws on a missing key and on failed requests so the hook falls back', async () => {
    const config = resolveHookConfig({ preserveRecentMessages: 1 });
    await expect(compactSession(transcript(), config, jevFetch(() => 0))).rejects.toThrow(/TYPESAFE_API_KEY/);
    await expect(
      compactSession(transcript(), { ...config, apiKey: 'k' }, async () => ({ status: 500, ok: false, text: 'x' })),
    ).rejects.toThrow(/500/);
  });
});

describe('register without a TypeSafe key', () => {
  type Handler = ($: unknown, event: unknown, next: (e: unknown) => Promise<unknown>) => Promise<unknown>;

  function registered() {
    const handlers: Record<string, Handler> = {};
    const on = (name: string, handler: Handler) => {
      handlers[name] = handler;
    };
    (register as unknown as (on: unknown, options: unknown) => void)(on, {});
    const calls: string[] = [];
    const $ = {
      env: { get: async () => undefined },
      settings: { read: async () => ({}) },
      http: { fetch: async () => (calls.push('fetch'), { status: 200, ok: true, text: '{}' }) },
      session: {
        usage: async () => (calls.push('usage'), { context: { percent: 99 } }),
        compact: async () => calls.push('compact'),
      },
      ui: { log: () => calls.push('log'), toast: () => calls.push('toast') },
    };
    return { handlers, $, calls };
  }

  it('passes session.compact to the built-in compactor silently', async () => {
    const { handlers, $, calls } = registered();
    const event = { messages: [] };
    const result = await handlers['session.compact']!($, event, async (e) => ({ passed: e }));
    expect(result).toEqual({ passed: event });
    expect(calls).toEqual([]);
  });

  it('does not reload plugins at session.start', async () => {
    const { handlers, $, calls } = registered();
    const commands: unknown[] = [];
    const withCommand = { ...$, command: { run: async (c: unknown) => commands.push(c) } };
    await handlers['session.start']!(withCommand, {}, async () => ({ cwd: '/' }));
    expect(commands).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('never requests an early compaction on turn.complete', async () => {
    const { handlers, $, calls } = registered();
    const event = { agentId: undefined };
    const result = await handlers['turn.complete']!($, event, async (e) => ({ passed: e }));
    expect(result).toEqual({ passed: event });
    expect(calls).toEqual([]);
  });
});

describe('register with a TypeSafe key', () => {
  it('reloads plugins once per load so the managed tier takes hold', async () => {
    type Handler = ($: unknown, event: unknown, next: (e: unknown) => Promise<unknown>) => Promise<unknown>;
    const handlers: Record<string, Handler> = {};
    (register as unknown as (on: unknown, options: unknown) => void)(
      (name: string, handler: Handler) => (handlers[name] = handler),
      { apiKey: 'k' },
    );
    const commands: unknown[] = [];
    const $ = { command: { run: async (c: unknown) => commands.push(c) }, ui: { log: () => {} } };
    const next = async () => ({ cwd: '/' });
    expect(await handlers['session.start']!($, {}, next)).toEqual({ cwd: '/' });
    await handlers['session.start']!($, {}, next);
    expect(commands).toEqual([{ command: 'reload-plugins' }]);
  });
});
