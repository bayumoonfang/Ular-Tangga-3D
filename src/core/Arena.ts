import { TILE_COUNT, type BoardMap } from '../config';
import { tileToGrid } from './Rules';

// Catatan: dipakai bersama oleh client, server, dan unit test — jangan impor three.js / DOM di sini.

/** Mode Arena (multiplayer): darah (HP) + item serang/bertahan/pulih yang tersebar di papan. */

export const ARENA_HP = 100;
/** slot tas tiap pemain; tas penuh = item di petak tidak bisa diambil */
export const BAG_SIZE = 3;
/** jumlah item yang tersebar di papan */
export const BOARD_ITEMS = 8;
/** item yang diambil muncul kembali (item & petak acak) setelah ini (ms) */
export const ITEM_RESPAWN_MS = 15_000;
/** jarak minimal antar petak item: nomor petak & jarak kotak di grid (tidak boleh mepet) */
export const ITEM_MIN_GAP = 6;
export const ITEM_MIN_GRID = 2;
/** pion yang darahnya habis kembali ke petak ini */
export const KO_TILE = 1;
/** perisai = meter daya tahan: menyerap damage tiap serangan sampai habis */
export const SHIELD_MAX = 100;
/** daya tahan yang ditambahkan satu item perisai (juga modal awal) */
export const SHIELD_PER_ITEM = 60;

export type ItemKind = 'attack' | 'guard' | 'heal';
/**
 * Gaya serangan di papan 3D & SFX: melee = penyerang menerjang; lob = dilempar melengkung tinggi;
 * straight = melesat lurus; spin = berputar melengkung; flame = semburan api; rocket = meluncur
 * berjejak api; zap = petir dari langit; meteor = jatuh dari langit.
 */
export type AttackFx = 'melee' | 'lob' | 'straight' | 'spin' | 'flame' | 'rocket' | 'zap' | 'meteor';

export interface ItemDef {
  emoji: string;
  kind: ItemKind;
  /** bobot peluang muncul di papan */
  weight: number;
  /** pengurang HP lawan (serangan) */
  damage?: number;
  /** jarak serang maksimal (selisih nomor petak) */
  range?: number;
  /** jarak serang minimal (default 1) */
  minRange?: number;
  /** HP yang dipulihkan */
  heal?: number;
  /** gaya animasi & suara serangan */
  fx?: AttackFx;
  /** menembus perisai (damage langsung ke darah) */
  pierce?: boolean;
}

export const ITEMS = {
  // serang — jarak = selisih nomor petak (petak yang sama & Start tidak berlaku)
  punch: { emoji: '🥊', kind: 'attack', weight: 4, damage: 20, range: 1, fx: 'melee' },
  hammer: { emoji: '🔨', kind: 'attack', weight: 2, damage: 35, range: 1, fx: 'melee' },
  flame: { emoji: '🔥', kind: 'attack', weight: 2, damage: 30, range: 2, fx: 'flame' },
  dynamite: { emoji: '🧨', kind: 'attack', weight: 1, damage: 50, range: 2, fx: 'lob' },
  bomb: { emoji: '💣', kind: 'attack', weight: 3, damage: 40, range: 3, fx: 'lob' },
  boomerang: { emoji: '🪃', kind: 'attack', weight: 2, damage: 25, range: 4, fx: 'spin' },
  snowball: { emoji: '❄️', kind: 'attack', weight: 3, damage: 15, range: 5, fx: 'lob' },
  arrow: { emoji: '🏹', kind: 'attack', weight: 3, damage: 25, range: 6, fx: 'straight' },
  lightning: { emoji: '⚡', kind: 'attack', weight: 1, damage: 20, range: 8, fx: 'zap', pierce: true },
  rocket: { emoji: '🚀', kind: 'attack', weight: 2, damage: 30, range: 12, minRange: 2, fx: 'rocket' },
  meteor: { emoji: '☄️', kind: 'attack', weight: 1, damage: 45, range: 25, minRange: 5, fx: 'meteor' },
  // bertahan
  shield: { emoji: '🛡️', kind: 'guard', weight: 4 },
  mirror: { emoji: '🪞', kind: 'guard', weight: 1 },
  // pulih
  apple: { emoji: '🍎', kind: 'heal', weight: 2, heal: 20 },
  potion: { emoji: '🧪', kind: 'heal', weight: 2, heal: 40 },
} as const satisfies Record<string, ItemDef>;

export type ItemId = keyof typeof ITEMS;
export const ITEM_IDS = Object.keys(ITEMS) as ItemId[];
/** item serang (dipakai untuk modal awal acak) */
export const ATTACK_ITEMS = ITEM_IDS.filter((id) => ITEMS[id].kind === 'attack');

export function isItem(id: string): id is ItemId {
  return id in ITEMS;
}

export interface TileItem {
  tile: number;
  item: ItemId;
}

/** State arena — dikirim server ke semua anggota room. */
export interface ArenaInfo {
  hp: Record<string, number>;
  /** daya tahan perisai tiap pemain (0 = tanpa perisai) */
  shield: Record<string, number>;
  /** isi tas tiap pemain (maks BAG_SIZE, urut sesuai waktu diambil) */
  bags: Record<string, ItemId[]>;
  tileItems: TileItem[];
  /** ms sampai item yang sudah diambil muncul kembali (satu angka per item) */
  respawnIn: number[];
}

export type ArenaEvent =
  | {
      kind: 'attack';
      playerId: string;
      targetId: string;
      item: ItemId;
      /** hit = mengenai sasaran; reflected = dipantulkan cermin sasaran ke penyerang */
      outcome: 'hit' | 'reflected';
      /** yang terkena (sasaran, atau penyerang bila dipantulkan) */
      victimId: string;
      /** damage yang diserap perisai si terkena */
      absorbed: number;
      /** damage yang mengurangi darah */
      damage: number;
      /** perisai si terkena habis pada serangan ini */
      shieldBroken: boolean;
      /** pemain yang darahnya habis dan kembali ke petak 1 */
      ko: string | null;
    }
  | { kind: 'heal'; playerId: string; item: ItemId; amount: number }
  | { kind: 'spawn'; tile: number; item: ItemId };

/** Rentang jarak serang item (selisih nomor petak). */
export function itemRange(item: ItemId): { min: number; max: number } {
  const def: ItemDef = ITEMS[item];
  return { min: def.minRange ?? 1, max: def.range ?? 0 };
}

export function itemFx(item: ItemId): AttackFx {
  return (ITEMS[item] as ItemDef).fx ?? 'straight';
}

/** Serangan berat (damage besar): ledakan lebih besar & guncangan layar. */
export function itemHeavy(item: ItemId): boolean {
  return ((ITEMS[item] as ItemDef).damage ?? 0) >= 30;
}

export function itemPierces(item: ItemId): boolean {
  return !!(ITEMS[item] as ItemDef).pierce;
}

/**
 * Jangkauan serangan: selisih nomor petak antara `min` dan `max` (bawaan: tepat di sebelah kiri /
 * kanan). Petak yang sama dan Start (0) tidak berlaku.
 */
export function inReach(a: number, b: number, max = 1, min = 1): boolean {
  if (a <= 0 || b <= 0) return false;
  const d = Math.abs(a - b);
  return d >= Math.max(1, min) && d <= max;
}

/** Serangan mengenai darah setelah perisai menyerap sebanyak daya tahannya. */
export function absorbDamage(shield: number, damage: number): { absorbed: number; damage: number; shieldLeft: number } {
  const absorbed = Math.min(shield, damage);
  return { absorbed, damage: damage - absorbed, shieldLeft: shield - absorbed };
}

function gridDistance(a: number, b: number): number {
  const ga = tileToGrid(a);
  const gb = tileToGrid(b);
  return Math.max(Math.abs(ga.row - gb.row), Math.abs(ga.col - gb.col));
}

type Rng = { int(a: number, b: number): number };

/** Item acak sesuai bobot. */
export function randomItem(rng: Rng): ItemId {
  const total = ITEM_IDS.reduce((s, id) => s + ITEMS[id].weight, 0);
  let r = rng.int(1, total);
  for (const id of ITEM_IDS) {
    r -= ITEMS[id].weight;
    if (r <= 0) return id;
  }
  return ITEM_IDS[0];
}

/** Modal awal: satu senjata serang acak (sesuai bobot) — perisai diberikan terpisah sebagai daya tahan. */
export function randomAttackItem(rng: Rng): ItemId {
  const total = ATTACK_ITEMS.reduce((n, id) => n + ITEMS[id].weight, 0);
  let r = rng.int(1, total);
  for (const id of ATTACK_ITEMS) {
    r -= ITEMS[id].weight;
    if (r <= 0) return id;
  }
  return ATTACK_ITEMS[0];
}

/**
 * Taruh `count` item acak di petak acak: bukan petak 1/100, bukan kaki tangga / kepala ular, bukan
 * petak berpion, dan berjauhan dari item lain (beda nomor ≥ ITEM_MIN_GAP, jarak grid ≥ ITEM_MIN_GRID).
 * `existing` = item yang sudah ada di papan (ikut dijaga jaraknya, tidak dikembalikan).
 */
export function spawnItems(rng: Rng, board: BoardMap, occupied: number[], existing: TileItem[] = [], count = BOARD_ITEMS): TileItem[] {
  const blocked = new Set<number>([1, TILE_COUNT, ...occupied]);
  for (const k of Object.keys(board.ladders)) blocked.add(Number(k));
  for (const k of Object.keys(board.snakes)) blocked.add(Number(k));
  const candidates: number[] = [];
  for (let t = 2; t < TILE_COUNT; t++) if (!blocked.has(t)) candidates.push(t);
  // acak (Fisher–Yates)
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }
  const placed = existing.map((e) => e.tile);
  const out: TileItem[] = [];
  for (const t of candidates) {
    if (out.length >= count) break;
    if (placed.some((p) => Math.abs(p - t) < ITEM_MIN_GAP || gridDistance(p, t) < ITEM_MIN_GRID)) continue;
    placed.push(t);
    out.push({ tile: t, item: randomItem(rng) });
  }
  return out;
}
