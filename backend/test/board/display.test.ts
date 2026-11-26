import { describe, expect, it } from 'vitest';
import { LED_COUNT, lcdLine, ledIndex, makeDisplay, mergeLeds, led } from '../../src/board/display.js';
import { parseSquare, SQUARE_COUNT } from '../../src/game/squares.js';

const sq = (name: string) => parseSquare(name)!;

describe('ledIndex', () => {
  it('vastab LED-riba paigutusele', () => {
    const expected: Record<string, number> = {
      a1: 0, c1: 4, e1: 8, g1: 12, h2: 21, f2: 25, d2: 29, b2: 33,
      a3: 42, g3: 54, h4: 63, b4: 75, a5: 84, h6: 105, b6: 117, a7: 126, g7: 138, h8: 147, b8: 159,
    };
    for (const [name, index] of Object.entries(expected)) expect(ledIndex(sq(name)), name).toBe(index);
  });

  it('annab igale ruudule erineva LED-i riba piires', () => {
    const all = Array.from({ length: SQUARE_COUNT }, (_, i) => ledIndex(i));
    expect(new Set(all).size).toBe(32);
    expect(Math.max(...all)).toBeLessThan(LED_COUNT);
  });
});

describe('lcdLine', () => {
  it('asendab täpitähed ja teeb rea 16 märgi pikkuseks', () => {
    expect(lcdLine('Löömine kohust.')).toBe('Loomine kohust. ');
    expect(lcdLine('Valge võitis! Palju õnne')).toBe('Valge voitis! Pa');
    expect(lcdLine('')).toHaveLength(16);
  });
});

describe('makeDisplay', () => {
  it('hilisem käsk samale ruudule kirjutab eelmise üle', () => {
    const merged = mergeLeds([led(sq('c3'), 'FF0000')], [led(sq('c3'), '00FF00', 'blink')]);
    expect(merged).toEqual([{ square: 'c3', led: ledIndex(sq('c3')), color: '00FF00', mode: 'blink' }]);
  });

  it('seq muutub ainult sisu muutudes', () => {
    const a = makeDisplay(['a', 'b'], []);
    expect(makeDisplay(['a', 'b'], []).seq).toBe(a.seq);
    expect(makeDisplay(['a', 'c'], []).seq).not.toBe(a.seq);
  });
});
