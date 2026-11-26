/**
 * Mängijad ja edetabel. Iga mängija reiting ja statistika uuendatakse mängu
 * lõpus üks kord. Kui failitee on antud, salvestatakse kõik ühte JSON-faili.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { START_RATING, newRating, rankTitle } from './elo.js';

export interface PlayerStats {
  games: number;
  wins: number;
  losses: number;
  draws: number;
  /** Positiivne = võitude seeria, negatiivne = kaotuste seeria. */
  streak: number;
  /** Võidud, kaotused ja viigid vastase kaupa ("engine:medium", "claude:strong", "human"). */
  byOpponent: Record<string, { wins: number; losses: number; draws: number }>;
}

export interface RatingPoint {
  at: string;
  rating: number;
  gameId: string;
}

export interface Player {
  id: string;
  name: string;
  rating: number;
  bestRating: number;
  createdAt: string;
  stats: PlayerStats;
  /** Viimased reitingu muutused (kuni 50). */
  history: RatingPoint[];
}

export interface PublicPlayer extends Omit<Player, 'history'> {
  title: string;
  /** Koht edetabelis (1 = parim). */
  rank: number;
}

export type Outcome = 'win' | 'loss' | 'draw';

export interface RatedResult {
  playerId: string;
  /** Vastase reiting enne mängu. */
  opponentRating: number;
  opponentKey: string;
  outcome: Outcome;
  gameId: string;
  at: string;
}

export const MAX_PLAYERS = 500;
export const MAX_HISTORY = 50;
const NAME_RE = /^[\p{L}\p{N} _.-]{1,24}$/u;

const emptyStats = (): PlayerStats => ({ games: 0, wins: 0, losses: 0, draws: 0, streak: 0, byOpponent: {} });

export class PlayerStore {
  private players = new Map<string, Player>();
  private loaded: Promise<void> | null = null;
  private saving: Promise<void> = Promise.resolve();

  constructor(
    private readonly file?: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Loeb mängijad failist (üks kord). */
  async ready(): Promise<void> {
    this.loaded ??= (async () => {
      if (!this.file) return;
      try {
        const data = JSON.parse(await readFile(this.file, 'utf8')) as { players?: Player[] };
        for (const p of data.players ?? []) this.players.set(p.id, p);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
    })();
    return this.loaded;
  }

  async create(name: string): Promise<Player> {
    await this.ready();
    const clean = name.trim().replace(/\s+/g, ' ');
    if (!NAME_RE.test(clean)) throw new PlayerError(400, 'Nimi peab olema 1–24 märki (tähed, numbrid, tühik, _ . -)');
    if (this.findByName(clean)) throw new PlayerError(409, 'Selle nimega mängija on juba olemas');
    if (this.players.size >= MAX_PLAYERS) throw new PlayerError(429, 'Liiga palju mängijaid');
    const player: Player = {
      id: randomUUID(),
      name: clean,
      rating: START_RATING,
      bestRating: START_RATING,
      createdAt: this.now().toISOString(),
      stats: emptyStats(),
      history: [],
    };
    this.players.set(player.id, player);
    await this.save();
    return player;
  }

  async get(id: string): Promise<Player | undefined> {
    await this.ready();
    return this.players.get(id);
  }

  /** Mängija mälust (pärast `ready`). */
  peek(id: string): Player | undefined {
    return this.players.get(id);
  }

  /** Edetabel mälust (pärast `ready`), laua menüü jaoks. */
  current(): PublicPlayer[] {
    return this.ranked();
  }

  findByName(name: string): Player | undefined {
    const lower = name.trim().toLocaleLowerCase('et');
    return [...this.players.values()].find((p) => p.name.toLocaleLowerCase('et') === lower);
  }

  async rename(id: string, name: string): Promise<Player> {
    await this.ready();
    const player = this.players.get(id);
    if (!player) throw new PlayerError(404, 'Mängijat ei leitud');
    const clean = name.trim().replace(/\s+/g, ' ');
    if (!NAME_RE.test(clean)) throw new PlayerError(400, 'Nimi peab olema 1–24 märki (tähed, numbrid, tühik, _ . -)');
    const other = this.findByName(clean);
    if (other && other.id !== id) throw new PlayerError(409, 'Selle nimega mängija on juba olemas');
    player.name = clean;
    await this.save();
    return player;
  }

  async delete(id: string): Promise<boolean> {
    await this.ready();
    const existed = this.players.delete(id);
    if (existed) await this.save();
    return existed;
  }

  /** Edetabel: parim reiting eespool, võrdsete puhul rohkem mänge. */
  async leaderboard(limit = 50): Promise<PublicPlayer[]> {
    await this.ready();
    return this.ranked().slice(0, limit);
  }

  async publicPlayer(id: string): Promise<(PublicPlayer & { history: RatingPoint[] }) | undefined> {
    await this.ready();
    const player = this.players.get(id);
    if (!player) return undefined;
    const ranked = this.ranked().find((p) => p.id === id)!;
    return { ...ranked, history: player.history };
  }

  /**
   * Kannab mängu tulemused kirja. Kahe mängija tulemused arvutatakse mõlema
   * vana reitingu põhjal (järjekord ei mõjuta).
   */
  async record(results: RatedResult[]): Promise<void> {
    await this.ready();
    const updates = results.flatMap((r) => {
      const player = this.players.get(r.playerId);
      if (!player) return [];
      const score = r.outcome === 'win' ? 1 : r.outcome === 'draw' ? 0.5 : 0;
      return [{ player, r, rating: newRating(player.rating, r.opponentRating, score, player.stats.games) }];
    });
    for (const { player, r, rating } of updates) {
      const s = player.stats;
      s.games++;
      const bucket = (s.byOpponent[r.opponentKey] ??= { wins: 0, losses: 0, draws: 0 });
      if (r.outcome === 'win') {
        s.wins++;
        bucket.wins++;
        s.streak = s.streak > 0 ? s.streak + 1 : 1;
      } else if (r.outcome === 'loss') {
        s.losses++;
        bucket.losses++;
        s.streak = s.streak < 0 ? s.streak - 1 : -1;
      } else {
        s.draws++;
        bucket.draws++;
        s.streak = 0;
      }
      player.rating = rating;
      player.bestRating = Math.max(player.bestRating, rating);
      player.history.push({ at: r.at, rating, gameId: r.gameId });
      if (player.history.length > MAX_HISTORY) player.history.splice(0, player.history.length - MAX_HISTORY);
    }
    if (updates.length > 0) await this.save();
  }

  private ranked(): PublicPlayer[] {
    const sorted = [...this.players.values()].sort(
      (a, b) => b.rating - a.rating || b.stats.games - a.stats.games || a.name.localeCompare(b.name, 'et'),
    );
    return sorted.map(({ history: _history, ...p }, i) => ({ ...p, title: rankTitle(p.rating), rank: i + 1 }));
  }

  /** Salvestused tehakse järjest; fail kirjutatakse ajutisest failist ümber nimetades. */
  private save(): Promise<void> {
    const file = this.file;
    if (!file) return Promise.resolve();
    const snapshot = `${JSON.stringify({ players: [...this.players.values()] }, null, 2)}\n`;
    this.saving = this.saving
      .catch(() => {})
      .then(async () => {
        await mkdir(dirname(file), { recursive: true });
        const tmp = `${file}.${process.pid}.tmp`;
        await writeFile(tmp, snapshot, 'utf8');
        await rename(tmp, file);
      });
    return this.saving;
  }
}

export class PlayerError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}
