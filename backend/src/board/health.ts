/**
 * Laua tervis: ühenduse logi ja reed-lülitite kontroll.
 *
 * - Ühendus: päringute arv, keskmine ja suurim vahe, katkestused (laud ei
 *   küsinud ONLINE_MS jooksul) ning viimased sündmused.
 * - Andurid: lüliti, mis lülitub väga kiiresti edasi-tagasi (värin), on
 *   tõenäoliselt lahti või magnet on piiri peal.
 */
import { SQUARE_COUNT, squareName, type Square } from '../game/squares.js';

export const MAX_LOG = 50;
/** Kui kiiresti peab bitt tagasi muutuma, et see loeks värinaks. */
export const FLICKER_MS = 150;
/** Mitu värinat teeb lüliti kahtlaseks. */
export const FLICKER_LIMIT = 3;

export interface HealthEvent {
  at: string;
  event: 'online' | 'offline';
}

export interface BoardHealth {
  online: boolean;
  requests: number;
  avgIntervalMs: number | null;
  maxGapMs: number | null;
  disconnects: number;
  log: HealthEvent[];
  sensors: {
    /** Ruudud, mille lüliti on vähemalt korra sees olnud. */
    seen: number;
    /** Ruudud, mille lüliti väriseb. */
    flickering: string[];
  };
}

export class HealthMonitor {
  private requests = 0;
  private first: number | null = null;
  private last: number | null = null;
  private maxGap = 0;
  private disconnects = 0;
  private readonly log: HealthEvent[] = [];
  private mask: number | null = null;
  private seenMask = 0;
  private readonly lastChange = new Array<number>(SQUARE_COUNT).fill(-Infinity);
  private readonly flicker = new Array<number>(SQUARE_COUNT).fill(0);

  constructor(private readonly onlineMs: number) {}

  /** Laua päring (iga update). */
  request(now: number, mask: number | undefined): void {
    if (this.last !== null) {
      const gap = now - this.last;
      this.maxGap = Math.max(this.maxGap, gap);
      if (gap >= this.onlineMs) {
        this.disconnects++;
        this.push(this.last + this.onlineMs, 'offline');
        this.push(now, 'online');
      }
    } else {
      this.first = now;
      this.push(now, 'online');
    }
    this.requests++;
    this.last = now;
    if (mask !== undefined) this.sensor(now, mask >>> 0);
  }

  /** Andurite seis on lähtestatud (näiteks testirežiimi alguses). */
  resetSensors(): void {
    this.seenMask = 0;
    this.flicker.fill(0);
  }

  seenCount(): number {
    let n = 0;
    for (let sq = 0; sq < SQUARE_COUNT; sq++) if (this.seenMask & (1 << sq)) n++;
    return n;
  }

  seen(sq: Square): boolean {
    return (this.seenMask & (1 << sq)) !== 0;
  }

  report(now: number): BoardHealth {
    const online = this.last !== null && now - this.last < this.onlineMs;
    const span = this.first !== null && this.last !== null ? this.last - this.first : 0;
    return {
      online,
      requests: this.requests,
      avgIntervalMs: this.requests > 1 ? Math.round(span / (this.requests - 1)) : null,
      maxGapMs: this.requests > 1 ? this.maxGap : null,
      disconnects: this.disconnects,
      log: [...this.log],
      sensors: {
        seen: this.seenCount(),
        flickering: this.flicker.flatMap((n, sq) => (n >= FLICKER_LIMIT ? [squareName(sq)] : [])),
      },
    };
  }

  private sensor(now: number, mask: number): void {
    this.seenMask = (this.seenMask | mask) >>> 0;
    if (this.mask !== null && mask !== this.mask) {
      const changed = (mask ^ this.mask) >>> 0;
      for (let sq = 0; sq < SQUARE_COUNT; sq++) {
        if (!(changed & (1 << sq))) continue;
        if (now - this.lastChange[sq]! < FLICKER_MS) this.flicker[sq]!++;
        this.lastChange[sq] = now;
      }
    }
    this.mask = mask;
  }

  private push(at: number, event: HealthEvent['event']): void {
    this.log.push({ at: new Date(at).toISOString(), event });
    if (this.log.length > MAX_LOG) this.log.shift();
  }
}
