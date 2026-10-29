import gsap from 'gsap';
import { BOARD_PRESETS, CHARACTERS, PERSONALITIES, PLAYER_COLORS, TILE_COUNT, type BoardPresetId } from '../config';
import type { AudioManager } from '../audio/AudioManager';
import { t } from '../i18n';
import { AIController, type ReactionEvent } from '../players/AIController';
import { HumanController, type RollInput } from '../players/HumanController';
import type { NetworkClient } from '../network/NetworkClient';
import { expressionEmoji, type ExpressionId, type ServerMsg } from '../network/protocol';
import type { SceneManager } from '../scene/SceneManager';
import type { Stage } from '../scene/Stage';
import { createRng, randomSeed, type Rng } from '../utils/random';
import { settings } from '../utils/settings';
import { ARENA_HP, BAG_SIZE, ITEMS, KO_TILE, SHIELD_PER_ITEM, canHit, itemFx, itemHeavy, type ArenaEvent, type ArenaInfo, type AttackFx, type ItemId, type TileItem } from './Arena';
import { EventBus } from './EventBus';
import { createInitialState, currentPlayer, type GameState, type PlayerState } from './GameState';
import { StateMachine } from './StateMachine';
import { applyRoll, generateRandomBoard, rollDie, type RuleOptions } from './Rules';

export interface GameConfig {
  playerName: string;
  characterId: string;
  botCount: number;
  boardPreset: BoardPresetId;
  options: RuleOptions;
}

export interface SaveData {
  config: GameConfig;
  state: GameState;
}

const SAVE_KEY = 'sl3d.save';
/** hanya dev: ?speed=4 mempercepat seluruh animasi untuk pengujian */
const DEV_SPEED = import.meta.env.DEV ? Number(new URLSearchParams(location.search).get('speed')) || 1 : 1;

class Cancelled extends Error {}

/** teks komik saat serangan mengenai, sesuai gayanya */
const IMPACT_WORDS: Record<AttackFx, string> = {
  melee: 'POW!',
  lob: 'BOOM!',
  straight: 'THWACK!',
  spin: 'WHAM!',
  flame: 'FWOOSH!',
  rocket: 'KABOOM!',
  zap: 'ZZZAP!',
  meteor: 'KA-BLAM!',
};

type TurnResult = Extract<ServerMsg, { t: 'turn_result' }>;
type FightEnd = Extract<ServerMsg, { t: 'fight_end' }>;
/** lama layar hasil duel tampil sebelum yang kalah melompat ke Start (dtk) */
const FIGHT_RESULT_SECONDS = 2.2;

export function readSave(): SaveData | null {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as SaveData;
    return data.state && !data.state.winnerId ? data : null;
  } catch {
    return null;
  }
}

function clearSave(): void {
  try {
    localStorage.removeItem(SAVE_KEY);
  } catch {
    /* abaikan */
  }
}

/** Orkestrator permainan: menjalankan giliran, memicu animasi (Stage) dan event (EventBus). */
export class Game {
  readonly machine = new StateMachine((from, to) => this.bus.emit('phase', { from, to }));
  state!: GameState;
  config!: GameConfig;
  paused = false;

  private rng: Rng = createRng(1);
  private token = 0;
  private human = new HumanController();
  private ais = new Map<string, AIController>();

  /** mode online: koneksi ke server; null = main lawan komputer */
  online: NetworkClient | null = null;
  /** online: menu jeda hanya tampilan (permainan tetap jalan karena pemain lain menunggu) */
  menuOpen = false;
  private offs: (() => void)[] = [];
  private results: TurnResult[] = [];
  private resultWaiter: (() => void) | null = null;
  /** duel sedang berlangsung (lempar dadu ditahan) */
  fightActive = false;
  /** hasil lemparan berlabel duel yang hasil duelnya belum diproses giliran */
  private fightsAwaited = 0;
  private fightEnds: FightEnd[] = [];
  private fightWaiter: (() => void) | null = null;
  /** Mode Arena (online): state terakhir dari server; null = mode arena mati / lawan komputer */
  arena: ArenaInfo | null = null;
  /** item yang sudah diambil di server tapi pionnya belum tiba (tetap tampil di papan & belum masuk tas) */
  private heldItems = new Map<number, { playerId: string; item: ItemId }>();
  /** darah & perisai yang ditampilkan untuk pion yang sedang diserang: baru turun saat serangannya mengenai */
  private hitHold = new Map<string, { hp: number; shield: number }>();
  /** nomor lemparan (state.turn) saat perangkat ini terakhir menyerang — satu serangan per lemparan */
  private attackedTurn = -1;

  constructor(
    readonly bus: EventBus,
    private stage: Stage,
    private scene: SceneManager,
    private audio: AudioManager,
  ) {}

  // ───────────────────────── Siklus hidup ─────────────────────────

  start(config: GameConfig): void {
    this.cleanup();
    const rng = createRng(randomSeed());
    const board =
      config.boardPreset === 'random'
        ? generateRandomBoard(rng)
        : structuredClone(BOARD_PRESETS[config.boardPreset]);

    const chars = CHARACTERS.filter((c) => c.id !== config.characterId);
    rng.shuffle(chars);
    const players: Omit<PlayerState, 'position'>[] = [
      {
        id: 'p0',
        name: config.playerName.trim() || t('setup.namePlaceholder'),
        character: config.characterId,
        color: PLAYER_COLORS[0],
        isBot: false,
      },
    ];
    for (let i = 0; i < config.botCount; i++) {
      const c = chars[i];
      players.push({
        id: `p${i + 1}`,
        name: c.id.charAt(0).toUpperCase() + c.id.slice(1),
        character: c.id,
        color: PLAYER_COLORS[i + 1],
        isBot: true,
        personality: PERSONALITIES[i % PERSONALITIES.length],
      });
    }
    const state = createInitialState(players, board, config.options, rng.getState());
    void this.begin(config, state, false);
  }

  /** Mulai (atau lanjutkan dari snapshot) permainan online; state berasal dari server. */
  startOnline(net: NetworkClient, state: GameState, resumed: boolean): void {
    this.cleanup(); // melepas langganan lama sebelum memasang yang baru
    this.online = net;
    this.results = [];
    this.offs = [
      net.on('turn_result', (m) => {
        if (m.fight) this.fightsAwaited++;
        if (m.pickup) this.heldItems.set(m.pickup.tile, { playerId: m.playerId, item: m.pickup.item });
        this.results.push(m);
        this.resultWaiter?.();
      }),
      net.on('fight_start', ({ fight }) => {
        this.fightActive = true;
        // kamera ke petak duel agar semua anggota room (pemain lain & penonton) melihat pertarungannya
        if (this.stage.characters.has(fight.fighters[0])) this.stage.focusPlayer(fight.fighters[0]);
        for (const id of fight.fighters) this.stage.characters.get(id)?.showEmote('⚔️', 1600);
        this.bus.emit('fight:start', { fighters: fight.fighters });
      }),
      net.on('fight_hit', (m) => this.showFightHit(m.playerId, m.damage, Object.keys(m.hp))),
      net.on('fight_end', (m) => {
        this.fightActive = false;
        if (this.fightsAwaited > 0) {
          // giliran yang memicu duel akan memprosesnya setelah animasi langkah selesai
          this.fightEnds.push(m);
          this.fightWaiter?.();
        } else {
          // masuk kembali di tengah duel: tidak ada giliran yang menunggu, langsung terapkan
          this.applyFightEnd(m, this.token).catch(() => undefined); // dibatalkan bila game keluar
        }
      }),
      net.on('turn', ({ playerId, deadline }) => this.bus.emit('turn:deadline', { playerId, deadline })),
      // siaran server sampai ke semua anggota room, termasuk pengirimnya sendiri
      net.on('emote', ({ playerId, name, spectator, id }) => this.showExpression(playerId, name, spectator, id)),
      net.on('room_state', ({ room }) => this.bus.emit('net:room', { room })),
      net.on('arena', ({ arena }) => {
        this.arena = arena;
        this.syncItems();
        this.bus.emit('arena:update', {});
      }),
      net.on('arena_event', ({ ev }) => this.onArenaEvent(ev)),
    ];
    // tombol lempar ditahan: beri tahu server kapan mulai mengisi tenaga (server yang menilai "sempurna")
    this.offs.push(this.bus.on('charge:start', () => net.send({ t: 'charge_start' })));
    const config: GameConfig = {
      playerName: '',
      characterId: '',
      botCount: 0,
      boardPreset: 'normal',
      options: state.options,
    };
    void this.begin(config, state, resumed);
  }

  resume(save: SaveData): void {
    this.cleanup();
    void this.begin(save.config, save.state, true);
  }

  private async begin(config: GameConfig, state: GameState, resumed: boolean): Promise<void> {
    const token = ++this.token;
    this.config = config;
    this.state = state;
    this.rng = createRng(1);
    this.rng.setState(state.rngState);
    this.ais.clear();
    for (const p of state.players) if (p.isBot) this.ais.set(p.id, new AIController(p.personality ?? 'cheerful'));

    this.stage.setBoardMap(state.board);
    this.stage.setPlayers(state.players);
    this.stage.camera.attract(false);
    this.audio.playMusic('game');
    this.audio.setTension(state.players.some((p) => p.position >= 90));
    this.bus.emit('game:start', { playerIds: state.players.map((p) => p.id) });

    try {
      if (!resumed) {
        this.machine.go('INTRO');
        this.bus.emit('ui:banner', { text: t('banner.ready') });
        await this.stage.camera.intro();
        this.check(token);
      }
      while (!this.state.winnerId) await this.playTurn(token);
      await this.finish(token);
    } catch (e) {
      if (!(e instanceof Cancelled)) throw e;
    }
  }

  private check(token: number): void {
    if (token !== this.token) throw new Cancelled();
  }

  /** Hentikan game berjalan dan bersihkan semuanya (kembali ke menu). */
  exit(): void {
    this.cleanup();
    this.token++;
    this.audio.playMusic('menu');
    this.stage.camera.resetView(false);
    this.stage.camera.attract(true);
    this.bus.emit('game:exit', {});
  }

  private cleanup(): void {
    this.offs.forEach((off) => off());
    this.offs = [];
    this.online = null;
    this.menuOpen = false;
    this.results = [];
    this.resultWaiter = null;
    this.fightActive = false;
    this.fightsAwaited = 0;
    this.fightEnds = [];
    this.fightWaiter = null;
    this.arena = null;
    this.heldItems.clear();
    this.hitHold.clear();
    this.attackedTurn = -1;
    gsap.globalTimeline.clear();
    gsap.globalTimeline.paused(false).timeScale(DEV_SPEED);
    this.scene.timeScale = 1;
    this.paused = false;
    this.human.cancel();
    this.stage.reset();
    this.machine.reset();
  }

  togglePause(): void {
    if (this.machine.phase === 'LOBBY' || this.machine.phase === 'GAME_OVER') return;
    if (this.online) {
      // online tidak bisa membekukan permainan: hanya membuka/menutup menu
      this.menuOpen = !this.menuOpen;
      this.bus.emit('pause', { paused: this.menuOpen });
      return;
    }
    this.paused = !this.paused;
    gsap.globalTimeline.paused(this.paused);
    this.scene.timeScale = this.paused ? 0 : 1;
    this.audio.setDuck(this.paused ? 0.3 : 1);
    this.bus.emit('pause', { paused: this.paused });
  }

  // ───────────────────────── Input ─────────────────────────

  /** Apakah pemain ini dikendalikan perangkat ini (online: id sendiri; lokal: manusia). */
  isMine(playerId: string): boolean {
    if (this.online) return playerId === this.online.myId;
    return !(this.state.players.find((p) => p.id === playerId)?.isBot ?? true);
  }

  get humanTurn(): boolean {
    return !!this.state && this.isMine(currentPlayer(this.state).id);
  }

  canRoll(): boolean {
    return this.machine.phase === 'AWAIT_ROLL' && this.humanTurn && !this.paused && this.human.waiting && !this.rollBlocked;
  }

  /** Online: lempar ditahan selama duel atau saat menunggu pemain pengganti bergabung. */
  get rollBlocked(): boolean {
    return this.fightActive || !!this.online?.room?.waiting;
  }

  requestRoll(input: RollInput = { boost: false }): void {
    if (this.canRoll()) this.human.trigger(input);
  }

  private resultAvailable(): Promise<void> {
    return new Promise((resolve) => {
      if (this.results.length > 0) resolve();
      else this.resultWaiter = resolve;
    });
  }

  /** Menunggu hasil lemparan berikutnya dari server (antrean menjaga urutan bila datang lebih awal). */
  private nextResult(): Promise<TurnResult> {
    return new Promise((resolve) => {
      const take = () => {
        const r = this.results.shift();
        if (r) {
          this.resultWaiter = null;
          resolve(r);
        } else {
          this.resultWaiter = take;
        }
      };
      take();
    });
  }

  private nextFightEnd(): Promise<FightEnd> {
    return new Promise((resolve) => {
      const take = () => {
        const r = this.fightEnds.shift();
        if (r) {
          this.fightWaiter = null;
          resolve(r);
        } else {
          this.fightWaiter = take;
        }
      };
      take();
    });
  }

  // ───────────────────────── Arena ─────────────────────────

  arenaHp(id: string): number {
    return this.hitHold.get(id)?.hp ?? this.arena?.hp[id] ?? ARENA_HP;
  }

  /** Daya tahan perisai yang ditampilkan (perisai yang pionnya belum tiba belum dihitung). */
  arenaShield(id: string): number {
    const hold = this.hitHold.get(id);
    if (hold) return hold.shield;
    let held = 0;
    for (const h of this.heldItems.values()) if (h.playerId === id && h.item === 'shield') held += SHIELD_PER_ITEM;
    return Math.max(0, (this.arena?.shield[id] ?? 0) - held);
  }

  /** Isi tas yang ditampilkan: item yang pionnya belum tiba di petaknya belum dihitung. */
  arenaBag(id: string): ItemId[] {
    const bag = [...(this.arena?.bags[id] ?? [])];
    for (const h of this.heldItems.values()) {
      if (h.playerId !== id || h.item === 'shield') continue;
      const i = bag.lastIndexOf(h.item);
      if (i >= 0) bag.splice(i, 1);
    }
    return bag;
  }

  /** Perangkat ini pemain di Mode Arena (bukan penonton). */
  get arenaPlayer(): boolean {
    return !!this.arena && !!this.online && !this.online.isSpectator && this.online.myId in this.arena.bags;
  }

  /** Boleh menyerang sekarang: giliran sendiri, sebelum melempar (server tetap memeriksa ulang). */
  canAttack(): boolean {
    return this.arenaPlayer && this.canRoll() && this.attackedTurn !== this.state.turn;
  }

  /** Lawan dalam jangkauan item serang ini (sesuai jarak item; jarak bebas = semua lawan yang tidak di Start). */
  targetsInReach(item: ItemId): PlayerState[] {
    const net = this.online;
    if (!net || !this.state || !this.arena) return [];
    const me = this.state.players.find((p) => p.id === net.myId);
    if (!me) return [];
    return this.state.players.filter((p) => p.id !== me.id && p.id in this.arena!.bags && canHit(item, me.position, p.position));
  }

  useItem(item: ItemId, targetId?: string): void {
    this.online?.send({ t: 'use_item', item, ...(targetId ? { targetId } : {}) });
  }

  private syncItems(): void {
    const list: TileItem[] = [...(this.arena?.tileItems ?? [])];
    for (const [tile, h] of this.heldItems) if (!list.some((c) => c.tile === tile)) list.push({ tile, item: h.item });
    this.stage.setTileItems(list);
  }

  private collectItem(tile: number, playerId: string, item: ItemId): void {
    this.heldItems.delete(tile);
    this.stage.collectItem(tile);
    const shield = item === 'shield';
    this.stage.characters.get(playerId)?.showEmote(shield ? `🛡️+${SHIELD_PER_ITEM}` : `🎒${ITEMS[item].emoji}`, 1400);
    if (shield) this.stage.shieldHit(playerId, false);
    this.syncItems();
    const name = this.state.players.find((p) => p.id === playerId)?.name ?? '?';
    this.bus.emit('arena:pickup', { playerId, got: { tile, item } });
    this.bus.emit('ui:log', {
      text: shield ? t('arena.log.shield', { name, n: SHIELD_PER_ITEM }) : t('arena.log.pickup', { name, item: `${ITEMS[item].emoji} ${t(`item.${item}`)}` }),
    });
    this.bus.emit('arena:update', {});
  }

  /** Berhenti di petak ber-item tapi tas penuh: item tetap di papan (perisai tidak memakai slot). */
  private bagFullAt(tile: number, playerId: string): void {
    const here = this.arena?.tileItems.find((c) => c.tile === tile);
    if (!this.arena || !here || here.item === 'shield') return;
    if ((this.arena.bags[playerId]?.length ?? 0) < BAG_SIZE) return;
    this.stage.characters.get(playerId)?.showEmote('🎒✖', 1400);
    if (playerId === this.online?.myId) this.bus.emit('ui:banner', { text: t('arena.bagFull'), kind: 'bad' });
  }

  /** Kejadian arena tampil di papan 3D untuk semua anggota room (pemain lain & penonton). */
  private onArenaEvent(ev: ArenaEvent): void {
    const chars = this.stage.characters;
    if (ev.kind === 'attack') {
      if (ev.playerId === this.online?.myId) this.attackedTurn = this.state.turn;
      // tampilan darah/perisai si terkena ditahan sampai proyektilnya tiba (pesan 'arena' datang sesudah ini)
      if (!this.hitHold.has(ev.victimId)) this.hitHold.set(ev.victimId, { hp: this.arenaHp(ev.victimId), shield: this.arenaShield(ev.victimId) });
      // state langsung mengikuti server; animasinya menyusul
      const koPlayer = ev.ko ? this.state.players.find((x) => x.id === ev.ko) : undefined;
      if (koPlayer) koPlayer.position = KO_TILE;
      this.playAttack(ev, this.token).catch(() => this.hitHold.delete(ev.victimId)); // dibatalkan bila game keluar
    } else if (ev.kind === 'heal') {
      chars.get(ev.playerId)?.showEmote(`❤️+${ev.amount}`, 1400);
      chars.get(ev.playerId)?.showImpact(`+${ev.amount}`, 'heal');
      this.stage.glow(ev.playerId, 0x69db7c);
    } else if (ev.kind === 'shuffle') {
      this.bus.emit('ui:banner', { text: t('arena.shuffled'), kind: 'bonus' });
      this.bus.emit('ui:log', { text: t('arena.shuffled') });
    }
    this.bus.emit('arena:event', { ev });
  }

  /**
   * Animasi serangan (terlihat semua anggota room): kamera menyorot sasaran, penyerang meluncurkan
   * item → (dipantulkan cermin) → kena: hit-stop, ledakan + gelombang kejut, pion terpental, teks
   * komik besar, darah/perisai di HUD baru turun; K.O. = pion melambung kembali ke Start.
   */
  private async playAttack(ev: Extract<ArenaEvent, { kind: 'attack' }>, token: number): Promise<void> {
    const chars = this.stage.characters;
    const victim = ev.victimId;
    const heavy = itemHeavy(ev.item);
    const fx = itemFx(ev.item);
    const target = chars.get(ev.outcome === 'reflected' ? ev.targetId : victim);
    if (target) void this.stage.camera.shot(target.root.position.clone(), heavy ? 4.2 : 5.2, ev.outcome === 'reflected' ? 2.2 : 1.4);
    chars.get(ev.playerId)?.showEmote(ITEMS[ev.item].emoji, 1000);
    chars.get(ev.playerId)?.showImpact(t('arena.cry'), 'hit');
    if (chars.has(ev.playerId)) void this.stage.pulsePose(ev.playerId, 'cheer', 0.5);
    this.bus.emit('arena:launch', { ev });
    await this.stage.projectile(ev.playerId, ev.targetId, ev.item);
    this.check(token);
    if (ev.outcome === 'reflected') {
      chars.get(ev.targetId)?.showEmote('🪞', 1200);
      chars.get(ev.targetId)?.showImpact(t('arena.reflectWord'), 'shield');
      this.stage.glow(ev.targetId, 0xe599f7);
      this.bus.emit('arena:reflect', { ev });
      await this.stage.projectile(ev.targetId, ev.playerId, ev.item);
      this.check(token);
    }

    // ── kena ──
    this.hitHold.delete(victim);
    if (ev.ko) this.hitHold.set(victim, { hp: 0, shield: 0 });
    const attacker = ev.outcome === 'reflected' ? ev.targetId : ev.playerId;
    if (ev.absorbed > 0) this.stage.shieldHit(victim, ev.shieldBroken);
    if (ev.damage > 0) {
      const color = fx === 'zap' ? 0xfff3bf : ev.item === 'snowball' ? 0xa5d8ff : fx === 'flame' ? 0xff6b00 : fx === 'straight' ? 0xff4d6d : 0xff6b3d;
      this.stage.blast(victim, color, heavy);
      this.stage.shockwave(victim, color, heavy);
      this.stage.knockback(victim, attacker, heavy ? 1.6 : 1);
      this.stage.hitStop(heavy ? 200 : 110);
      if (chars.has(victim)) void this.stage.pulsePose(victim, 'scared', 0.8);
    }
    const ch = chars.get(victim);
    const word = ev.item === 'snowball' ? 'SPLAT!' : IMPACT_WORDS[fx];
    if (ev.damage > 0) {
      ch?.showImpact(word, heavy ? 'big' : 'hit');
      ch?.showImpact(`−${ev.damage}`, heavy ? 'big' : 'hit', 220);
    }
    if (ev.absorbed > 0) ch?.showImpact(ev.shieldBroken ? t('arena.shieldBrokeWord') : `🛡️−${ev.absorbed}`, 'shield', ev.damage > 0 ? 420 : 0);
    this.bus.emit('arena:impact', { ev });
    this.bus.emit('arena:update', {});
    if (ev.ko) {
      const name = this.state.players.find((p) => p.id === ev.ko)?.name ?? '?';
      ch?.showImpact('K.O.!', 'ko', 500);
      this.bus.emit('ui:banner', { text: t('arena.koBanner', { name }), kind: 'bad' });
      await this.stage.sleep(0.7);
      this.check(token);
      await this.stage.sendTo(ev.ko, KO_TILE, true);
      this.hitHold.delete(victim);
      this.bus.emit('arena:update', {});
      this.bus.emit('move:step', { playerId: ev.ko, tile: KO_TILE, stepIndex: 0, total: 0 });
    }
  }

  /** Hasil duel: setelah layar hasil tampil, yang kalah melompat kembali ke Start. */
  private async applyFightEnd(end: FightEnd, token: number): Promise<void> {
    const losers = end.losers.filter((id) => this.stage.characters.has(id));
    for (const id of losers) {
      const p = this.state.players.find((x) => x.id === id);
      if (p) p.position = 0;
    }
    if (end.winnerId && this.stage.characters.has(end.winnerId)) void this.stage.pulsePose(end.winnerId, 'cheer', 1.6);
    for (const id of losers) void this.stage.pulsePose(id, 'sad', 1.6);
    if (losers.length) {
      await this.stage.sleep(FIGHT_RESULT_SECONDS);
      this.check(token);
      await Promise.all(losers.map((id) => this.stage.sendHome(id)));
      this.check(token);
      const names = losers.map((id) => this.state.players.find((p) => p.id === id)?.name ?? '?').join(', ');
      this.bus.emit('ui:log', { text: t('fight.home', { names }) });
    }
    this.bus.emit('fight:end', { winnerId: end.winnerId, losers });
  }

  /** Serangan duel tampil di papan 3D: penyerang bersorak, lawan terkena pukulan (miss = embusan angin). */
  private showFightHit(attacker: string, damage: number, fighters: string[]): void {
    const chars = this.stage.characters;
    if (!chars.has(attacker)) return;
    if (damage <= 0) {
      chars.get(attacker)!.showEmote('💨', 900);
      return;
    }
    void this.stage.pulsePose(attacker, 'cheer', 0.5);
    chars.get(attacker)!.showEmote(damage >= 30 ? '🔥' : '👊', 900);
    for (const id of fighters) {
      if (id === attacker || !chars.has(id)) continue;
      void this.stage.pulsePose(id, 'scared', 0.5);
      chars.get(id)!.showEmote('💥', 900);
    }
  }

  /** Simulasi lokal harus sama dengan server; bila tidak, ikuti server (ia yang berwenang). */
  private reconcile(local: GameState, server: TurnResult['after']): void {
    const same =
      local.current === server.current &&
      local.winnerId === server.winnerId &&
      local.players.every((p, i) => p.position === server.positions[i]);
    if (same) return;
    console.warn('[online] state lokal berbeda dari server, mengikuti server');
    local.players.forEach((p, i) => (p.position = server.positions[i]));
    local.current = server.current;
    local.consecutiveSixes = server.consecutiveSixes;
    local.turn = server.turn;
    local.winnerId = server.winnerId;
    local.ranking = server.ranking;
  }

  /** Petak yang sedang ditampilkan untuk pemain (mengikuti animasi, bukan state akhir). */
  displayTile(id: string): number {
    return Math.max(0, this.stage.characters.get(id)?.tile ?? 0);
  }

  // ───────────────────────── Giliran ─────────────────────────

  private async playTurn(token: number): Promise<void> {
    const player = currentPlayer(this.state);
    const id = player.id;

    this.machine.go('TURN_START');
    gsap.globalTimeline.timeScale((player.isBot && settings.get('fastBots') ? 2 : 1) * DEV_SPEED);
    const mine = this.isMine(id);
    this.bus.emit('turn:start', { playerId: id, index: this.state.current, isBot: player.isBot, mine });
    this.stage.focusPlayer(id);
    if (!this.online) this.saveGame();
    this.audio.setTension(this.state.players.some((p) => p.position >= 90));
    this.bus.emit('ui:banner', { text: this.online && mine ? t('hud.yourTurn') : t('hud.turn', { name: player.name }) });
    await this.stage.sleep(0.9);
    this.check(token);

    // 1) menunggu lemparan
    this.machine.go('AWAIT_ROLL');
    let boost = false;
    let value: number;
    let serverAfter: TurnResult['after'] | null = null;
    let fight = false;
    if (this.online) {
      // server authoritative: pemain yang gilirannya mengirim niat 'roll', hasilnya datang dari server
      if (mine) {
        const net = this.online;
        const rolled = this.human.requestRoll().then(() => net.send({ t: 'roll' }));
        // bila waktu habis, server melempar otomatis dan hasilnya datang tanpa menunggu tombol
        await Promise.race([rolled, this.resultAvailable()]);
        this.human.cancel();
        this.check(token);
      }
      const res = await this.nextResult();
      this.check(token);
      this.machine.go('ROLLING');
      value = res.value;
      boost = res.boost;
      serverAfter = res.after;
      fight = !!res.fight;
    } else {
      if (player.isBot) {
        await this.stage.sleep(this.ais.get(id)!.thinkTime());
      } else {
        boost = (await this.human.requestRoll()).boost;
      }
      this.check(token);
      // 2) dadu: hasil ditentukan lebih dulu oleh RNG, animasi hanya menampilkan
      this.machine.go('ROLLING');
      value = rollDie(this.rng, boost);
    }
    if (boost) {
      this.bus.emit('dice:boost', { playerId: id });
      this.bus.emit('ui:banner', { text: t('banner.perfect'), kind: 'bonus' });
    }
    this.bus.emit('dice:throw', { playerId: id });
    await this.stage.rollDice(value);
    this.check(token);
    this.bus.emit('dice:rolled', { playerId: id, value });
    this.bus.emit('ui:log', { text: t('log.roll', { name: player.name, value }), minor: true });

    const { state: next, outcome } = applyRoll(this.state, value);
    if (serverAfter) this.reconcile(next, serverAfter);
    else next.rngState = this.rng.getState();
    this.state = next;

    if (outcome.forfeited) {
      this.bus.emit('turn:forfeit', { playerId: id });
      this.bus.emit('ui:banner', { text: t('banner.forfeit'), kind: 'bad' });
      this.bus.emit('ui:log', { text: t('log.forfeit', { name: player.name }) });
      void this.stage.pulsePose(id, 'sad', 1.4);
      await this.stage.sleep(1.5);
      this.check(token);
      this.machine.go('NEXT_TURN');
      return;
    }

    // 3) pion melangkah petak demi petak
    this.machine.go('MOVING');
    const move = outcome.move!;
    await this.stage.sleep(0.25);
    for (const [i, tile] of move.path.entries()) {
      await this.stage.hopStep(id, tile);
      this.check(token);
      this.bus.emit('move:step', { playerId: id, tile, stepIndex: i, total: move.path.length });
      if (move.bounced && tile === TILE_COUNT && i < move.path.length - 1) {
        this.bus.emit('move:bounce', { playerId: id, at: tile });
        this.bus.emit('ui:log', { text: t('log.bounce', { name: player.name }) });
      }
    }

    // 4) ular / tangga
    this.machine.go('RESOLVE_TILE');
    if (move.jump?.kind === 'ladder') {
      const { from, to } = move.jump;
      const duration = this.stage.climbDuration(this.stage.ladderAt(from)) / gsap.globalTimeline.timeScale();
      this.bus.emit('ladder:climb', { playerId: id, from, to, duration });
      this.bus.emit('ui:log', { text: t('log.ladder', { name: player.name, from, to }) });
      this.react(id, 'self_ladder', 'other_ladder');
      await this.stage.climb(id, this.stage.ladderAt(from));
    } else if (move.jump?.kind === 'snake') {
      const { from, to } = move.jump;
      const duration = this.stage.slideDuration(this.stage.snakeAt(from)) / gsap.globalTimeline.timeScale();
      this.bus.emit('snake:bite', { playerId: id, from, to, duration });
      this.bus.emit('ui:log', { text: t('log.snake', { name: player.name, from, to }) });
      this.react(id, 'self_snake', 'other_snake');
      await this.stage.slide(id, this.stage.snakeAt(from));
    } else {
      this.stage.settle(id);
      await this.stage.sleep(0.3);
    }
    this.check(token);
    this.bus.emit('move:step', { playerId: id, tile: move.final, stepIndex: move.path.length, total: move.path.length });

    // 4a) arena: item di petak tujuan masuk tas (atau tas penuh)
    const held = this.heldItems.get(move.final);
    if (held && held.playerId === id) this.collectItem(move.final, held.playerId, held.item);
    else if (this.arena) this.bagFullAt(move.final, id);

    // 4b) duel (online): berhenti di petak yang ditempati pemain lain
    if (fight) {
      const end = await this.nextFightEnd();
      this.fightsAwaited = Math.max(0, this.fightsAwaited - 1);
      this.check(token);
      await this.applyFightEnd(end, token);
      this.check(token);
    }

    // 5) menang / lempar lagi / giliran berikutnya
    this.machine.go('CHECK_WIN');
    if (outcome.won) return;
    if (outcome.extraTurn) {
      this.bus.emit('bonus:six', { playerId: id, count: this.state.consecutiveSixes });
      this.bus.emit('ui:banner', { text: t('banner.six'), kind: 'bonus' });
      this.bus.emit('ui:log', { text: t('log.six', { name: player.name }) });
      await this.stage.sleep(0.7);
      this.check(token);
      return;
    }
    this.machine.go('NEXT_TURN');
  }

  private async finish(token: number): Promise<void> {
    const ranking = this.state.ranking;
    const winnerId = ranking[0];
    this.machine.go('GAME_OVER');
    gsap.globalTimeline.timeScale(DEV_SPEED);
    clearSave();
    this.bus.emit('game:win', { playerId: winnerId, ranking });
    this.react(winnerId, 'win', 'lose');
    await this.stage.showPodium(ranking);
    this.check(token);
  }

  // ───────────────────────── Ekspresi ─────────────────────────

  /** Kirim ekspresi: online lewat server (semua anggota room melihat & mendengar), lokal langsung tampil. */
  expression(id: ExpressionId): void {
    if (!this.state) return;
    if (this.online) {
      this.online.send({ t: 'emote', id });
      return;
    }
    const me = this.state.players.find((p) => !p.isBot);
    if (me) this.showExpression(me.id, me.name, false, id);
  }

  private showExpression(playerId: string, name: string, spectator: boolean, id: ExpressionId): void {
    if (!spectator) this.stage.characters.get(playerId)?.showEmote(expressionEmoji(id));
    this.bus.emit('expression', { playerId, name, spectator, id });
  }

  // ───────────────────────── Bantu ─────────────────────────

  /** Bot bereaksi dengan emote sesuai kepribadiannya (tanpa memengaruhi hasil game). */
  private react(actorId: string, selfEvent: ReactionEvent, otherEvent: ReactionEvent): void {
    for (const [pid, ai] of this.ais) {
      const emoji = ai.react(pid === actorId ? selfEvent : otherEvent);
      if (emoji) {
        const ch = this.stage.characters.get(pid);
        window.setTimeout(() => ch?.showEmote(emoji), 500 + Math.random() * 700);
      }
    }
  }

  private saveGame(): void {
    if (this.state.winnerId) return;
    try {
      const data: SaveData = { config: this.config, state: this.state };
      localStorage.setItem(SAVE_KEY, JSON.stringify(data));
    } catch {
      /* abaikan */
    }
  }
}
