import { describe, expect, it } from 'vitest';
import { createEngineOpponent, type Opponent } from '../../src/ai/opponent.js';
import { findMove, setupPosition } from '../../src/game/rules.js';
import { GameStore, MAX_LISTENERS_PER_GAME, type Game } from '../../src/server/games.js';

const engine = createEngineOpponent(() => 0);
const store = () => new GameStore({ engine, claude: engine });
const twoPlayers = (s: GameStore) => s.create({ opponent: null, level: 'medium', humanColor: 'white' });

/** Pane mängule seis (testid). */
const setPosition = (game: Game, opts: Parameters<typeof setupPosition>[0]) => {
  game.position = setupPosition(opts);
  game.positions = [game.position];
};

describe('alistumine', () => {
  it('lõpetab mängu ja vastane võidab', () => {
    const s = store();
    const game = twoPlayers(s);
    expect(s.resign(game, 'white')).toBe(true);
    expect(s.result(game)).toEqual({ status: 'win', winner: 'black', reason: 'resign' });
    expect(s.canHumanMove(game)).toBe(false);
    expect(s.resign(game, 'black')).toBe(false);
    expect(s.undo(game)).toBe(0);
  });

  it('arvuti vastu tegutseb alati inimene', () => {
    const s = store();
    const game = s.create({ opponent: 'engine', level: 'medium', humanColor: 'black' });
    expect(s.actor(game, 'white')).toBe('black');
    expect(s.actor(twoPlayers(s))).toBe('white');
    expect(s.actor(twoPlayers(s), 'black')).toBe('black');
  });

  it('peatab kella ja jätab alles järelejäänud aja', () => {
    let t = 0;
    const s = new GameStore({ engine, claude: engine }, undefined, { now: () => new Date(t) });
    const game = s.create({ opponent: null, level: 'medium', humanColor: 'white', clockMs: 60_000 });
    s.play(game, findMove(game.position, 'c3-d4')!);
    t += 10_000;
    s.resign(game, 'black');
    t += 100_000;
    expect(s.remaining(game, 'black')).toBe(50_000);
    expect(s.result(game)).toMatchObject({ reason: 'resign', winner: 'white' });
  });

  it('salvestatakse kirjesse ja taastatakse', () => {
    const s = store();
    const game = twoPlayers(s);
    s.play(game, findMove(game.position, 'c3-d4')!);
    s.resign(game, 'black');
    const record = s.toRecord(game);
    expect(record.ending).toEqual({ kind: 'resign', by: 'black' });
    expect(record.endedAt).toBeDefined();
    const restored = store().restore(record);
    expect(store().result(restored)).toEqual({ status: 'win', winner: 'white', reason: 'resign' });
  });
});

describe('viigipakkumine', () => {
  it('kahe inimese mängus jääb pakkumine ootele ja teine pool saab nõustuda', () => {
    const s = store();
    const game = twoPlayers(s);
    expect(s.offerDraw(game, 'white')).toBe('pending');
    expect(game.drawOffer).toBe('white');
    // Pakkuja ise ei saa oma pakkumist "vastu võtta".
    expect(s.offerDraw(game, 'white')).toBe('pending');
    expect(s.offerDraw(game, 'black')).toBe('accepted');
    expect(s.result(game)).toEqual({ status: 'draw', reason: 'agreement' });
    expect(s.offerDraw(game, 'black')).toBe('over');
    expect(s.toRecord(game).ending).toEqual({ kind: 'agreement' });
  });

  it('pakkumise saab tagasi lükata ja käik tühistab selle', () => {
    const s = store();
    const game = twoPlayers(s);
    expect(s.declineDraw(game, 'black')).toBe(false);
    s.offerDraw(game, 'white');
    expect(s.declineDraw(game, 'white')).toBe(false);
    expect(s.declineDraw(game, 'black')).toBe(true);
    expect(game.drawOffer).toBeNull();
    s.offerDraw(game, 'white');
    s.play(game, findMove(game.position, 'c3-d4')!);
    expect(game.drawOffer).toBeNull();
  });

  it('AI nõustub ainult siis, kui seis pole tema jaoks parem', () => {
    const s = store();
    const even = s.create({ opponent: 'engine', level: 'medium', humanColor: 'white' });
    expect(s.offerDraw(even, 'white')).toBe('accepted');

    const winning = s.create({ opponent: 'engine', level: 'medium', humanColor: 'white' });
    // Mustal (AI) on kaks tammi rohkem.
    setPosition(winning, { white: ['a1'], blackKings: ['h8', 'f8', 'd8'] });
    expect(s.offerDraw(winning, 'white')).toBe('declined');
    expect(s.result(winning).status).toBe('ongoing');

    const losing = s.create({ opponent: 'engine', level: 'medium', humanColor: 'white' });
    setPosition(losing, { whiteKings: ['a1', 'c1', 'e1'], black: ['h8'] });
    expect(s.offerDraw(losing, 'white')).toBe('accepted');
  });

  it('agreeDraw ei muuda lõppenud mängu', () => {
    const s = store();
    const game = twoPlayers(s);
    s.resign(game, 'white');
    expect(s.agreeDraw(game)).toBe(false);
    expect(s.result(game).status).toBe('win');
  });
});

describe('kordus mängus', () => {
  it('kolmas kordus lõpetab mängu viigiga', () => {
    const s = store();
    const game = twoPlayers(s);
    setPosition(game, { whiteKings: ['a3'], white: ['c1'], blackKings: ['h6'], black: ['f8'] });
    const shuffle = ['a3-b4', 'h6-g5', 'b4-a3', 'g5-h6'];
    for (const m of [...shuffle, ...shuffle]) s.play(game, findMove(game.position, m)!);
    expect(s.result(game)).toEqual({ status: 'draw', reason: 'repetition' });
    expect(s.canHumanMove(game)).toBe(false);
  });
});

describe('muutuste kuulamine', () => {
  it('teatab käikudest, AI mõtlemisest ja lõpust', async () => {
    const s = store();
    const game = s.create({ opponent: 'engine', level: 'beginner', humanColor: 'white' });
    const seen: string[] = [];
    const stop = s.subscribe(game.id, (g) => seen.push(`${g.history.length}:${g.aiThinking}`))!;
    s.play(game, findMove(game.position, 'c3-d4')!);
    await s.aiTurn(game);
    s.resign(game, 'white');
    expect(seen).toEqual(['1:false', '1:true', '2:false', '2:false']);
    stop();
    s.undo(game);
    expect(seen).toHaveLength(4);
  });

  it('teatab ka siis, kui AI ei suutnud käia', async () => {
    const failing: Opponent = { kind: 'claude', chooseMove: async () => null };
    const s = new GameStore({ engine, claude: failing });
    const game = s.create({ opponent: 'claude', level: 'medium', humanColor: 'black' });
    const thinking: boolean[] = [];
    s.subscribe(game.id, (g) => thinking.push(g.aiThinking));
    await s.aiTurn(game);
    expect(thinking).toEqual([true, false]);
  });

  it('kuulaja viga ei katkesta mängu ja kuulajate arv on piiratud', () => {
    const errors: unknown[] = [];
    const s = new GameStore({ engine, claude: engine }, (e) => errors.push(e));
    const game = twoPlayers(s);
    s.subscribe(game.id, () => {
      throw new Error('katki');
    });
    s.play(game, findMove(game.position, 'c3-d4')!);
    expect(errors).toHaveLength(1);
    expect(game.history).toEqual(['c3-d4']);
    for (let i = 1; i < MAX_LISTENERS_PER_GAME; i++) expect(s.subscribe(game.id, () => {})).not.toBeNull();
    expect(s.subscribe(game.id, () => {})).toBeNull();
  });
});
