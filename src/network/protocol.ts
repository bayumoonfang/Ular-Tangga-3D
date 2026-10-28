import type { BoardPresetId } from '../config';
import type { GameState } from '../core/GameState';
import type { RuleOptions } from '../core/Rules';

// Catatan: dipakai bersama oleh client dan server — jangan impor three.js / DOM di sini.

export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 4;
export const ROOM_CODE_LENGTH = 6;
/** huruf/angka yang tidak membingungkan (tanpa 0/O, 1/I/L) */
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const NAME_MAX = 14;
/** batas waktu memutuskan lemparan sebelum otomatis dilemparkan server (detik) */
export const TURN_SECONDS = 25;
/** penonton per room */
export const MAX_SPECTATORS = 100;
export const CHAT_MAX = 200;
/** pesan chat terakhir yang disimpan server dan dikirim ke anggota yang baru masuk */
export const CHAT_HISTORY = 50;

/** Ekspresi (emote + SFX) — urutan juga menentukan pintasan keyboard 1–8. */
export const EXPRESSIONS = [
  { id: 'clap', emoji: '👏' },
  { id: 'laugh', emoji: '😂' },
  { id: 'scream', emoji: '😱' },
  { id: 'cheer', emoji: '🎉' },
  { id: 'wow', emoji: '😮' },
  { id: 'boo', emoji: '👎' },
  { id: 'cry', emoji: '😭' },
  { id: 'love', emoji: '😍' },
] as const;
export type ExpressionId = (typeof EXPRESSIONS)[number]['id'];

export function isExpression(id: string): id is ExpressionId {
  return EXPRESSIONS.some((e) => e.id === id);
}

export function expressionEmoji(id: string): string {
  return EXPRESSIONS.find((e) => e.id === id)?.emoji ?? '❓';
}

export type Role = 'player' | 'spectator';

export interface ChatMsg {
  id: number;
  /** id pengirim (kosong untuk pesan sistem) */
  from: string;
  name: string;
  role: Role | 'system';
  /** warna pemain (hanya pemain) */
  color?: number;
  text: string;
  at: number;
}

/** Ringkasan room yang sedang bermain, untuk daftar "Live sekarang". */
export interface LiveRoom {
  code: string;
  players: { name: string; character: string; color: number; position: number }[];
  viewers: number;
  turn: number;
  /** slot kosong yang bisa diisi (pemain baru mulai dari Start) */
  openSlots: number;
}

export interface RoomSettings {
  boardPreset: BoardPresetId;
  options: RuleOptions;
  /** pemain yang berhenti di petak yang sama bertarung (duel panah ala Ayo Dance); kalah = kembali ke Start */
  fight: boolean;
}

// ───────────────────────── Duel (fight) ─────────────────────────

export const ARROWS = ['up', 'down', 'left', 'right'] as const;
export type Arrow = (typeof ARROWS)[number];
/** penilaian satu ronde: ketepatan menekan Spasi saat kursor ketukan melewati zona */
export const GRADES = ['perfect', 'great', 'cool', 'bad', 'miss'] as const;
export type Grade = (typeof GRADES)[number];

export const FIGHT_HP = 100;
/** jumlah panah per ronde — ronde berikutnya makin panjang */
export const FIGHT_ROUND_ARROWS = [4, 5, 5, 6, 7, 8] as const;
/** hitung mundur sebelum ronde pertama (ms) */
export const FIGHT_COUNTDOWN_MS = 3500;
/** lama kursor ketukan berjalan dari kiri ke kanan bar (ms) */
export const FIGHT_BEAT_MS = 3200;
/** jeda antar ronde untuk menampilkan hasil (ms) */
export const FIGHT_GAP_MS = 700;
export const FIGHT_ROUND_MS = FIGHT_BEAT_MS + FIGHT_GAP_MS;
/** posisi tengah zona tepat pada bar ketukan (0..1) */
export const FIGHT_HIT_AT = 0.85;
/** batas selisih kursor dari tengah zona (fraksi bar) untuk tiap penilaian; di luar itu = miss */
export const FIGHT_WINDOWS: [Grade, number][] = [
  ['perfect', 0.025],
  ['great', 0.05],
  ['cool', 0.085],
  ['bad', 0.13],
];
const GRADE_MULT: Record<Grade, number> = { perfect: 1.5, great: 1.2, cool: 1, bad: 0.5, miss: 0 };

export function isGrade(g: string): g is Grade {
  return (GRADES as readonly string[]).includes(g);
}

/** Penilaian dari posisi kursor (0..1) saat Spasi ditekan. */
export function judgeBeat(cursor: number): Grade {
  const d = Math.abs(cursor - FIGHT_HIT_AT);
  return FIGHT_WINDOWS.find(([, w]) => d <= w)?.[0] ?? 'miss';
}

/**
 * Damage satu serangan. Miss = tidak menyerang. Combo = jumlah ronde beruntun tanpa miss
 * (termasuk ronde ini); tiap combo menambah 10% damage, maksimal +50%.
 */
export function fightDamage(arrows: number, grade: Grade, combo: number): number {
  if (grade === 'miss') return 0;
  const comboMult = 1 + 0.1 * Math.min(Math.max(combo - 1, 0), 5);
  return Math.round((10 + arrows * 2) * GRADE_MULT[grade] * comboMult);
}

export interface FightInfo {
  id: number;
  tile: number;
  /** pendatang lebih dulu, lalu penghuni petak */
  fighters: string[];
  hp: Record<string, number>;
  combo: Record<string, number>;
  rounds: Arrow[][];
  /** ms sampai ronde pertama dimulai (negatif = sudah berjalan, untuk yang masuk di tengah duel) */
  startsIn: number;
}

export interface RoomPlayerInfo {
  id: string;
  name: string;
  character: string;
  color: number;
  ready: boolean;
  connected: boolean;
  isHost: boolean;
}

export type RoomPhase = 'lobby' | 'playing' | 'finished';

export interface RoomInfo {
  code: string;
  phase: RoomPhase;
  hostId: string;
  players: RoomPlayerInfo[];
  settings: RoomSettings;
  /** nama penonton yang sedang tersambung */
  viewers: string[];
  /** saat bermain: slot yang ditinggalkan (keluar / di-kick) dan bisa diisi pemain baru */
  openSlots: number;
  /** saat bermain: pemain kurang dari 2, giliran berhenti sampai ada yang bergabung */
  waiting: boolean;
}

/** Ringkasan state setelah satu lemparan — dipakai client untuk memverifikasi simulasinya sendiri. */
export interface TurnSnapshot {
  positions: number[];
  current: number;
  consecutiveSixes: number;
  turn: number;
  winnerId: string | null;
  ranking: string[];
}

// Client -> Server
export type ClientMsg =
  | { t: 'create_room'; name: string; character: string }
  | { t: 'join_room'; code: string; name: string; character: string }
  | { t: 'rejoin'; code: string; token: string }
  | { t: 'spectate'; code: string; name: string } // masuk sebagai penonton (nama wajib)
  | { t: 'list_live' }
  | { t: 'chat'; text: string }
  | { t: 'set_character'; character: string }
  | { t: 'ready'; ready: boolean }
  | { t: 'settings'; boardPreset?: BoardPresetId; options?: Partial<RuleOptions>; fight?: boolean } // host saja
  | { t: 'start_game' } // host saja
  | { t: 'charge_start' }
  | { t: 'roll' }
  | { t: 'emote'; id: string } // id ekspresi (EXPRESSIONS)
  | { t: 'sync' } // minta snapshot terbaru (mis. setelah tab lama di latar belakang)
  | { t: 'back_to_lobby' }
  | { t: 'kick'; playerId: string } // host saja
  | { t: 'fight_input'; id: number; round: number; grade: Grade }
  | { t: 'fight_progress'; id: number; round: number; typed: number; wrong?: boolean } // ketikan panah, disiarkan live
  | { t: 'leave' };

// Server -> Client
export type ServerMsg =
  | { t: 'joined'; room: RoomInfo; you: string; token: string; role: Role; name: string }
  | { t: 'room_state'; room: RoomInfo }
  | { t: 'live_list'; rooms: LiveRoom[] }
  | { t: 'chat'; msg: ChatMsg }
  | { t: 'chat_history'; msgs: ChatMsg[] }
  | { t: 'left' }
  | { t: 'game_start'; state: GameState; seq: number }
  | { t: 'game_snapshot'; state: GameState; seq: number }
  | { t: 'turn'; playerId: string; deadline: number }
  | {
      t: 'turn_result';
      seq: number;
      playerId: string;
      value: number;
      boost: boolean;
      after: TurnSnapshot;
      /** pion berhenti di petak yang ditempati pemain lain: duel menyusul setelah animasi */
      fight?: boolean;
    }
  | { t: 'fight_start'; fight: FightInfo }
  | {
      t: 'fight_hit';
      id: number;
      playerId: string;
      round: number;
      grade: Grade;
      damage: number;
      combo: number;
      hp: Record<string, number>;
    }
  | {
      t: 'fight_progress';
      id: number;
      playerId: string;
      round: number;
      /** jumlah panah yang sudah benar pada ronde ini */
      typed: number;
      /** baru saja salah panah (urutan diulang) */
      wrong: boolean;
    }
  | { t: 'fight_end'; id: number; winnerId: string | null; losers: string[] } // yang kalah kembali ke Start (petak 0)
  | { t: 'kicked' }
  | { t: 'emote'; playerId: string; name: string; spectator: boolean; id: ExpressionId }
  | { t: 'error'; message: string; code?: string }; // code: rejoin_failed | room_closed

/** Perkiraan lama animasi satu giliran (ms) — server memberi tambahan waktu sebelum batas giliran berikutnya. */
export function estimateAnimationMs(steps: number, jump: 'ladder' | 'snake' | null): number {
  return 2400 + steps * 330 + (jump === 'ladder' ? 2600 : jump === 'snake' ? 4200 : 0);
}
