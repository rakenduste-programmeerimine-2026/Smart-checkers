/**
 * Mängude haldus: ühine koht REST API ja füüsilise laua jaoks.
 *
 * Iga mäng hoiab kõiki seise algusest peale, et käiku saaks tagasi võtta ja laud
 * saaks järele jõuda käikudele, mis tehti mujal (AI või äpp).
 */
import { randomUUID } from 'node:crypto';
import { applyMove, formatMove, gameResult, initialPosition } from '../game/rules.js';
import type { Color, Move, Position } from '../game/types.js';
import type { AiLevel } from '../ai/engine.js';
import type { Opponent, OpponentKind, OpponentMove } from '../ai/opponent.js';

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
  /** positions[i] on seis enne käiku i; viimane on praegune seis. */
  positions: Position[];
  createdAt: string;
  /** AI arvutab praegu käiku. */
  aiThinking: boolean;
  lastAiMove: OpponentMove | null;
}

export interface NewGameOptions {
  opponent: OpponentKind | null;
  level: AiLevel;
  humanColor: Color;
}

export class GameStore {
  private readonly games = new Map<string, Game>();

  constructor(
    private readonly opponents: Record<OpponentKind, Opponent>,
    private readonly onAiError: (error: unknown) => void = () => {},
  ) {}

  create(options: NewGameOptions): Game {
    const position = initialPosition();
    const game: Game = {
      id: randomUUID(),
      ...options,
      position,
      history: [],
      moves: [],
      positions: [position],
      createdAt: new Date().toISOString(),
      aiThinking: false,
      lastAiMove: null,
    };
    this.games.set(game.id, game);
    return game;
  }

  get(id: string): Game | undefined {
    return this.games.get(id);
  }

  isOver(game: Game): boolean {
    return gameResult(game.position).status !== 'ongoing';
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
    game.position = applyMove(game.position, move);
    game.moves.push(move);
    game.history.push(formatMove(move));
    game.positions.push(game.position);
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
    this.aiTurn(game).catch((error: unknown) => this.onAiError(error));
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
    game.positions.length = last + 1;
    game.position = game.positions[last]!;
    game.lastAiMove = null;
    return removed;
  }
}
