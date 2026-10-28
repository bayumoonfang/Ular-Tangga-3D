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
}

export interface RoomSettings {
  boardPreset: BoardPresetId;
  options: RuleOptions;
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
  | { t: 'settings'; boardPreset?: BoardPresetId; options?: Partial<RuleOptions> } // host saja
  | { t: 'start_game' } // host saja
  | { t: 'charge_start' }
  | { t: 'roll' }
  | { t: 'emote'; id: string } // id ekspresi (EXPRESSIONS)
  | { t: 'sync' } // minta snapshot terbaru (mis. setelah tab lama di latar belakang)
  | { t: 'back_to_lobby' }
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
    }
  | { t: 'emote'; playerId: string; name: string; spectator: boolean; id: ExpressionId }
  | { t: 'error'; message: string; code?: string }; // code: rejoin_failed | room_closed

/** Perkiraan lama animasi satu giliran (ms) — server memberi tambahan waktu sebelum batas giliran berikutnya. */
export function estimateAnimationMs(steps: number, jump: 'ladder' | 'snake' | null): number {
  return 2400 + steps * 330 + (jump === 'ladder' ? 2600 : jump === 'snake' ? 4200 : 0);
}
