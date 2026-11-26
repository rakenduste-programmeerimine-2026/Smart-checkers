import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';
import { buildPrompt, createClaudeOpponent, renderBoard } from '../../src/ai/claude.js';
import type { Opponent } from '../../src/ai/opponent.js';
import { formatMove, initialPosition, legalMoves, setupPosition } from '../../src/game/rules.js';

/** Võltsklient: tagastab etteantud vastuse või viskab vea. */
function fakeClient(impl: (params: Record<string, unknown>) => unknown) {
  const parse = vi.fn(async (params: Record<string, unknown>) => impl(params));
  const client = { beta: { messages: { parse } } } as unknown as Anthropic;
  return { client, parse };
}

const fallback: Opponent = {
  kind: 'engine',
  chooseMove: vi.fn(async (pos) => {
    const move = legalMoves(pos)[0]!;
    return { move, notation: 'fallback', source: 'engine' as const };
  }),
};

describe('renderBoard ja buildPrompt', () => {
  it('joonistab algseisu, valge all ja must üleval', () => {
    const rows = renderBoard(initialPosition()).split('\n');
    expect(rows[0]).toBe('8   b   b   b   b');
    expect(rows[4]).toBe('4   .   .   .   .');
    expect(rows[7]!.replace(/ /g, '')).toBe('1wwww');
    expect(rows[0]!.replace(/ /g, '')).toBe('8bbbb');
    expect(rows[8]).toBe('  a b c d e f g h');
  });

  it('nummerdab kõik seaduslikud käigud', () => {
    const pos = initialPosition();
    const moves = legalMoves(pos);
    const prompt = buildPrompt(pos, moves, 'medium');
    moves.forEach((m, i) => expect(prompt).toContain(`${i}: ${formatMove(m)}`));
    expect(prompt).toContain('valged');
  });

  it('tugeval tasemel lisab mootori hinnangud', () => {
    const pos = initialPosition();
    expect(buildPrompt(pos, legalMoves(pos), 'strong')).toContain('mootori hinnang');
  });
});

describe('createClaudeOpponent', () => {
  it('kasutab AI valitud käiku ja põhjendust', async () => {
    const { client, parse } = fakeClient(() => ({
      stop_reason: 'end_turn',
      parsed_output: { moveIndex: 2, reason: 'Keskele.' },
    }));
    const ai = createClaudeOpponent({ client, fallback });
    const result = await ai.chooseMove(initialPosition(), 'medium');
    const expected = formatMove(legalMoves(initialPosition())[2]!);
    expect(result).toMatchObject({ notation: expected, source: 'claude', reason: 'Keskele.' });
    const params = parse.mock.calls[0]![0];
    expect(params.model).toBe('claude-opus-5-5');
    expect(params.fallbacks).toBe('default');
  });

  it('ei küsi API-lt, kui käike on ainult üks', async () => {
    const { client, parse } = fakeClient(() => {
      throw new Error('ei tohiks kutsuda');
    });
    const ai = createClaudeOpponent({ client, fallback });
    const result = await ai.chooseMove(setupPosition({ white: ['c3', 'g3'], black: ['d4'] }), 'medium');
    expect(result?.notation).toBe('c3:e5');
    expect(parse).not.toHaveBeenCalled();
  });

  it('tagastab null, kui käike pole', async () => {
    const { client } = fakeClient(() => ({}));
    const ai = createClaudeOpponent({ client, fallback });
    expect(await ai.chooseMove(setupPosition({ white: ['a1'], black: ['b2', 'c3'] }), 'medium')).toBeNull();
  });

  it('kasutab varumootorit, kui AI valib olematu käigu', async () => {
    const { client } = fakeClient(() => ({ stop_reason: 'end_turn', parsed_output: { moveIndex: 99, reason: 'x' } }));
    const result = await createClaudeOpponent({ client, fallback }).chooseMove(initialPosition(), 'medium');
    expect(result).toMatchObject({ source: 'engine', fallbackReason: 'AI valis olematu käigu 99' });
  });

  it('kasutab varumootorit, kui AI keeldub', async () => {
    const { client } = fakeClient(() => ({ stop_reason: 'refusal', parsed_output: null }));
    const result = await createClaudeOpponent({ client, fallback }).chooseMove(initialPosition(), 'medium');
    expect(result).toMatchObject({ source: 'engine', fallbackReason: 'AI keeldus vastamast' });
  });

  it('kasutab varumootorit, kui API-ga ei saa ühendust', async () => {
    const onError = vi.fn();
    const { client } = fakeClient(() => {
      throw new Anthropic.APIConnectionError({ message: 'võrk maas' });
    });
    const result = await createClaudeOpponent({ client, fallback, onError }).chooseMove(initialPosition(), 'medium');
    expect(result?.source).toBe('engine');
    expect(result?.fallbackReason).toMatch(/AI API/);
    expect(onError).toHaveBeenCalledOnce();
  });

  it('kasutab vaikimisi varuna päris mootorit', async () => {
    const { client } = fakeClient(() => {
      throw new Error('mis iganes');
    });
    const result = await createClaudeOpponent({ client }).chooseMove(initialPosition(), 'beginner');
    expect(result?.source).toBe('engine');
    expect(legalMoves(initialPosition()).map((m) => m.from)).toContain(result!.move.from);
  });

  it('kasutab varumootorit, kui liiga palju Claude päringuid käib korraga', async () => {
    let release: (v: unknown) => void = () => {};
    const { client } = fakeClient(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ stop_reason: 'end_turn', parsed_output: { moveIndex: 0, reason: 'x' } });
        }),
    );
    const ai = createClaudeOpponent({ client, fallback, maxConcurrent: 1 });
    const first = ai.chooseMove(initialPosition(), 'medium');
    const second = await ai.chooseMove(initialPosition(), 'medium');
    expect(second).toMatchObject({ source: 'engine', fallbackReason: 'AI on hõivatud' });
    release(null);
    expect((await first)?.source).toBe('claude');
    // Pärast vastust on koht jälle vaba.
    const third = ai.chooseMove(initialPosition(), 'medium');
    release(null);
    expect((await third)?.source).toBe('claude');
  });
});

