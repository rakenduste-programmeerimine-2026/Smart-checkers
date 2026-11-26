/**
 * Laua maskide jälgimine ja käikude kirja panemine.
 *
 * Nupu tõstmise ja löömise ajal on laud poolikus seisus. Käik pannakse kirja alles siis,
 * kui sama mask on püsinud vähemalt `stableMs` millisekundit.
 */
import { formatMove } from '../game/rules.js';
import { detectMove } from '../game/sensors.js';
import type { Square } from '../game/squares.js';
import type { Move } from '../game/types.js';
import type { Game } from './game.js';

export const DEFAULT_STABLE_MS = 300;

export type TrackerEvent =
  /** Mask muutus hiljuti, ootame, kuni see püsib. */
  | { kind: 'pending' }
  /** Laud vastab praegusele seisule. */
  | { kind: 'unchanged' }
  /** Uus käik pandi kirja. */
  | { kind: 'move'; move: Move; text: string }
  /** Laud ei vasta ühelegi seaduslikule käigule (pooleli käik või viga). */
  | { kind: 'mismatch'; missing: Square[]; extra: Square[] };

export interface TrackerOptions {
  stableMs?: number;
}

export class BoardTracker {
  private readonly stableMs: number;
  private mask: number | null = null;
  private since = 0;
  private handled = false;
  private last: TrackerEvent = { kind: 'pending' };

  constructor(
    private readonly game: Game,
    options: TrackerOptions = {},
  ) {
    this.stableMs = options.stableMs ?? DEFAULT_STABLE_MS;
  }

  /**
   * Uus mask laualt. `atMs` on vastuvõtu aeg millisekundites (näiteks Date.now()).
   * Sama maski võib saata korduvalt; käik pannakse kirja ainult üks kord.
   */
  update(mask: number, atMs: number): TrackerEvent {
    const observed = mask >>> 0;
    if (observed !== this.mask) {
      this.mask = observed;
      this.since = atMs;
      this.handled = false;
    }
    if (atMs - this.since < this.stableMs) return { kind: 'pending' };
    if (this.handled) return this.last.kind === 'move' ? { kind: 'unchanged' } : this.last;

    this.handled = true;
    const detection = detectMove(this.game.position, observed);
    if (detection.kind === 'move') {
      const move = this.game.play(detection.move, new Date(atMs));
      this.last = { kind: 'move', move, text: formatMove(move) };
    } else {
      this.last = detection;
    }
    return this.last;
  }
}
