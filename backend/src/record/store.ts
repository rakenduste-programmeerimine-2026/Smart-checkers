/**
 * Mängude salvestamine JSON-failidena kausta (üks fail mängu kohta).
 */
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { GameResult } from '../game/types.js';
import type { GameMeta, GameRecord } from './game.js';

export interface GameSummary {
  id: string;
  meta: GameMeta;
  moveCount: number;
  result: GameResult;
  endedAt?: string;
}

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function checkId(id: string): string {
  // Kaitse kataloogist väljumise eest (näiteks "../x").
  if (!ID_RE.test(id)) throw new Error(`Vigane mängu id: ${id}`);
  return id;
}

export class GameStore {
  constructor(private readonly dir: string) {}

  private file(id: string): string {
    return join(this.dir, `${checkId(id)}.json`);
  }

  async save(record: GameRecord): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const target = this.file(record.id);
    // Kirjutame ajutisse faili ja nimetame ümber, et pooleli jäänud kirjutamine ei rikuks faili.
    const tmp = `${target}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    await rename(tmp, target);
  }

  async load(id: string): Promise<GameRecord | null> {
    try {
      return JSON.parse(await readFile(this.file(id), 'utf8')) as GameRecord;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  }

  async delete(id: string): Promise<boolean> {
    const file = this.file(id);
    const existed = (await this.load(id)) !== null;
    await rm(file, { force: true });
    return existed;
  }

  /** Kõik mängud, uuemad eespool. */
  async list(): Promise<GameSummary[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw e;
    }
    const summaries: GameSummary[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const id = name.slice(0, -'.json'.length);
      if (!ID_RE.test(id)) continue;
      const record = await this.load(id);
      if (!record) continue;
      const summary: GameSummary = { id, meta: record.meta, moveCount: record.moves.length, result: record.result };
      if (record.endedAt) summary.endedAt = record.endedAt;
      summaries.push(summary);
    }
    return summaries.sort((a, b) => b.meta.startedAt.localeCompare(a.meta.startedAt));
  }
}
