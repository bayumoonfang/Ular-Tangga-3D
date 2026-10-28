import type { ExpressionId, RoomInfo } from '../network/protocol';
import type { Phase } from './StateMachine';

export interface GameEvents {
  'game:start': { playerIds: string[] };
  'game:exit': Record<string, never>;
  phase: { from: Phase; to: Phase };
  'turn:start': { playerId: string; index: number; isBot: boolean; mine: boolean };
  'turn:deadline': { playerId: string; deadline: number };
  'net:room': { room: RoomInfo };
  'dice:throw': { playerId: string };
  'dice:land': { value: number };
  'dice:rolled': { playerId: string; value: number };
  'move:step': { playerId: string; tile: number; stepIndex: number; total: number };
  'move:bounce': { playerId: string; at: number };
  'ladder:climb': { playerId: string; from: number; to: number; duration: number };
  'snake:bite': { playerId: string; from: number; to: number; duration: number };
  'charge:start': Record<string, never>;
  'charge:update': { power: number };
  'charge:end': { power: number; perfect: boolean; overheated: boolean };
  'dice:boost': { playerId: string };
  'bonus:six': { playerId: string; count: number };
  'turn:forfeit': { playerId: string };
  'game:win': { playerId: string; ranking: string[] };
  pause: { paused: boolean };
  'ui:banner': { text: string; kind?: 'info' | 'bonus' | 'bad' };
  /** minor = baris rutin (hasil lemparan) yang tidak perlu masuk umpan chat online */
  'ui:log': { text: string; minor?: boolean };
  /** ekspresi (emote + SFX) dari pemain atau penonton */
  expression: { playerId: string; name: string; spectator: boolean; id: ExpressionId };
}

type Handler<K extends keyof GameEvents> = (payload: GameEvents[K]) => void;

/** Pub/sub bertipe antar modul. Lapisan visual/audio/UI hanya mendengarkan. */
export class EventBus {
  private handlers = new Map<keyof GameEvents, Set<Handler<keyof GameEvents>>>();

  on<K extends keyof GameEvents>(event: K, fn: Handler<K>): () => void {
    let set = this.handlers.get(event);
    if (!set) this.handlers.set(event, (set = new Set()));
    const h = fn as Handler<keyof GameEvents>;
    set.add(h);
    return () => set.delete(h);
  }

  emit<K extends keyof GameEvents>(event: K, payload: GameEvents[K]): void {
    this.handlers.get(event)?.forEach((fn) => (fn as Handler<K>)(payload));
  }
}
