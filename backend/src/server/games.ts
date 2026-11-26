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
import { evaluate, type AiLevel } from '../ai/engine.js';
import { reviewGame, type GameReview } from '../analysis/review.js';
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
  /** Mitu korda on käike tagasi võetud (laud saab nii teada, et seis muutus). */
  undoCount: number;
  /** Male kell: kummagi järelejäänud aeg millisekundites. null = kellata mäng. */
  clock: GameClock | null;
  /** Mäng lõppes alistumise või viigikokkuleppega. */
  ending: GameEnding | null;
  /** Kes pakkus viiki (kehtib kuni järgmise käiguni). */
  drawOffer: Color | null;
  /** Edetabeli mängijad (id) värvi järgi. */
  players: GamePlayers;
  /** Lõpptulemus on edetabelisse kantud (mängu ei saa enam tagasi võtta). */
  rated: boolean;
}

export interface GamePlayers {
  white: string | null;
  black: string | null;
}

export type GameEnding = { kind: 'resign'; by: Color } | { kind: 'agreement' };

/** AI nõustub viigiga, kui seis on tema jaoks umbes võrdne või halvem. */
export const AI_DRAW_ACCEPT_SCORE = 50;

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
  players?: Partial<GamePlayers>;
}

export const MAX_CLOCK_MS = 3 * 60 * 60 * 1000;

export interface GameStoreOptions {
  /** Kuhu mängud salvestada. Ilma selleta on mängud ainult mälus. */
  records?: RecordStore;
  /** Mitu mängu korraga mälus hoida (vanemad lõppenud mängud jäävad ainult kettale). */
  maxGames?: number;
  now?: () => Date;
  /** Kutsutakse üks kord, kui mäng lõpeb (edetabel). */
  onGameOver?: (game: Game, result: GameResult) => void | Promise<void>;
}

export const DEFAULT_MAX_GAMES = 500;

function newClock(ms: number | null | undefined): GameClock | null {
  if (!ms || ms <= 0) return null;
  const initialMs = Math.min(ms, MAX_CLOCK_MS);
  return { initialMs, white: initialMs, black: initialMs, runningSince: null, flagged: null };
}

const PLAYER_NAME: Record<OpponentKind, string> = { claude: 'Claude AI', engine: 'Arvuti' };

export type GameListener = (game: Game) => void;

const reviewVersion = (game: Game) => `${game.history.length}:${game.undoCount}`;

/** Ühe mängu kohta lubatud korraga jälgijaid (SSE ühendused). */
export const MAX_LISTENERS_PER_GAME = 20;

export class GameStore {
  private readonly games = new Map<string, Game>();
  private readonly listeners = new Map<string, Set<GameListener>>();
  /** Mänguülevaated: võti on mängu id, `version` näitab, millise seisu kohta. */
  private readonly reviews = new Map<string, { version: string; review: Promise<GameReview>; done?: GameReview }>();
  private readonly saving = new Map<string, Promise<void>>();
  private readonly loading = new Map<string, Promise<Game | undefined>>();
  private readonly records: RecordStore | undefined;
  private readonly maxGames: number;
  private readonly now: () => Date;
  private readonly onGameOver: GameStoreOptions['onGameOver'];

  constructor(
    private readonly opponents: Record<OpponentKind, Opponent>,
    private readonly onError: (error: unknown) => void = () => {},
    options: GameStoreOptions = {},
  ) {
    this.records = options.records;
    this.maxGames = options.maxGames ?? DEFAULT_MAX_GAMES;
    this.now = options.now ?? (() => new Date());
    this.onGameOver = options.onGameOver;
  }

  create(options: NewGameOptions, id: string = randomUUID()): Game {
    const position = initialPosition();
    const { clockMs, players, ...settings } = options;
    const game: Game = {
      id,
      ...settings,
      players: { white: players?.white ?? null, black: players?.black ?? null },
      rated: false,
      clock: newClock(clockMs),
      position,
      history: [],
      moves: [],
      moveTimes: [],
      positions: [position],
      createdAt: this.now().toISOString(),
      aiThinking: false,
      lastAiMove: null,
      undoCount: 0,
      ending: null,
      drawOffer: null,
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
      undoCount: 0,
      clock: newClock(settings.clockMs),
      ending: null,
      drawOffer: null,
      players: { white: settings.players?.white ?? null, black: settings.players?.black ?? null },
      rated: record.rated ?? false,
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
    if (record.ending) game.ending = record.ending;
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
    this.reviews.delete(id);
    await this.saving.get(id);
    const onDisk = this.records && /^[A-Za-z0-9_-]{1,64}$/.test(id) ? await this.records.delete(id) : false;
    return inMemory || onDisk;
  }

  /** Ootab, kuni kõik salvestused on kettal (testid ja sulgemine). */
  async flush(): Promise<void> {
    await Promise.all(this.saving.values());
  }

  result(game: Game): GameResult {
    const ending = game.ending;
    if (ending?.kind === 'resign') return { status: 'win', winner: other(ending.by), reason: 'resign' };
    if (ending?.kind === 'agreement') return { status: 'draw', reason: 'agreement' };
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
    return gameResult(game.position, game.positions);
  }

  /**
   * Värv, kelle nimel äpp või laud tegutseb: arvuti vastu alati inimene,
   * kahe inimese mängus käigul olev pool (kui pole öeldud teisiti).
   */
  actor(game: Game, color?: Color): Color {
    if (game.opponent) return game.humanColor;
    return color ?? game.position.turn;
  }

  /** Alistumine. Tagastab false, kui mäng on juba läbi. */
  resign(game: Game, color: Color): boolean {
    if (this.isOver(game)) return false;
    this.stopClock(game);
    game.ending = { kind: 'resign', by: color };
    game.drawOffer = null;
    this.persist(game);
    return true;
  }

  /**
   * Viigipakkumine. Arvuti vastu otsustab AI kohe (nõustub, kui seis pole tema
   * jaoks selgelt parem); kahe inimese mängus jääb pakkumine teisele poolele
   * vastu võtta kuni järgmise käiguni. Kui vastane oli juba viiki pakkunud,
   * tähendab pakkumine nõustumist.
   */
  offerDraw(game: Game, color: Color): 'accepted' | 'declined' | 'pending' | 'over' {
    if (this.isOver(game)) return 'over';
    if (game.opponent) {
      const aiColor = other(game.humanColor);
      const score = aiColor === 'white' ? evaluate(game.position) : -evaluate(game.position);
      if (game.aiThinking || score > AI_DRAW_ACCEPT_SCORE) return 'declined';
      this.agreeDraw(game);
      return 'accepted';
    }
    if (game.drawOffer === other(color)) {
      this.agreeDraw(game);
      return 'accepted';
    }
    game.drawOffer = color;
    this.persist(game);
    return 'pending';
  }

  /** Lükkab vastase viigipakkumise tagasi. Tagastab false, kui pakkumist polnud. */
  declineDraw(game: Game, color: Color): boolean {
    if (game.drawOffer !== other(color)) return false;
    game.drawOffer = null;
    this.persist(game);
    return true;
  }

  /** Viik kokkuleppel (näiteks kaks inimest laua taga). Tagastab false, kui mäng on läbi. */
  agreeDraw(game: Game): boolean {
    if (this.isOver(game)) return false;
    this.stopClock(game);
    game.ending = { kind: 'agreement' };
    game.drawOffer = null;
    this.persist(game);
    return true;
  }

  /** Peatab kella ja arvestab käigul oleva poole kulunud aja maha. */
  private stopClock(game: Game): void {
    const clock = game.clock;
    if (!clock || clock.runningSince === null) return;
    const turn = game.position.turn;
    clock[turn] = this.remaining(game, turn);
    clock.runningSince = null;
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
    this.notify(game);
    const plyBefore = game.history.length;
    let moved = false;
    try {
      const choice = await this.opponents[game.opponent].chooseMove(game.position, game.level);
      // Kui vahepeal võeti käik tagasi või alustati uut, siis vastust ei kasutata.
      if (!choice || game.history.length !== plyBefore) return null;
      game.lastAiMove = choice;
      game.aiThinking = false;
      moved = true;
      this.play(game, choice.move);
      return choice;
    } finally {
      game.aiThinking = false;
      // Kui AI ei käinud (viga või tühistatud), peavad kuulajad ikkagi teada saama.
      if (!moved) this.notify(game);
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
    if (game.aiThinking || game.ending || game.rated) return 0;
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
    game.undoCount++;
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
        players: game.players,
      },
      moves: game.history.map((text, i) => ({ text, at: game.moveTimes[i] ?? game.createdAt })),
      result,
    };
    const lastTime = game.moveTimes[game.moveTimes.length - 1];
    if (result.status !== 'ongoing' && lastTime) record.endedAt = lastTime;
    if (game.clock?.flagged) record.flagged = game.clock.flagged;
    if (game.ending) record.ending = game.ending;
    if (game.rated) record.rated = true;
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
    game.drawOffer = null;
  }

  private remember(game: Game): void {
    this.games.set(game.id, game);
    if (this.games.size <= this.maxGames) return;
    // Mälust eemaldatakse vanim lõppenud mäng, selle puudumisel vanim üldse.
    const candidates = [...this.games.values()].filter((g) => g.id !== game.id && !g.aiThinking);
    const victim = candidates.find((g) => this.isOver(g)) ?? candidates[0];
    if (victim) this.games.delete(victim.id);
  }

  /**
   * Mänguülevaade (iga käigu hinnang ja vead). Tulemus jäetakse meelde, kuni
   * mängus midagi muutub; samaaegsed päringud saavad sama arvutuse.
   */
  review(game: Game, timePerMoveMs?: number): Promise<GameReview> {
    const version = reviewVersion(game);
    const cached = this.reviews.get(game.id);
    if (cached?.version === version) return cached.review;
    const entry: { version: string; review: Promise<GameReview>; done?: GameReview } = {
      version,
      review: reviewGame(game.positions.slice(), game.moves.slice(), timePerMoveMs ? { timePerMoveMs } : {}),
    };
    entry.review.then(
      (r) => (entry.done = r),
      () => this.reviews.delete(game.id),
    );
    this.reviews.set(game.id, entry);
    return entry.review;
  }

  /** Valmis mänguülevaade, kui see on olemas ja kehtib praeguse seisu kohta. */
  cachedReview(game: Game): GameReview | null {
    const cached = this.reviews.get(game.id);
    return cached?.version === reviewVersion(game) ? (cached.done ?? null) : null;
  }

  /**
   * Kuulab mängu muutusi (käik, tagasivõtt, AI mõtlemine, lõpp).
   * Tagastab funktsiooni kuulamise lõpetamiseks või null, kui kuulajaid on liiga palju.
   */
  subscribe(id: string, listener: GameListener): (() => void) | null {
    let set = this.listeners.get(id);
    if (!set) {
      set = new Set();
      this.listeners.set(id, set);
    }
    if (set.size >= MAX_LISTENERS_PER_GAME) return null;
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0 && this.listeners.get(id) === set) this.listeners.delete(id);
    };
  }

  /** Kui mäng just lõppes, kannab tulemuse edetabelisse (üks kord). */
  private finish(game: Game): void {
    if (game.rated) return;
    const result = this.result(game);
    if (result.status === 'ongoing') return;
    // Ainult mängijatega mängud lukustatakse; muidu saab lõppenud mängu ikka tagasi võtta.
    if (!game.players.white && !game.players.black) return;
    game.rated = true;
    if (!this.onGameOver) return;
    try {
      Promise.resolve(this.onGameOver(game, result)).catch((error: unknown) => this.onError(error));
    } catch (error) {
      this.onError(error);
    }
  }

  private notify(game: Game): void {
    for (const listener of this.listeners.get(game.id) ?? []) {
      try {
        listener(game);
      } catch (error) {
        this.onError(error);
      }
    }
  }

  /** Salvestab mängu kettale; ühe mängu salvestused tehakse järjest. */
  private persist(game: Game): void {
    this.finish(game);
    this.notify(game);
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
