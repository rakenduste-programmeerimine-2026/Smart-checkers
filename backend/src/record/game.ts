/**
 * Ühe mängu käik ja logi.
 *
 * Mäng algab alati algseisust, sest laua lülitid tunnevad ainult nupu olemasolu,
 * mitte värvi ega tammi: seisu saab usaldusväärselt jälgida ainult tuntud algusest.
 */
import { randomUUID } from 'node:crypto';
import { applyMove, findMove, formatMove, gameResult, initialPosition } from '../game/rules.js';
import type { GameResult, Move, Position } from '../game/types.js';

export interface GameMeta {
  white?: string;
  black?: string;
  event?: string;
  /** ISO aeg. */
  startedAt: string;
}

export interface RecordedMove {
  /** Käik tekstina, näiteks "c3-d4" või "d4:f6:d8". */
  text: string;
  /** ISO aeg, millal käik kirja pandi. */
  at: string;
}

/** Mänguserveri seaded, et salvestatud mängu saaks jätkata samamoodi. */
export interface RecordSettings {
  opponent: 'engine' | 'claude' | null;
  level: 'beginner' | 'medium' | 'strong';
  humanColor: 'white' | 'black';
  /** Male kella algaeg millisekundites, kui kell on kasutusel. */
  clockMs?: number | null;
  /** Edetabeli mängijad (id) värvi järgi. */
  players?: { white: string | null; black: string | null };
}

/** Salvestatav mängu kirje (JSON). */
export interface GameRecord {
  id: string;
  meta: GameMeta;
  settings?: RecordSettings;
  moves: RecordedMove[];
  result: GameResult;
  /** ISO aeg, kui mäng lõppes. */
  endedAt?: string;
  /** Kelle kell sai otsa (kui mäng lõppes aja tõttu). */
  flagged?: 'white' | 'black';
  /** Alistumine või viigikokkulepe. */
  ending?: { kind: 'resign'; by: 'white' | 'black' } | { kind: 'agreement' };
  /** Tulemus on edetabelisse kantud. */
  rated?: boolean;
}

export interface GameOptions {
  id?: string;
  meta?: Partial<GameMeta>;
  now?: () => Date;
}

export class Game {
  readonly id: string;
  readonly meta: GameMeta;
  private readonly now: () => Date;
  private readonly positions: Position[] = [initialPosition()];
  private readonly log: RecordedMove[] = [];
  private endedAt: string | undefined;

  constructor(options: GameOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.id = options.id ?? randomUUID();
    this.meta = { ...options.meta, startedAt: options.meta?.startedAt ?? this.now().toISOString() };
  }

  get position(): Position {
    const pos = this.positions[this.positions.length - 1];
    if (!pos) throw new Error('Mängul puudub seis');
    return pos;
  }

  get moves(): readonly RecordedMove[] {
    return this.log;
  }

  result(): GameResult {
    return gameResult(this.position, this.positions);
  }

  /** Teeb käigu. Viskab vea, kui käik pole seaduslik või mäng on läbi. */
  play(move: Move | string, at?: Date): Move {
    if (this.result().status !== 'ongoing') throw new Error('Mäng on läbi');
    const text = typeof move === 'string' ? move : formatMove(move);
    const legal = findMove(this.position, text);
    if (!legal) throw new Error(`Vigane käik: ${text}`);
    const time = (at ?? this.now()).toISOString();
    this.positions.push(applyMove(this.position, legal));
    this.log.push({ text: formatMove(legal), at: time });
    this.endedAt = this.result().status === 'ongoing' ? undefined : time;
    return legal;
  }

  /** Võtab viimase käigu tagasi. Tagastab false, kui käike pole. */
  undo(): boolean {
    if (this.log.length === 0) return false;
    this.log.pop();
    this.positions.pop();
    this.endedAt = undefined;
    return true;
  }

  toRecord(): GameRecord {
    const record: GameRecord = {
      id: this.id,
      meta: { ...this.meta },
      moves: this.log.map((m) => ({ ...m })),
      result: this.result(),
    };
    if (this.endedAt) record.endedAt = this.endedAt;
    return record;
  }

  /** Taastab mängu kirjest, mängides käigud algseisust uuesti läbi. */
  static fromRecord(record: GameRecord): Game {
    const game = new Game({ id: record.id, meta: record.meta });
    for (const move of record.moves) game.play(move.text, new Date(move.at));
    return game;
  }
}
