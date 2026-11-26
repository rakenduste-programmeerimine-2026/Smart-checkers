/**
 * Mängude haldus: ühine koht REST API ja füüsilise laua jaoks.
 *
 * Iga mäng hoiab kõiki seise algusest peale, et käiku saaks tagasi võtta ja laud
 * saaks järele jõuda käikudele, mis tehti mujal (AI või äpp). Kui salvestuskoht on
 * antud, kirjutatakse mäng pärast iga muudatust kettale ja seda saab hiljem jätkata
 * või uuesti läbi mängida.
 */
import { randomUUID } from 'node:crypto';
import { applyMove, findMove, formatMove, gameResult, initialPosition } from '../game/rules.js';
import { opponent as other, type Color, type GameResult, type Move, type Position } from '../game/types.js';
import type { AiLevel } from '../ai/engine.js';
import type { Opponent, OpponentKind, OpponentMove } from '../ai/opponent.js';
import type { GameRecord } from '../record/game.js';
import { gameFromPdn } from '../record/pdn.js';
import type { GameStore as RecordStore, GameSummary } from '../record/store.js';

export interface Game {
  id: string;
  /** Kes mängib arvuti vastu: null = kaks inimest laual. */
  opponent: OpponentKind | null;
  level: AiLevel;
  humanColor: Color;
  position: Position;
  /** Käigud tekstina, näiteks "c3-d4". */
  history: string[];
  moves: Move[];
  /** Iga käigu aeg (ISO). */
  moveTimes: string[];
  /** positions[i] on seis enne käiku i; viimane on praegune seis. */
  positions: Position[];
  createdAt: string;
  /** AI arvutab praegu käiku. */
  aiThinking: boolean;
  lastAiMove: OpponentMove | null;
  /** Male kell: kummagi järelejäänud aeg millisekundites. null = kellata mäng. */
  clock: GameClock | null;
}

export interface GameClock {
  /** Algaeg millisekundites. */
  initialMs: number;
  white: number;
  black: number;
  /** Millal käigul oleva poole kell käima läks (ms). null = kell seisab (enne esimest käiku). */
  runningSince: number | null;
  /** Kelle kell sai otsa. */
  flagged: Color | null;
}

export interface NewGameOptions {
  opponent: OpponentKind | null;
  level: AiLevel;
  humanColor: Color;
  /** Male kella algaeg millisekundites (kummalegi poolele). */
  clockMs?: number | null;
}

export const MAX_CLOCK_MS = 3 * 60 * 60 * 1000;

export interface GameStoreOptions {
  /** Kuhu mängud salvestada. Ilma selleta on mängud ainult mälus. */
  records?: RecordStore;
  /** Mitu mängu korraga mälus hoida (vanemad lõppenud mängud jäävad ainult kettale). */
  maxGames?: number;
  now?: () => Date;
}

export const DEFAULT_MAX_GAMES = 500;

function newClock(ms: number | null | undefined): GameClock | null {
  if (!ms || ms <= 0) return null;
  const initialMs = Math.min(ms, MAX_CLOCK_MS);
  return { initialMs, white: initialMs, black: initialMs, runningSince: null, flagged: null };
}

const PLAYER_NAME: Record<OpponentKind, string> = { claude: 'Claude AI', engine: 'Arvuti' };

export class GameStore {
  private readonly games = new Map<string, Game>();
  private readonly saving = new Map<string, Promise<void>>();
  private readonly loading = new Map<string, Promise<Game | undefined>>();
  private readonly records: RecordStore | undefined;
  private readonly maxGames: number;
  private readonly now: () => Date;

  constructor(
    private readonly opponents: Record<OpponentKind, Opponent>,
    private readonly onError: (error: unknown) => void = () => {},
    options: GameStoreOptions = {},
  ) {
    this.records = options.records;
    this.maxGames = options.maxGames ?? DEFAULT_MAX_GAMES;
    this.now = options.now ?? (() => new Date());
  }

  create(options: NewGameOptions, id: string = randomUUID()): Game {
    const position = initialPosition();
    const { clockMs, ...settings } = options;
    const game: Game = {
      id,
      ...settings,
      clock: newClock(clockMs),
      position,
      history: [],
      moves: [],
      moveTimes: [],
      positions: [position],
      createdAt: this.now().toISOString(),
      aiThinking: false,
      lastAiMove: null,
    };
    this.remember(game);
    this.persist(game);
    return game;
  }

  /** Mäng mälust. Kettal olevate mängude jaoks vt `load`. */
  get(id: string): Game | undefined {
    return this.games.get(id);
  }

  /** Mäng mälust või kettalt. Samaaegsed päringud saavad sama mänguobjekti. */
  async load(id: string): Promise<Game | undefined> {
    const cached = this.games.get(id);
    if (cached || !this.records || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return cached;
    const pending = this.loading.get(id);
    if (pending) return pending;
    const records = this.records;
    const task = (async () => {
      // Mälust eemaldatud mängu salvestus võib veel pooleli olla.
      await this.saving.get(id);
      const record = await records.load(id);
      return record ? this.restore(record) : undefined;
    })().finally(() => this.loading.delete(id));
    this.loading.set(id, task);
    return task;
  }

  /** Taastab mängu kirjest, mängides käigud uuesti läbi. */
  restore(record: GameRecord): Game {
    const settings = record.settings ?? { opponent: null, level: 'medium', humanColor: 'white' };
    const position = initialPosition();
    const game: Game = {
      id: record.id,
      opponent: settings.opponent,
      level: settings.level,
      humanColor: settings.humanColor,
      position,
      history: [],
      moves: [],
      moveTimes: [],
      positions: [position],
      createdAt: record.meta.startedAt,
      aiThinking: false,
      lastAiMove: null,
      clock: newClock(settings.clockMs),
    };
    for (const { text, at } of record.moves) {
      const move = findMove(game.position, text);
      if (!move) throw new Error(`Salvestatud mängus ${record.id} on vigane käik ${text}`);
      this.apply(game, move, at);
    }
    if (game.clock && record.flagged) {
      game.clock.flagged = record.flagged;
      game.clock[record.flagged] = 0;
      game.clock.runningSince = null;
    }
    this.remember(game);
    return game;
  }

  /** Impordib PDN-teksti kahe inimese mänguks. Viskab vea, kui mõni käik pole seaduslik. */
  importPdn(text: string): Game {
    const parsed = gameFromPdn(text).toRecord();
    const game = this.restore({
      ...parsed,
      id: randomUUID(),
      settings: { opponent: null, level: 'medium', humanColor: 'white' },
    });
    this.persist(game);
    return game;
  }

  /** Mängude nimekiri (mälus ja kettal), uuemad eespool. */
  async list(limit = 50): Promise<GameSummary[]> {
    const byId = new Map<string, GameSummary>();
    for (const summary of (await this.records?.list()) ?? []) byId.set(summary.id, summary);
    for (const game of this.games.values()) {
      const record = this.toRecord(game);
      const summary: GameSummary = { id: game.id, meta: record.meta, moveCount: game.history.length, result: record.result };
      if (record.endedAt) summary.endedAt = record.endedAt;
      byId.set(game.id, summary);
    }
    return [...byId.values()].sort((a, b) => b.meta.startedAt.localeCompare(a.meta.startedAt)).slice(0, limit);
  }

  async delete(id: string): Promise<boolean> {
    const inMemory = this.games.delete(id);
    await this.saving.get(id);
    const onDisk = this.records && /^[A-Za-z0-9_-]{1,64}$/.test(id) ? await this.records.delete(id) : false;
    return inMemory || onDisk;
  }

  /** Ootab, kuni kõik salvestused on kettal (testid ja sulgemine). */
  async flush(): Promise<void> {
    await Promise.all(this.saving.values());
  }

  result(game: Game): GameResult {
    const clock = game.clock;
    if (clock) {
      if (!clock.flagged && gameResult(game.position).status === 'ongoing' && this.remaining(game, game.position.turn) <= 0) {
        // Käigul oleva poole aeg sai otsa.
        clock.flagged = game.position.turn;
        clock[game.position.turn] = 0;
        clock.runningSince = null;
        this.persist(game);
      }
      if (clock.flagged) return { status: 'win', winner: other(clock.flagged), reason: 'time' };
    }
    return gameResult(game.position);
  }

  /** Poole järelejäänud aeg millisekundites (käigul oleva poole kell käib). */
  remaining(game: Game, color: Color): number {
    const clock = game.clock;
    if (!clock) return Infinity;
    const running = clock.runningSince !== null && game.position.turn === color && !clock.flagged;
    const spent = running ? this.now().getTime() - clock.runningSince! : 0;
    return Math.max(0, clock[color] - spent);
  }

  isOver(game: Game): boolean {
    return this.result(game).status !== 'ongoing';
  }

  isAiTurn(game: Game): boolean {
    return game.opponent !== null && game.position.turn !== game.humanColor && !this.isOver(game);
  }

  /** Kas inimene võib praegu käia (laual või äpis). */
  canHumanMove(game: Game): boolean {
    return !this.isOver(game) && !game.aiThinking && !this.isAiTurn(game);
  }

  /** Teeb käigu. Seaduslikkust kontrollib kutsuja (findMove või detectMove). */
  play(game: Game, move: Move): void {
    this.apply(game, move, this.now().toISOString());
    this.persist(game);
  }

  /** Kui on AI kord, laseb AI-l käia. Samaaegselt arvutab ühe mängu jaoks ainult üks AI. */
  async aiTurn(game: Game): Promise<OpponentMove | null> {
    if (!game.opponent || game.aiThinking || !this.isAiTurn(game)) return null;
    game.aiThinking = true;
    const plyBefore = game.history.length;
    try {
      const choice = await this.opponents[game.opponent].chooseMove(game.position, game.level);
      // Kui vahepeal võeti käik tagasi või alustati uut, siis vastust ei kasutata.
      if (!choice || game.history.length !== plyBefore) return null;
      this.play(game, choice.move);
      game.lastAiMove = choice;
      return choice;
    } finally {
      game.aiThinking = false;
    }
  }

  /** Käivitab AI taustal (laua jaoks, mis ei saa vastust oodata). */
  startAiTurn(game: Game): void {
    if (!this.isAiTurn(game) || game.aiThinking) return;
    this.aiTurn(game).catch((error: unknown) => this.onError(error));
  }

  /**
   * Võtab tagasi inimese viimase käigu ja AI vastuse sellele.
   * Kahe inimese mängus võetakse tagasi üks käik. Tagastab tagasi võetud käikude arvu.
   */
  undo(game: Game): number {
    if (game.aiThinking) return 0;
    const isHumanPly = (i: number) => !game.opponent || game.positions[i]?.turn === game.humanColor;
    let last = -1;
    for (let i = game.moves.length - 1; i >= 0; i--) {
      if (isHumanPly(i)) {
        last = i;
        break;
      }
    }
    if (last < 0) return 0;
    const removed = game.moves.length - last;
    game.moves.length = last;
    game.history.length = last;
    game.moveTimes.length = last;
    game.positions.length = last + 1;
    game.position = game.positions[last]!;
    game.lastAiMove = null;
    if (game.clock) game.clock.runningSince = last === 0 ? null : this.now().getTime();
    this.persist(game);
    return removed;
  }

  toRecord(game: Game): GameRecord {
    const result = this.result(game);
    const name = (color: Color) =>
      !game.opponent || color === game.humanColor ? 'Inimene' : PLAYER_NAME[game.opponent];
    const record: GameRecord = {
      id: game.id,
      meta: { event: 'Smart-checkers', white: name('white'), black: name('black'), startedAt: game.createdAt },
      settings: {
        opponent: game.opponent,
        level: game.level,
        humanColor: game.humanColor,
        clockMs: game.clock?.initialMs ?? null,
      },
      moves: game.history.map((text, i) => ({ text, at: game.moveTimes[i] ?? game.createdAt })),
      result,
    };
    const lastTime = game.moveTimes[game.moveTimes.length - 1];
    if (result.status !== 'ongoing' && lastTime) record.endedAt = lastTime;
    if (game.clock?.flagged) record.flagged = game.clock.flagged;
    return record;
  }

  // --- sisemine ---

  private apply(game: Game, move: Move, at: string): void {
    const clock = game.clock;
    if (clock) {
      const atMs = Date.parse(at);
      // Esimene käik käivitab kella; edasi läheb käija aeg maha.
      if (clock.runningSince !== null) {
        const mover = game.position.turn;
        clock[mover] = Math.max(0, clock[mover] - Math.max(0, atMs - clock.runningSince));
      }
      clock.runningSince = atMs;
    }
    game.position = applyMove(game.position, move);
    game.moves.push(move);
    game.history.push(formatMove(move));
    game.moveTimes.push(at);
    game.positions.push(game.position);
  }

  private remember(game: Game): void {
    this.games.set(game.id, game);
    if (this.games.size <= this.maxGames) return;
    // Mälust eemaldatakse vanim lõppenud mäng, selle puudumisel vanim üldse.
    const candidates = [...this.games.values()].filter((g) => g.id !== game.id && !g.aiThinking);
    const victim = candidates.find((g) => this.isOver(g)) ?? candidates[0];
    if (victim) this.games.delete(victim.id);
  }

  /** Salvestab mängu kettale; ühe mängu salvestused tehakse järjest. */
  private persist(game: Game): void {
    const records = this.records;
    if (!records) return;
    const record = this.toRecord(game);
    const previous = this.saving.get(game.id) ?? Promise.resolve();
    const next = previous
      .then(() => records.save(record))
      .catch((error: unknown) => this.onError(error));
    this.saving.set(game.id, next);
    void next.then(() => {
      if (this.saving.get(game.id) === next) this.saving.delete(game.id);
    });
  }
}
