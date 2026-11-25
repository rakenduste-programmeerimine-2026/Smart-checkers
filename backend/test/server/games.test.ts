import { describe, expect, it } from 'vitest';
import { createEngineOpponent } from '../../src/ai/opponent.js';
import { findMove } from '../../src/game/rules.js';
import { GameStore } from '../../src/server/games.js';

const engine = createEngineOpponent(() => 0);
const store = () => new GameStore({ engine, claude: engine });

describe('GameStore', () => {
  it('hoiab kõiki seise ja võtab kahe mängija mängus ühe käigu tagasi', () => {
    const s = store();
    const game = s.create({ opponent: null, level: 'medium', humanColor: 'white' });
    for (const m of ['c3-d4', 'f6-e5']) s.play(game, findMove(game.position, m)!);
    expect(game.positions).toHaveLength(3);
    expect(s.undo(game)).toBe(1);
    expect(game.history).toEqual(['c3-d4']);
    expect(game.position).toBe(game.positions[1]);
  });

  it('AI vastu võtab tagasi inimese käigu koos AI vastusega', async () => {
    const s = store();
    const game = s.create({ opponent: 'engine', level: 'beginner', humanColor: 'white' });
    s.play(game, findMove(game.position, 'c3-d4')!);
    await s.aiTurn(game);
    expect(game.history).toHaveLength(2);
    expect(s.undo(game)).toBe(2);
    expect(game.history).toEqual([]);
    expect(s.undo(game)).toBe(0);
  });

  it('ei võta tagasi AI esimest käiku, kui inimene on must', async () => {
    const s = store();
    const game = s.create({ opponent: 'engine', level: 'beginner', humanColor: 'black' });
    await s.aiTurn(game);
    expect(s.undo(game)).toBe(0);
    expect(game.history).toHaveLength(1);
  });
});
