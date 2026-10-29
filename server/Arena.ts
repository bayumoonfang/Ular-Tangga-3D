import { randomInt } from 'node:crypto';
import {
  ARENA_HP,
  BAG_SIZE,
  ITEM_RESPAWN_MS,
  ITEMS,
  KO_TILE,
  SHIELD_MAX,
  SHIELD_PER_ITEM,
  absorbDamage,
  inReach,
  isItem,
  itemPierces,
  itemRange,
  randomAttackItem,
  spawnItems,
  type ArenaEvent,
  type ArenaInfo,
  type ItemId,
  type TileItem,
} from '../src/core/Arena';
import type { GameState } from '../src/core/GameState';
import type { ServerMsg } from '../src/network/protocol';
import { RoomError } from './RoomError';

const rng = { int: (a: number, b: number) => randomInt(a, b + 1) };

interface Hooks {
  state(): GameState | null;
  broadcast(msg: ServerMsg): void;
  system(text: string): void;
  name(id: string): string;
  /** pengali waktu (uji otomatis memakai nilai kecil) */
  ms(v: number): number;
  /** pemain ini sedang mendapat giliran dan belum melempar (boleh menyerang) */
  canAct(id: string): boolean;
}

/**
 * Mode Arena di satu room (server authoritative): darah (HP), perisai (meter daya tahan yang selalu
 * aktif), tas item (maks 3 slot), item acak di papan yang muncul kembali 15 dtk setelah diambil, dan
 * serangan dengan jarak sesuai item.
 */
export class RoomArena {
  private hp: Record<string, number> = {};
  private shield: Record<string, number> = {};
  private bags: Record<string, ItemId[]> = {};
  private tileItems: TileItem[] = [];
  /** item yang menunggu muncul kembali */
  private respawns: { at: number; timer: NodeJS.Timeout }[] = [];
  /** satu serangan per lemparan: nomor `turn` saat pemain terakhir menyerang */
  private attackedTurn = new Map<string, number>();

  constructor(private hooks: Hooks) {}

  start(playerIds: string[]): void {
    for (const id of playerIds) this.addPlayer(id);
    const s = this.hooks.state();
    if (s) this.tileItems = spawnItems(rng, s.board, s.players.map((p) => p.position));
  }

  /** Pemain baru (termasuk yang mengisi slot kosong di tengah permainan) mendapat modal awal. */
  addPlayer(id: string): void {
    this.hp[id] = ARENA_HP;
    this.shield[id] = SHIELD_PER_ITEM;
    // modal awal: 1 senjata serang acak + 1 perisai
    this.bags[id] = [randomAttackItem(rng)];
  }

  removePlayer(id: string): void {
    delete this.hp[id];
    delete this.shield[id];
    delete this.bags[id];
    this.attackedTurn.delete(id);
  }

  info(): ArenaInfo {
    const now = Date.now();
    return {
      hp: { ...this.hp },
      shield: { ...this.shield },
      bags: Object.fromEntries(Object.entries(this.bags).map(([k, v]) => [k, [...v]])),
      tileItems: this.tileItems.map((c) => ({ ...c })),
      respawnIn: this.respawns.map((r) => Math.max(0, r.at - now)).sort((a, b) => a - b),
    };
  }

  broadcastInfo(): void {
    this.hooks.broadcast({ t: 'arena', arena: this.info() });
  }

  private event(ev: ArenaEvent): void {
    this.hooks.broadcast({ t: 'arena_event', ev });
  }

  /**
   * Pion berhenti di petak ber-item: item masuk tas bila masih ada slot kosong (tas penuh = item
   * tetap di papan). Perisai tidak memakai slot: langsung menambah daya tahan perisai. Item yang
   * diambil muncul kembali — item & petak acak — setelah 15 dtk.
   */
  pickup(id: string, tile: number): TileItem | null {
    const idx = this.tileItems.findIndex((c) => c.tile === tile);
    const bag = this.bags[id];
    if (idx < 0 || !bag) return null;
    const item = this.tileItems[idx].item;
    if (item !== 'shield' && bag.length >= BAG_SIZE) return null;
    const [got] = this.tileItems.splice(idx, 1);
    if (item === 'shield') this.shield[id] = Math.min(SHIELD_MAX, this.shield[id] + SHIELD_PER_ITEM);
    else bag.push(got.item);
    this.scheduleRespawn();
    return got;
  }

  private scheduleRespawn(): void {
    const wait = this.hooks.ms(ITEM_RESPAWN_MS);
    const entry = { at: Date.now() + wait, timer: setTimeout(() => this.respawn(entry), wait) };
    this.respawns.push(entry);
  }

  private respawn(entry: { at: number; timer: NodeJS.Timeout }): void {
    this.respawns = this.respawns.filter((r) => r !== entry);
    const s = this.hooks.state();
    if (!s) return;
    const [spawned] = spawnItems(rng, s.board, s.players.map((p) => p.position), this.tileItems, 1);
    if (!spawned) {
      // papan terlalu penuh untuk menjaga jarak: coba lagi nanti
      this.scheduleRespawn();
      this.broadcastInfo();
      return;
    }
    this.tileItems.push(spawned);
    this.event({ kind: 'spawn', tile: spawned.tile, item: spawned.item });
    this.broadcastInfo();
  }

  /** Pakai item dari tas: serangan hanya pada giliran sendiri sebelum melempar & ke lawan tepat di sebelah. */
  use(id: string, raw: string, targetId: string | undefined): void {
    if (!isItem(raw)) throw new RoomError('Item tidak dikenal.');
    const s = this.hooks.state();
    const bag = this.bags[id];
    if (!s || !bag) throw new RoomError('Kamu tidak sedang bermain.');
    if (!bag.includes(raw)) throw new RoomError('Item itu tidak ada di tasmu.');
    const def = ITEMS[raw];
    if (def.kind === 'guard') throw new RoomError('Cermin aktif otomatis saat kamu diserang.');

    if (def.kind === 'heal') {
      if (this.hp[id] >= ARENA_HP) throw new RoomError('Darahmu masih penuh.');
      const amount = Math.min(def.heal, ARENA_HP - this.hp[id]);
      this.take(id, raw);
      this.hp[id] += amount;
      this.event({ kind: 'heal', playerId: id, item: raw, amount });
      this.broadcastInfo();
      return;
    }

    // serangan
    if (!this.hooks.canAct(id)) throw new RoomError('Serangan hanya bisa saat giliranmu, sebelum melempar dadu.');
    if (this.attackedTurn.get(id) === s.turn) throw new RoomError('Satu serangan per giliran.');
    const me = s.players.find((p) => p.id === id);
    const target = s.players.find((p) => p.id === targetId);
    if (!me || !target || target.id === id || !this.bags[target.id]) throw new RoomError('Pilih lawan yang mau diserang.');
    const range = itemRange(raw);
    if (!inReach(me.position, target.position, range.max, range.min)) {
      const r = range.min > 1 ? `${range.min}–${range.max}` : String(range.max);
      throw new RoomError(`Lawan di luar jangkauan ${def.emoji} (jarak ${r} petak).`);
    }

    this.take(id, raw);
    this.attackedTurn.set(id, s.turn);
    // cermin sasaran memantulkan serangan ke penyerang (sekali pakai)
    const mirrored = this.bags[target.id].includes('mirror');
    if (mirrored) this.take(target.id, 'mirror');
    const victim = mirrored ? me : target;
    // perisai selalu aktif: menyerap damage sampai daya tahannya habis, sisanya mengenai darah
    // (petir menembus perisai)
    const hadShield = this.shield[victim.id] > 0;
    const hit = itemPierces(raw) ? { absorbed: 0, damage: def.damage, shieldLeft: this.shield[victim.id] } : absorbDamage(this.shield[victim.id], def.damage);
    this.shield[victim.id] = hit.shieldLeft;
    this.hp[victim.id] -= hit.damage;
    let ko: string | null = null;
    if (this.hp[victim.id] <= 0) {
      // darah habis: kembali ke petak 1 dengan darah penuh
      ko = victim.id;
      this.hp[victim.id] = ARENA_HP;
      victim.position = KO_TILE;
    }
    const ev: Extract<ArenaEvent, { kind: 'attack' }> = {
      kind: 'attack',
      playerId: id,
      targetId: target.id,
      item: raw,
      outcome: mirrored ? 'reflected' : 'hit',
      victimId: victim.id,
      absorbed: hit.absorbed,
      damage: hit.damage,
      shieldBroken: hadShield && hit.shieldLeft === 0,
      ko,
    };
    this.event(ev);
    this.hooks.system(this.describe(ev));
    this.broadcastInfo();
  }

  /** Item keluar dari tas (slotnya kosong lagi untuk item baru). */
  private take(id: string, item: ItemId): void {
    const bag = this.bags[id];
    const i = bag.indexOf(item);
    if (i >= 0) bag.splice(i, 1);
  }

  private describe(ev: Extract<ArenaEvent, { kind: 'attack' }>): string {
    const a = this.hooks.name(ev.playerId);
    const b = this.hooks.name(ev.targetId);
    const e = ITEMS[ev.item].emoji;
    let text = ev.outcome === 'reflected' ? `${e} ${a} menyerang ${b}, dipantulkan 🪞 ke ${a}` : `${e} ${a} menyerang ${b}`;
    const parts: string[] = [];
    if (ev.absorbed) parts.push(`🛡️ menahan ${ev.absorbed}`);
    if (ev.damage) parts.push(`−${ev.damage} darah`);
    if (parts.length) text += ` (${parts.join(', ')})`;
    if (ev.shieldBroken) text += ' — perisai hancur!';
    if (ev.ko) text += ` — ${this.hooks.name(ev.ko)} K.O., kembali ke petak ${KO_TILE}!`;
    return text;
  }

  stop(): void {
    this.respawns.forEach((r) => clearTimeout(r.timer));
    this.respawns = [];
  }
}
