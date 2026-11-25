/**
 * Mida laud näitab: LED-riba käsud ja LCD tekst.
 *
 * LED-riba on üks 160 LED-iga tükk, mis käib ridade kaupa edasi-tagasi (rida 1 vasakult
 * paremale, rida 2 paremalt vasakule jne). Iga tumeda ruudu all on üks LED.
 * LCD on 16 × 2 märki (HD44780), mis täpitähti ei oska, seega need asendatakse.
 */
import { rankOf, squareName, type Square } from '../game/squares.js';

export const LED_COUNT = 160;
export const LCD_COLUMNS = 16;

/** Ruudu LED-i number ribal (vt elec.json: a1 → 0, c1 → 4, h2 → 21, …, b8 → 159). */
export function ledIndex(sq: Square): number {
  const rank = rankOf(sq);
  const k = sq % 4;
  return 21 * rank + 4 * (rank % 2 === 0 ? k : 3 - k);
}

export type LedMode = 'solid' | 'blink' | 'pulse';

export interface LedCommand {
  square: string;
  led: number;
  /** Värv kujul "RRGGBB". */
  color: string;
  mode: LedMode;
}

/** Terve laua efektid, mida püsivara joonistab ise. */
export type BoardEffect = 'none' | 'idle' | 'win-white' | 'win-black' | 'draw';

export interface BoardDisplay {
  /** Kaks LCD rida, kumbki täpselt 16 märki. */
  lcd: [string, string];
  leds: LedCommand[];
  effect: BoardEffect;
  /** Muutub ainult siis, kui ekraanil või LED-idel midagi muutub (laud joonistab siis uuesti). */
  seq: string;
}

export const COLORS = {
  from: 'FFB000', // käigu algus (kollane)
  path: '0050FF', // löömise vahepealne ruut (sinine)
  to: '00C040', // käigu lõpp ja võimalikud sihtruudud (roheline)
  capture: 'FF0000', // löödav nupp (punane)
  forced: 'FF6000', // nupp, mis peab lööma (oranž)
  missing: 'FF0000', // siia on vaja nuppu (punane)
  extra: 'B000FF', // siit tuleb nupp ära võtta (lilla)
  hint: '00E0FF', // vihje (helesinine)
  lifted: 'FFFFFF', // tõstetud nupu ruut (valge)
} as const;

export function led(sq: Square, color: string, mode: LedMode = 'solid'): LedCommand {
  return { square: squareName(sq), led: ledIndex(sq), color, mode };
}

const LCD_REPLACEMENTS: Record<string, string> = {
  ä: 'a', ö: 'o', õ: 'o', ü: 'u', š: 's', ž: 'z',
  Ä: 'A', Ö: 'O', Õ: 'O', Ü: 'U', Š: 'S', Ž: 'Z',
};

/** Teeb teksti LCD jaoks sobivaks: ainult ASCII, täpselt 16 märki. */
export function lcdLine(text: string): string {
  const ascii = [...text]
    .map((ch) => LCD_REPLACEMENTS[ch] ?? ch)
    .join('')
    .replace(/[^\x20-\x7e]/g, '?');
  return ascii.slice(0, LCD_COLUMNS).padEnd(LCD_COLUMNS, ' ');
}

/** Ühendab LED-käsud: hilisem käsk samale ruudule kirjutab eelmise üle. */
export function mergeLeds(...groups: LedCommand[][]): LedCommand[] {
  const byLed = new Map<number, LedCommand>();
  for (const group of groups) for (const cmd of group) byLed.set(cmd.led, cmd);
  return [...byLed.values()].sort((a, b) => a.led - b.led);
}

export function makeDisplay(lines: [string, string], leds: LedCommand[], effect: BoardEffect = 'none'): BoardDisplay {
  const lcd: [string, string] = [lcdLine(lines[0]), lcdLine(lines[1])];
  const sorted = mergeLeds(leds);
  const key = JSON.stringify([lcd, sorted, effect]);
  return { lcd, leds: sorted, effect, seq: hash(key) };
}

/** Lühike FNV-1a räsi. */
function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
