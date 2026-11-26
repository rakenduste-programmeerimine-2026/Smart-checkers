/**
 * Füüsilise laua kontroller.
 *
 * Laud saadab regulaarselt oma reed-lülitite maski ja nupuvajutused. Kontroller:
 * - ootab, kuni mask on hetke paigal, ja tunneb siis ära inimese käigu;
 * - näitab LED-idega AI (või äpis tehtud) käiku, mida on vaja laual järele teha;
 * - süütab tõstetud nupu võimalikud sihtruudud ja vilgutab kohustuslikku löömist;
 * - näitab valet seisu (puuduvad ja üleliigsed nupud), vihjet ja mängu lõppu;
 * - haldab kaane kolme nupuga menüüd (uus mäng, vastane, raskusaste, värv).
 *
 * Nupud: 1 = vihje, 2 = käigu tagasivõtt, 3 = menüü. Menüüs: 1 = järgmine, 2 = vali, 3 = välju.
 */
import { findMove as findMoveText, finalSquare, formatMove, legalMoves } from '../game/rules.js';
import { detectMove, occupancyMask, squaresInMask } from '../game/sensors.js';
import type { Square } from '../game/squares.js';
import type { Color, DrawReason, Move, Position, WinReason } from '../game/types.js';
import { suggestMove, type AiLevel } from '../ai/engine.js';
import type { OpponentKind } from '../ai/opponent.js';
import type { Game, GameStore } from '../server/games.js';
import { puzzleGame, type PuzzleDef, type PuzzleLibrary } from '../puzzles/library.js';
import { COLORS, led, makeDisplay, type BoardDisplay, type LedCommand } from './display.js';

export interface BoardTiming {
  /** Kui kaua peab mask paigal olema, enne kui seda käiguks loetakse. */
  settleMs: number;
  /** Kui kaua võib laud olla vales seisus, enne kui seda veaks näidatakse. */
  errorMs: number;
  /** Lühiteadete (näiteks "Tamm!") kestus. */
  messageMs: number;
  /** Vihje kestus. */
  hintMs: number;
}

export const DEFAULT_TIMING: BoardTiming = { settleMs: 300, errorMs: 2500, messageMs: 4000, hintMs: 10_000 };

export type BoardButton = 1 | 2 | 3;

export type OpponentSetting = OpponentKind | 'none';

export interface BoardSettings {
  opponent: OpponentSetting;
  level: AiLevel;
  humanColor: Color;
  /** Male kell minutites, 0 = kellata. */
  clockMinutes: number;
  /** Edetabeli mängija laua taga (arvuti vastu inimene, kahekesi valge). null = külaline. */
  playerId: string | null;
}

/** Kui kaua pärast viimast päringut loetakse laud võrgus olevaks. */
export const ONLINE_MS = 5000;

export interface BoardStatus {
  id: string;
  gameId: string | null;
  mask: string | null;
  /** Mitu mängu käiku on laual tehtud. */
  boardPly: number;
  state: 'no-game' | 'waiting-board' | 'setup' | 'pending-move' | 'ai-thinking' | 'play' | 'game-over' | 'menu' | 'replay';
  /** Korduse puhul: mitmes käik (0 = algseis). */
  replayPly?: number;
  settings: BoardSettings;
  /** Kas laud on viimase 5 sekundi jooksul ühendust võtnud. */
  online: boolean;
  lastSeenAt: string | null;
  /** Võrgumäng teise lauaga: selle laua värv ja vastase laud. */
  match: { seat: Color; peerId: string; peerOnline: boolean } | null;
}

type MenuItem = 'new' | 'opponent' | 'level' | 'color' | 'player' | 'clock' | 'puzzle' | 'replay' | 'draw' | 'resign';
const MENU_ITEMS: MenuItem[] = ['new', 'opponent', 'level', 'color', 'player', 'clock', 'puzzle', 'replay', 'draw', 'resign'];

const WIN_REASON: Record<WinReason, string> = { 'no-moves': 'B3 menüü', time: 'Aeg sai otsa', resign: 'Alistumine', puzzle: 'Ülesanne' };
const DRAW_REASON: Record<DrawReason, string> = {
  'king-moves': '15 tammikäiku',
  repetition: 'Seis kordus 3x',
  'lone-king': '3 tammi vs 1',
  agreement: 'Kokkuleppel',
};
const CLOCK_MINUTES = [0, 5, 10, 15, 30];
const OPPONENTS: OpponentSetting[] = ['claude', 'engine', 'none'];
const LEVELS: AiLevel[] = ['beginner', 'medium', 'strong'];
const OPPONENT_LABEL: Record<OpponentSetting, string> = { claude: 'Claude', engine: 'arvuti', none: 'inimene' };
const LEVEL_LABEL: Record<AiLevel, string> = { beginner: 'algaja', medium: 'keskmine', strong: 'tugev' };

const next = <T>(list: readonly T[], value: T): T => list[(list.indexOf(value) + 1) % list.length]!;
const maskHex = (mask: number) => `0x${(mask >>> 0).toString(16).padStart(8, '0')}`;

export interface BoardControllerOptions {
  timing?: Partial<BoardTiming>;
  now?: () => number;
  /** Edetabeli mängijad menüü jaoks (parim eespool). */
  players?: () => { id: string; name: string }[];
  /** Kabeülesanded menüü jaoks. */
  puzzles?: Pick<PuzzleLibrary, 'next'>;
}

export class BoardController {
  readonly settings: BoardSettings = { opponent: 'claude', level: 'medium', humanColor: 'white', clockMinutes: 0, playerId: null };
  private readonly players: () => { id: string; name: string }[];
  private readonly puzzles: Pick<PuzzleLibrary, 'next'> | undefined;
  /** Võrgumängus selle laua värv ja vastase laud. */
  private match: { seat: Color; peerId: string; peer: () => BoardController | undefined } | null = null;
  /** Viimati laual alustatud ülesanne (menüü valib järgmise). */
  private lastPuzzleId: string | null = null;
  private readonly timing: BoardTiming;
  private readonly now: () => number;

  private gameId: string | null = null;
  /** Mitu käiku mängu ajaloost on laual tehtud. */
  private boardPly = 0;
  /** Mängu tagasivõttude arv, mida laud teab. */
  private knownUndoCount = 0;
  /** Laud tuleb seada mängu praegusesse seisu (uus mäng või käigu tagasivõtt). */
  private needsSetup = false;
  private mask: number | null = null;
  private maskSince = 0;
  private hint: { move: Move; until: number } | null = null;
  private message: { lines: [string, string]; until: number } | null = null;
  private menuIndex: number | null = null;
  /** Mängu kordus laual: LED-id näitavad käike ükshaaval, mask ei loe. */
  private replay: { gameId: string; ply: number } | null = null;
  private lastSeen: number | null = null;
  /** Mitmenda käigu AI varumootori teadet on juba näidatud. */
  private fallbackNoticePly = -1;

  constructor(
    readonly id: string,
    private readonly store: GameStore,
    options: BoardControllerOptions = {},
  ) {
    this.timing = { ...DEFAULT_TIMING, ...options.timing };
    this.now = options.now ?? Date.now;
    this.players = options.players ?? (() => []);
    this.puzzles = options.puzzles;
  }

  /** Alustab laual ülesannet: laud tuleb seada ülesande seisu. */
  startPuzzle(puzzle: PuzzleDef): Game {
    const game = this.store.create(puzzleGame(puzzle));
    this.lastPuzzleId = puzzle.id;
    this.attach(game);
    return game;
  }

  get game(): Game | null {
    return this.gameId ? (this.store.get(this.gameId) ?? null) : null;
  }

  /** Seob laua mänguga. Laud tuleb seejärel mängu seisu seada. */
  attach(game: Game): void {
    this.gameId = game.id;
    this.boardPly = game.history.length;
    this.knownUndoCount = game.undoCount;
    this.needsSetup = true;
    this.hint = null;
    this.message = null;
    this.menuIndex = null;
    this.replay = null;
    this.match = null;
  }

  /**
   * Võrgumäng: laud mängib ainult ühe värviga. Vastase käigud (teiselt laualt)
   * näidatakse LED-idega nagu AI käigud ja tuleb laual järele teha.
   */
  joinMatch(game: Game, seat: Color, peerId: string, peer: () => BoardController | undefined): void {
    this.attach(game);
    this.match = { seat, peerId, peer };
  }

  /** Mängib mängu laual käik-käigult läbi (B1 tagasi, B2 edasi, B3 välja). */
  startReplay(game: Game): void {
    this.replay = { gameId: game.id, ply: 0 };
    this.menuIndex = null;
    this.hint = null;
    // Mänguülevaade arvutatakse taustal; kui valmis, näitab kordus vigu.
    this.store.review(game).catch(() => {});
  }

  /** Alustab laualt uue mängu menüü seadetega. */
  newGame(settings: Partial<BoardSettings> = {}): Game {
    if (settings.opponent) this.settings.opponent = settings.opponent;
    if (settings.level) this.settings.level = settings.level;
    if (settings.humanColor) this.settings.humanColor = settings.humanColor;
    if (settings.clockMinutes !== undefined) this.settings.clockMinutes = settings.clockMinutes;
    if (settings.playerId !== undefined) this.settings.playerId = settings.playerId;
    const opponent = this.settings.opponent === 'none' ? null : this.settings.opponent;
    // Kustutatud mängijat ei kasutata.
    const playerId = this.players().some((p) => p.id === this.settings.playerId) ? this.settings.playerId : null;
    const seat: Color = opponent ? this.settings.humanColor : 'white';
    const game = this.store.create({
      opponent,
      level: this.settings.level,
      humanColor: this.settings.humanColor,
      clockMs: this.settings.clockMinutes * 60_000,
      players: { [seat]: playerId },
    });
    this.attach(game);
    return game;
  }

  /** Laua uus olek. Tagastab, mida laud peab nüüd näitama. */
  update(input: { mask?: number; buttons?: BoardButton[] }): BoardDisplay {
    const now = this.now();
    this.lastSeen = now;
    if (input.mask !== undefined) {
      const mask = input.mask >>> 0;
      if (mask !== this.mask) {
        this.mask = mask;
        this.maskSince = now;
      }
    }
    for (const button of input.buttons ?? []) this.press(button);
    this.step();
    return this.display();
  }

  status(): BoardStatus {
    const replay = this.replay ? { replayPly: this.replay.ply } : {};
    return {
      ...replay,
      id: this.id,
      gameId: this.gameId,
      mask: this.mask === null ? null : maskHex(this.mask),
      boardPly: this.boardPly,
      state: this.state(),
      settings: { ...this.settings },
      online: this.isOnline(),
      lastSeenAt: this.lastSeen === null ? null : new Date(this.lastSeen).toISOString(),
      match: this.match ? { seat: this.match.seat, peerId: this.match.peerId, peerOnline: this.peerOnline() } : null,
    };
  }

  isOnline(): boolean {
    return this.lastSeen !== null && this.now() - this.lastSeen < ONLINE_MS;
  }

  private peerOnline(): boolean {
    return this.match?.peer()?.isOnline() ?? false;
  }

  // --- olek ---

  private stableFor(ms: number): boolean {
    return this.mask !== null && this.now() - this.maskSince >= ms;
  }

  private boardPosition(game: Game): Position {
    return game.positions[this.boardPly] ?? game.position;
  }

  private state(): BoardStatus['state'] {
    if (this.menuIndex !== null) return 'menu';
    if (this.replay) return 'replay';
    const game = this.game;
    if (!game) return 'no-game';
    if (this.mask === null) return 'waiting-board';
    if (this.needsSetup) return 'setup';
    if (this.boardPly < game.history.length) return 'pending-move';
    if (game.aiThinking) return 'ai-thinking';
    if (this.store.isOver(game)) return 'game-over';
    return 'play';
  }

  /** Tõlgendab stabiilset maski: seadistus, järele jõudmine või inimese käik. */
  private step(): void {
    const game = this.game;
    if (this.replay || !game || this.mask === null || !this.stableFor(this.timing.settleMs)) return;
    const mask = this.mask;

    if (this.boardPly > game.history.length || this.knownUndoCount !== game.undoCount) {
      // Käik võeti mujal (äpis) tagasi: laud tuleb uude seisu seada.
      this.boardPly = game.history.length;
      this.knownUndoCount = game.undoCount;
      this.needsSetup = true;
    }

    if (this.needsSetup) {
      if (mask === occupancyMask(game.position.board)) {
        this.needsSetup = false;
        this.boardPly = game.history.length;
        this.store.startAiTurn(game);
      }
      return;
    }

    if (this.boardPly < game.history.length) {
      const aiPly = game.history.length - 1;
      if (game.lastAiMove?.fallbackReason && this.fallbackNoticePly !== aiPly) {
        // Claude API ei vastanud, käis kohalik mootor: anna sellest teada.
        this.fallbackNoticePly = aiPly;
        this.flash(['Claude ei vasta', 'Käis arvuti']);
      }
      // Laual tehakse järele AI või äpi käiku; mitu käiku korraga on samuti lubatud.
      for (let ply = game.history.length; ply > this.boardPly; ply--) {
        if (occupancyMask(game.positions[ply]!.board) === mask) {
          const done = game.moves.slice(this.boardPly, ply);
          this.boardPly = ply;
          if (done.some((m) => m.promotes)) this.flash(['Tamm!', 'Pane kroon peale']);
          break;
        }
      }
      if (this.boardPly === game.history.length) this.store.startAiTurn(game);
      return;
    }

    if (this.store.isAiTurn(game)) {
      this.store.startAiTurn(game);
      return;
    }
    if (!this.store.canHumanMove(game)) return;
    // Võrgumängus ei loeta vastase poole käike sellelt laualt.
    if (this.match && game.position.turn !== this.match.seat) return;
    const detection = detectMove(game.position, mask);
    if (detection.kind !== 'move') return;
    this.store.play(game, detection.move);
    this.boardPly = game.history.length;
    this.hint = null;
    if (detection.move.promotes) this.flash(['Tamm!', 'Pane kroon peale']);
    this.store.startAiTurn(game);
  }

  // --- nupud ---

  private press(button: BoardButton): void {
    if (this.menuIndex !== null) {
      this.menuPress(button);
      return;
    }
    if (this.replay) {
      this.replayPress(button);
      return;
    }
    const game = this.game;
    if (button === 3) {
      this.menuIndex = 0;
      return;
    }
    if (!game) {
      if (button === 2) this.newGame();
      return;
    }
    const seat = this.match?.seat;
    if (seat && game.drawOffer === (seat === 'white' ? 'black' : 'white') && !this.store.isOver(game)) {
      // Vastane pakkus viiki: B2 võtab vastu, B1 keeldub.
      if (button === 2) this.store.offerDraw(game, seat);
      if (button === 1) this.store.declineDraw(game, seat);
      return;
    }
    if (button === 1) this.showHint(game);
    if (button === 2) this.undo(game);
  }

  private showHint(game: Game): void {
    if (game.puzzle) {
      this.flash(['Ülesandes', 'vihjet pole']);
      return;
    }
    if (this.needsSetup || this.boardPly < game.history.length || !this.store.canHumanMove(game)) {
      this.flash(['Vihjet pole', 'Praegu ei saa']);
      return;
    }
    const hint = suggestMove(game.position);
    if (hint) this.hint = { move: hint.move, until: this.now() + this.timing.hintMs };
  }

  private undo(game: Game): void {
    if (this.match) {
      this.flash(['Võrgumängus', 'tagasivõttu pole']);
      return;
    }
    if (game.aiThinking) {
      this.flash(['Oota hetk', 'AI mõtleb...']);
      return;
    }
    if (this.store.undo(game) === 0) {
      this.flash(['Tagasivõtt', 'Pole käiku']);
      return;
    }
    this.boardPly = game.history.length;
    this.knownUndoCount = game.undoCount;
    this.needsSetup = true;
    this.hint = null;
  }

  private replayPress(button: BoardButton): void {
    const replay = this.replay!;
    const game = this.store.get(replay.gameId);
    if (button === 3 || !game) {
      this.replay = null;
      if (this.game) this.needsSetup = true;
      return;
    }
    if (button === 1) replay.ply = Math.max(0, replay.ply - 1);
    if (button === 2) replay.ply = Math.min(game.history.length, replay.ply + 1);
  }

  private menuPress(button: BoardButton): void {
    const index = this.menuIndex ?? 0;
    if (button === 3) {
      this.menuIndex = null;
      return;
    }
    if (button === 1) {
      this.menuIndex = (index + 1) % MENU_ITEMS.length;
      return;
    }
    const item = MENU_ITEMS[index]!;
    if (item === 'new') {
      this.newGame();
      this.menuIndex = null;
    } else if (item === 'replay') {
      const game = this.game;
      if (game && game.history.length > 0) this.startReplay(game);
      else this.flash(['Kordus', 'Pole käike']);
      this.menuIndex = null;
    } else if (item === 'puzzle') {
      this.menuIndex = null;
      const puzzle = this.puzzles?.next(this.lastPuzzleId);
      if (puzzle) this.startPuzzle(puzzle);
      else this.flash(['Ülesandeid', 'pole']);
    } else if (item === 'draw' || item === 'resign') {
      this.menuIndex = null;
      const game = this.game;
      if (!game || this.store.isOver(game)) {
        this.flash(['Mäng pole käimas', 'B3 menüü']);
      } else if (item === 'resign') {
        this.store.resign(game, this.match?.seat ?? this.store.actor(game));
      } else if (this.match) {
        if (this.store.offerDraw(game, this.match.seat) === 'pending') this.flash(['Viik pakutud', 'Ootan vastast']);
      } else if (!game.opponent) {
        // Mõlemad mängijad on laua taga: viik kehtib kohe.
        this.store.agreeDraw(game);
      } else if (this.store.offerDraw(game, game.humanColor) !== 'accepted') {
        this.flash(['Viik', 'Vastane keeldus']);
      }
    } else if (item === 'opponent') {
      this.settings.opponent = next(OPPONENTS, this.settings.opponent);
    } else if (item === 'player') {
      const ids = [null, ...this.players().map((p) => p.id)];
      this.settings.playerId = next(ids, ids.includes(this.settings.playerId) ? this.settings.playerId : null);
    } else if (item === 'clock') {
      this.settings.clockMinutes = next(CLOCK_MINUTES, this.settings.clockMinutes);
    } else if (item === 'level') {
      this.settings.level = next(LEVELS, this.settings.level);
    } else {
      this.settings.humanColor = this.settings.humanColor === 'white' ? 'black' : 'white';
    }
  }

  private flash(lines: [string, string]): void {
    this.message = { lines, until: this.now() + this.timing.messageMs };
  }

  // --- näitamine ---

  display(): BoardDisplay {
    const now = this.now();
    if (this.message && now >= this.message.until) this.message = null;
    if (this.hint && now >= this.hint.until) this.hint = null;

    const base = this.baseDisplay();
    const lines = this.message?.lines ?? base.lines;
    return makeDisplay(lines, base.leds, base.effect);
  }

  private baseDisplay(): { lines: [string, string]; leds: LedCommand[]; effect?: BoardDisplay['effect'] } {
    if (this.menuIndex !== null) return { lines: this.menuLines(this.menuIndex), leds: [] };
    if (this.replay) return this.replayDisplay(this.replay);
    const game = this.game;
    if (!game) return { lines: ['Nutikas kabe', 'B2 uus  B3 menüü'], leds: [], effect: 'idle' };
    if (this.mask === null) return { lines: ['Ootan lauda...', ''], leds: [] };
    const mask = this.mask;

    if (this.needsSetup) {
      const { missing, extra } = diff(occupancyMask(game.position.board), mask);
      return {
        lines: ['Sea nupud paika', `Puudu ${missing.length} liig ${extra.length}`],
        leds: [...missing.map((sq) => led(sq, COLORS.missing, 'blink')), ...extra.map((sq) => led(sq, COLORS.extra, 'blink'))],
      };
    }

    if (this.boardPly < game.history.length) return this.pendingDisplay(game, mask);

    const position = game.position;
    const puzzle = game.puzzle;
    if (puzzle?.state === 'solved') return { lines: ['Lahendatud!', 'B3: järgmine'], leds: [], effect: `win-${game.humanColor}` };
    if (puzzle?.state === 'failed') {
      const before = game.positions[game.positions.length - 2];
      const right = before && puzzle.solution ? findMoveText(before, puzzle.solution) : null;
      return {
        lines: ['Vale käik!', `Õige: ${puzzle.solution ?? '?'}`],
        leds: right ? [led(right.from, COLORS.hint), led(finalSquare(right), COLORS.hint, 'blink')] : [],
      };
    }
    const result = this.store.result(game);
    if (result.status === 'win') {
      return {
        lines: [result.winner === 'white' ? 'Valge võitis!' : 'Must võitis!', WIN_REASON[result.reason]],
        leds: [],
        effect: result.winner === 'white' ? 'win-white' : 'win-black',
      };
    }
    if (result.status === 'draw') return { lines: ['Viik!', DRAW_REASON[result.reason]], leds: [], effect: 'draw' };

    const expected = occupancyMask(position.board);
    const counts = puzzle
      ? puzzle.goalMoves > 1
        ? `Käik ${puzzle.found + 1}/${puzzle.goalMoves}`
        : 'Leia parim käik'
      : game.clock
        ? this.clockLine(game)
        : countLine(position);
    if (game.aiThinking) {
      const leds = mask !== expected && this.stableFor(this.timing.errorMs) ? errorLeds(expected, mask) : [];
      return { lines: ['AI mõtleb...', counts], leds };
    }

    const seat = this.match?.seat;
    if (seat) {
      if (game.drawOffer && game.drawOffer !== seat) return { lines: ['Vastane: viik?', 'B2 jah   B1 ei'], leds: [] };
      if (position.turn !== seat) {
        const leds = mask !== expected && this.stableFor(this.timing.errorMs) ? errorLeds(expected, mask) : [];
        return { lines: ['Vastase kord', this.peerOnline() ? counts : 'Vastane eemal'], leds };
      }
    }

    const turn = seat ? 'Sinu kord' : turnLine(game);
    const moves = legalMoves(position);
    if (mask !== expected) {
      const { missing, extra } = diff(expected, mask);
      const lifted = missing.length === 1 && extra.length === 0 ? missing[0]! : null;
      if (lifted !== null && position.board[lifted]?.color === position.turn) {
        const fromHere = moves.filter((m) => m.from === lifted);
        if (fromHere.length > 0) {
          return { lines: [turn, `${fromHere.length} võimalust`], leds: liftLeds(lifted, fromHere) };
        }
        return { lines: [turn, 'See nupp ei käi'], leds: [led(lifted, COLORS.missing, 'blink')] };
      }
      if (this.stableFor(this.timing.errorMs)) {
        return { lines: ['Vale käik!', 'Paranda vilkuvad'], leds: errorLeds(expected, mask) };
      }
      return { lines: [turn, counts], leds: [] };
    }

    if (this.hint) {
      const m = this.hint.move;
      return {
        lines: [`Vihje: ${formatMove(m)}`, counts],
        leds: [led(m.from, COLORS.hint), led(finalSquare(m), COLORS.hint, 'blink')],
      };
    }

    const forced = moves.some((m) => m.captures.length > 0);
    if (forced) {
      const from = [...new Set(moves.map((m) => m.from))];
      return { lines: [turn, 'Löömine kohust.'], leds: from.map((sq) => led(sq, COLORS.forced, 'blink')) };
    }
    return { lines: [turn, counts], leds: [] };
  }

  private replayDisplay(replay: { gameId: string; ply: number }): { lines: [string, string]; leds: LedCommand[] } {
    const game = this.store.get(replay.gameId);
    if (!game) return { lines: ['Kordus', 'Mängu pole'], leds: [] };
    const total = game.history.length;
    const move = game.moves[replay.ply];
    if (!move) {
      const result = this.store.result(game);
      const text =
        result.status === 'win' ? (result.winner === 'white' ? 'Valge võitis' : 'Must võitis') : result.status === 'draw' ? 'Viik' : 'Pooleli';
      return { lines: [`Kordus ${total}/${total}`, text], leds: [] };
    }
    const header = `Kordus ${replay.ply + 1}/${total}`;
    // Kui mänguülevaade on valmis, näidatakse vigu ja paremat käiku.
    const reviewed = this.store.cachedReview(game)?.moves[replay.ply];
    if (reviewed && (reviewed.classification === 'mistake' || reviewed.classification === 'blunder')) {
      const better = findMoveText(game.positions[replay.ply]!, reviewed.best);
      const label = reviewed.classification === 'blunder' ? 'Suur viga' : 'Viga';
      return {
        lines: [`${replay.ply + 1}/${total} ${formatMove(move)}`, `${label}! ${reviewed.best}`],
        leds: [...moveLeds(move), ...(better ? [led(better.from, COLORS.hint), led(finalSquare(better), COLORS.hint, 'blink')] : [])],
      };
    }
    return { lines: [header, formatMove(move)], leds: moveLeds(move) };
  }

  /** Käik, mis on mängus tehtud (AI või äpp), aga laual veel mitte. */
  private pendingDisplay(game: Game, mask: number): { lines: [string, string]; leds: LedCommand[] } {
    const move = game.moves[this.boardPly]!;
    const before = game.positions[this.boardPly]!;
    const mover = before.turn;
    const byAi = game.opponent !== null && mover !== game.humanColor;
    const text = formatMove(move);
    const leds = moveLeds(move);

    // Kui liigutati nuppu, mis selle käiguga pistmist ei oma, näita ka seda.
    const involved = new Set<Square>([move.from, ...move.path, ...move.captures]);
    if (this.stableFor(this.timing.errorMs)) {
      const { missing, extra } = diff(occupancyMask(before.board), mask);
      const wrong = [...missing, ...extra].filter((sq) => !involved.has(sq));
      leds.push(...wrong.map((sq) => led(sq, missing.includes(sq) ? COLORS.missing : COLORS.extra, 'blink')));
    }
    return {
      lines: [byAi ? `AI: ${text}` : `Käik: ${text}`, move.promotes ? 'Tee + pane kroon' : 'Tee käik laual'],
      leds,
    };
  }

  private clockLine(game: Game): string {
    const fmt = (ms: number) => {
      const s = Math.ceil(ms / 1000);
      return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    };
    const white = `V ${fmt(this.store.remaining(game, 'white'))}`;
    const black = `M ${fmt(this.store.remaining(game, 'black'))}`;
    return `${white}${' '.repeat(Math.max(1, 16 - white.length - black.length))}${black}`;
  }

  private menuLines(index: number): [string, string] {
    const item = MENU_ITEMS[index]!;
    const label =
      item === 'new'
        ? 'Uus mäng'
        : item === 'opponent'
          ? `Vastane:${OPPONENT_LABEL[this.settings.opponent]}`
          : item === 'level'
            ? `Tase:${LEVEL_LABEL[this.settings.level]}`
            : item === 'color'
              ? `Sina:${this.settings.humanColor === 'white' ? 'valge' : 'must'}`
              : item === 'puzzle'
                ? 'Ülesanne'
                : item === 'player'
                ? `Mängija:${this.players().find((p) => p.id === this.settings.playerId)?.name ?? 'külaline'}`
              : item === 'clock'
                ? `Kell:${this.settings.clockMinutes === 0 ? 'väljas' : `${this.settings.clockMinutes} min`}`
                : item === 'replay'
                  ? 'Kordus'
                  : item === 'draw'
                    ? 'Paku viiki'
                    : 'Alistu';
    return [`>${label}`, 'B1 edasi B2 vali'];
  }
}

function diff(expected: number, observed: number): { missing: Square[]; extra: Square[] } {
  return {
    missing: squaresInMask(expected & ~observed),
    extra: squaresInMask(observed & ~expected),
  };
}

function errorLeds(expected: number, observed: number): LedCommand[] {
  const { missing, extra } = diff(expected, observed);
  return [...missing.map((sq) => led(sq, COLORS.missing, 'blink')), ...extra.map((sq) => led(sq, COLORS.extra, 'blink'))];
}

function moveLeds(move: Move): LedCommand[] {
  const to = finalSquare(move);
  return [
    led(move.from, COLORS.from),
    ...move.path.filter((sq) => sq !== to).map((sq) => led(sq, COLORS.path)),
    led(to, COLORS.to),
    ...move.captures.map((sq) => led(sq, COLORS.capture, 'blink')),
  ];
}

function liftLeds(from: Square, moves: Move[]): LedCommand[] {
  return [
    led(from, COLORS.lifted),
    ...moves.map((m) => led(finalSquare(m), COLORS.to)),
    ...moves.flatMap((m) => m.captures.map((sq) => led(sq, COLORS.capture))),
  ];
}

function countLine(position: Position): string {
  let white = 0;
  let black = 0;
  for (const piece of position.board) {
    if (piece?.color === 'white') white++;
    else if (piece?.color === 'black') black++;
  }
  return `Valge ${white} must ${black}`;
}

function turnLine(game: Game): string {
  const turn = game.position.turn;
  if (game.puzzle && turn === game.humanColor) return `Ülesanne: ${turn === 'white' ? 'valge' : 'must'}`;
  if (!game.opponent) return turn === 'white' ? 'Valge kord' : 'Musta kord';
  if (turn !== game.humanColor) return 'AI kord';
  return `Sinu kord: ${turn === 'white' ? 'valge' : 'must'}`;
}
