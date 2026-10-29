import * as THREE from 'three';
import gsap from 'gsap';
import { CHARACTERS, type BoardMap } from '../config';
import { ITEMS, itemFx, type ItemId, type TileItem } from '../core/Arena';
import type { EventBus } from '../core/EventBus';
import type { PlayerState } from '../core/GameState';
import { Board } from './Board';
import { CameraDirector } from './CameraDirector';
import { Character, type Pose } from './Character';
import { Dice } from './Dice';
import { Effects } from './Effects';
import { Environment } from './Environment';
import { Ladder, LADDER_COLORS } from './Ladder';
import type { SceneManager } from './SceneManager';
import { Snake, SNAKE_COLORS } from './Snake';
import { TILE_TOP, startToWorld, tileSurface } from './coords';

const PODIUM_HEIGHTS = [1.1, 0.8, 0.55, 0.35];
/** warna cincin token item sesuai jenisnya */
const ITEM_RING_COLORS = { attack: 0xff6b3d, guard: 0x4dabf7, heal: 0x51cf66 } as const;
const ITEM_RING_GEO = new THREE.TorusGeometry(0.2, 0.025, 8, 32);
const SHIELD_GEO = new THREE.SphereGeometry(0.5, 24, 16);
const itemMaterials = new Map<ItemId, THREE.SpriteMaterial>();

/** Sprite emoji item (kanvas digambar sekali per jenis item). */
function itemMaterial(item: ItemId): THREE.SpriteMaterial {
  let mat = itemMaterials.get(item);
  if (mat) return mat;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = 'rgba(255,255,255,0.95)';
  g.beginPath();
  g.arc(64, 64, 56, 0, Math.PI * 2);
  g.fill();
  g.lineWidth = 8;
  g.strokeStyle = '#' + ITEM_RING_COLORS[ITEMS[item].kind].toString(16).padStart(6, '0');
  g.stroke();
  g.font = '64px "Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(ITEMS[item].emoji, 64, 70);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  mat = new THREE.SpriteMaterial({ map: tex, depthWrite: false });
  itemMaterials.set(item, mat);
  return mat;
}
const PODIUM_X = [0, -1.15, 1.15, -2.3];

/** Merangkai seluruh objek 3D dan menyediakan animasi tingkat tinggi untuk Game. */
export class Stage {
  readonly board = new Board();
  readonly env = new Environment();
  readonly effects = new Effects();
  readonly dice = new Dice();
  readonly camera: CameraDirector;
  readonly characters = new Map<string, Character>();

  private order: string[] = [];
  private mapGroup = new THREE.Group();
  private snakes = new Map<number, Snake>();
  private ladders = new Map<number, Ladder>();
  private podium: THREE.Group | null = null;
  private fireworkTimer: gsap.core.Tween | null = null;
  /** arena: token item yang melayang di atas petak */
  private itemGroup = new THREE.Group();
  private items = new Map<number, { group: THREE.Group; item: ItemId }>();

  constructor(
    private sm: SceneManager,
    private bus: EventBus,
  ) {
    const w = sm.world;
    w.add(this.env.group, this.board.group, this.mapGroup, this.itemGroup, this.effects.group, ...this.dice.objects);
    this.camera = new CameraDirector(sm.camera, sm.renderer.domElement);
    sm.addUpdater((dt, t) => this.update(dt, t));
    window.addEventListener('resize', () => this.camera.onResize());
  }

  private update(dt: number, time: number): void {
    this.board.update(dt);
    this.env.update(dt, time);
    this.snakes.forEach((s) => s.update(dt, time));
    this.characters.forEach((c) => c.update(dt, time));
    this.effects.update(dt);
    this.camera.update(dt);
    this.items.forEach(({ group }, tile) => {
      group.position.y = TILE_TOP + 0.42 + Math.sin(time * 2.4 + tile) * 0.06;
      group.children[1].rotation.z += dt * 1.6;
    });
  }

  // ───────────────────────── Item arena ─────────────────────────

  /** Samakan token item di papan dengan daftar (item baru muncul dengan efek pop, yang hilang dilepas). */
  setTileItems(list: TileItem[]): void {
    const want = new Map(list.map((c) => [c.tile, c.item]));
    for (const [tile, t] of this.items) {
      if (want.get(tile) === t.item) continue;
      this.itemGroup.remove(t.group);
      this.items.delete(tile);
    }
    for (const c of list) {
      if (this.items.has(c.tile)) continue;
      const group = new THREE.Group();
      const sprite = new THREE.Sprite(itemMaterial(c.item));
      sprite.scale.setScalar(0.5);
      const ring = new THREE.Mesh(
        ITEM_RING_GEO,
        new THREE.MeshStandardMaterial({ color: ITEM_RING_COLORS[ITEMS[c.item].kind], emissive: ITEM_RING_COLORS[ITEMS[c.item].kind], emissiveIntensity: 0.6 }),
      );
      ring.rotation.x = Math.PI / 2;
      ring.position.y = -0.3;
      group.add(sprite, ring);
      const p = tileSurface(c.tile);
      group.position.set(p.x, TILE_TOP + 0.42, p.z);
      group.scale.setScalar(0.01);
      gsap.to(group.scale, { x: 1, y: 1, z: 1, duration: 0.5, ease: 'back.out(2.4)' });
      this.effects.sparkle(p.clone().setY(TILE_TOP + 0.4), ITEM_RING_COLORS[ITEMS[c.item].kind], 10);
      this.itemGroup.add(group);
      this.items.set(c.tile, { group, item: c.item });
    }
  }

  /** Item diambil: kilau lalu terbang ke atas dan hilang. */
  collectItem(tile: number): void {
    const t = this.items.get(tile);
    const p = tileSurface(tile);
    p.y += 0.45;
    this.effects.sparkle(p, 0xffd43b, 18);
    if (!t) return;
    this.items.delete(tile);
    const g = t.group;
    gsap.to(g.position, { y: g.position.y + 0.9, duration: 0.45, ease: 'power2.out' });
    gsap.to(g.scale, { x: 0.01, y: 0.01, z: 0.01, duration: 0.45, ease: 'power2.in', onComplete: () => this.itemGroup.remove(g) });
  }

  private clearItems(): void {
    this.items.forEach((t) => this.itemGroup.remove(t.group));
    this.items.clear();
  }

  /** Ledakan / kena serangan pada pion (`big` = bom / roket). */
  blast(id: string, color = 0xff6b3d, big = false): void {
    const ch = this.characters.get(id);
    if (!ch) return;
    const p = ch.root.position.clone();
    p.y += 0.5;
    this.effects.firework(p, color);
    this.effects.sparkle(p, 0xffffff, big ? 24 : 12);
    if (big) {
      this.effects.firework(p.clone().add(new THREE.Vector3(0.15, 0.2, 0)), 0xffd43b);
      this.effects.burstConfetti(p, 30, 2.2);
    }
  }

  /**
   * Proyektil serangan dari pion penyerang ke sasaran, gayanya sesuai item (lihat AttackFx):
   * menerjang, dilempar melengkung, melesat lurus, berputar, semburan api, roket, petir, meteor.
   */
  async projectile(fromId: string, toId: string, item: ItemId): Promise<void> {
    const a = this.characters.get(fromId);
    const b = this.characters.get(toId);
    if (!a || !b) return;
    const fx = itemFx(item);
    const from = a.root.position.clone();
    from.y += 0.6;
    const to = b.root.position.clone();
    to.y += 0.5;
    a.faceYaw(Math.atan2(to.x - from.x, to.z - from.z), 0.15);
    const dist = from.distanceTo(to);

    if (fx === 'melee') {
      const lunge = to.clone().sub(from).setY(0).multiplyScalar(0.45);
      const home = a.root.position.clone();
      await new Promise<void>((resolve) =>
        gsap.to(a.root.position, { x: home.x + lunge.x, z: home.z + lunge.z, y: home.y + 0.15, duration: 0.14, ease: 'power2.out', yoyo: true, repeat: 1, onRepeat: resolve }),
      );
      return;
    }
    if (fx === 'flame') {
      // semburan api: bara beterbangan dari penyerang ke sasaran
      const o = { p: 0 };
      await new Promise<void>((resolve) =>
        gsap.to(o, {
          p: 1,
          duration: 0.55,
          ease: 'none',
          onUpdate: () => {
            const q = from.clone().lerp(to, o.p);
            q.y += Math.sin(o.p * Math.PI) * 0.2;
            this.effects.sparkle(q, Math.random() < 0.5 ? 0xff6b00 : 0xffd43b, 3);
          },
          onComplete: resolve,
        }),
      );
      return;
    }

    const mat = itemMaterial(item).clone();
    const sprite = new THREE.Sprite(mat);
    sprite.scale.setScalar(fx === 'meteor' ? 0.75 : fx === 'rocket' ? 0.55 : 0.42);
    this.itemGroup.add(sprite);
    let start = from;
    let height = 0;
    let duration = 0.5;
    let ease = 'none';
    let side = new THREE.Vector3();
    if (fx === 'lob') {
      height = 1.4 + dist * 0.2;
      duration = 0.75 + dist * 0.05;
    } else if (fx === 'straight') {
      height = 0.25 + dist * 0.06;
      duration = 0.28 + dist * 0.03;
    } else if (fx === 'spin') {
      height = 0.5;
      duration = 0.6 + dist * 0.04;
      // lengkung menyamping seperti bumerang
      side = new THREE.Vector3(to.z - from.z, 0, from.x - to.x).normalize().multiplyScalar(0.6 + dist * 0.12);
    } else if (fx === 'rocket') {
      height = 0.5 + dist * 0.08;
      duration = 0.5 + dist * 0.05;
      ease = 'power2.in';
    } else if (fx === 'zap') {
      start = to.clone().add(new THREE.Vector3(0, 4.5, 0));
      duration = 0.16;
      ease = 'power3.in';
      for (let i = 0; i < 8; i++) this.effects.sparkle(to.clone().add(new THREE.Vector3((Math.random() - 0.5) * 0.3, i * 0.55, 0)), 0xfff3bf, 2);
    } else if (fx === 'meteor') {
      start = to.clone().add(new THREE.Vector3(2.5, 6, -2.5));
      duration = 0.85;
      ease = 'power2.in';
    }
    sprite.position.copy(start);
    const o = { p: 0 };
    await new Promise<void>((resolve) =>
      gsap.to(o, {
        p: 1,
        duration,
        ease,
        onUpdate: () => {
          sprite.position.lerpVectors(start, to, o.p);
          sprite.position.y += Math.sin(o.p * Math.PI) * height;
          if (fx === 'spin') {
            sprite.position.addScaledVector(side, Math.sin(o.p * Math.PI));
            mat.rotation += 0.5;
          } else if (fx === 'lob') mat.rotation += 0.15;
          if (fx === 'rocket' || fx === 'meteor') this.effects.sparkle(sprite.position.clone(), Math.random() < 0.5 ? 0xff922b : 0xffd43b, fx === 'meteor' ? 4 : 2);
          else if (fx === 'lob' && Math.random() < 0.3) this.effects.sparkle(sprite.position.clone(), 0xffe066, 1);
          else if (fx === 'zap') this.effects.sparkle(sprite.position.clone(), 0xfff3bf, 3);
        },
        onComplete: () => {
          this.itemGroup.remove(sprite);
          mat.dispose();
          resolve();
        },
      }),
    );
  }

  /** Gelembung perisai menyerap serangan (`broken` = perisai hancur: pecahan biru). */
  shieldHit(id: string, broken: boolean): void {
    const ch = this.characters.get(id);
    if (!ch) return;
    const mat = new THREE.MeshBasicMaterial({ color: 0x74c0fc, transparent: true, opacity: 0.45, depthWrite: false });
    const bubble = new THREE.Mesh(SHIELD_GEO, mat);
    bubble.position.copy(ch.root.position).setY(ch.root.position.y + 0.45);
    bubble.scale.setScalar(0.7);
    this.itemGroup.add(bubble);
    gsap.to(bubble.scale, { x: 1.25, y: 1.25, z: 1.25, duration: 0.45, ease: 'power2.out' });
    gsap.to(mat, {
      opacity: 0,
      duration: broken ? 0.35 : 0.6,
      delay: broken ? 0.05 : 0.15,
      onComplete: () => {
        this.itemGroup.remove(bubble);
        mat.dispose();
      },
    });
    const p = bubble.position.clone();
    this.effects.sparkle(p, 0xa5d8ff, broken ? 30 : 10);
    if (broken) this.effects.firework(p, 0x74c0fc);
  }

  /** Kilau di atas pion (pulih / perisai). */
  glow(id: string, color: number): void {
    const ch = this.characters.get(id);
    if (!ch) return;
    const p = ch.root.position.clone();
    p.y += 0.6;
    this.effects.sparkle(p, color, 16);
  }

  // ───────────────────────── Setup ─────────────────────────

  setBoardMap(map: BoardMap): void {
    this.clearMap();
    let i = 0;
    for (const [from, to] of Object.entries(map.ladders)) {
      const l = new Ladder(Number(from), to, LADDER_COLORS[i++ % LADDER_COLORS.length]);
      this.ladders.set(Number(from), l);
      this.mapGroup.add(l.group);
    }
    i = 0;
    for (const [from, to] of Object.entries(map.snakes)) {
      const s = new Snake(Number(from), to, SNAKE_COLORS[i++ % SNAKE_COLORS.length]);
      this.snakes.set(Number(from), s);
      this.mapGroup.add(s.group);
    }
  }

  private clearMap(): void {
    this.mapGroup.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      if (m.material) (Array.isArray(m.material) ? m.material : [m.material]).forEach((x) => x.dispose());
    });
    this.mapGroup.clear();
    this.snakes.clear();
    this.ladders.clear();
  }

  /** Buat pion untuk tiap pemain pada posisi yang tersimpan di state. */
  setPlayers(players: PlayerState[]): void {
    this.clearPlayers();
    this.order = players.map((p) => p.id);
    for (const p of players) {
      const def = CHARACTERS.find((c) => c.id === p.character) ?? CHARACTERS[0];
      const ch = new Character(def, p.name, p.color);
      ch.tile = p.position;
      this.characters.set(p.id, ch);
      this.sm.world.add(ch.root);
    }
    for (const p of players) this.layoutTile(p.position, false);
  }

  clearPlayers(): void {
    this.characters.forEach((c) => c.dispose());
    this.characters.clear();
    this.order = [];
    this.clearPodium();
    this.effects.clear();
    this.stopFireworks();
  }

  char(id: string): Character {
    return this.characters.get(id)!;
  }

  // ───────────────────────── Penataan pion ─────────────────────────

  private slotPosition(tile: number, id: string): THREE.Vector3 {
    const occupants = [...this.characters.entries()].filter(([, c]) => c.tile === tile).map(([pid]) => pid);
    occupants.sort((a, b) => this.order.indexOf(a) - this.order.indexOf(b));
    if (tile <= 0) return startToWorld(this.order.indexOf(id)).setY(0.1);
    const base = tileSurface(tile);
    const n = occupants.length;
    if (n <= 1) return base;
    const k = Math.max(0, occupants.indexOf(id));
    const a = (k / n) * Math.PI * 2 + Math.PI / 4;
    const r = n === 2 ? 0.2 : 0.24;
    return base.add(new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r));
  }

  /** Susun ulang semua pion yang berada di `tile` (melingkar kecil agar tidak tumpang tindih). */
  layoutTile(tile: number, animate = true): void {
    this.characters.forEach((c, id) => {
      if (c.tile !== tile) return;
      const p = this.slotPosition(tile, id);
      if (animate) c.settleTo(p);
      else c.root.position.copy(p);
    });
  }

  focusPlayer(id: string): void {
    this.camera.follow(this.char(id).root.position);
  }

  setPose(id: string, pose: Pose): void {
    this.char(id).setPose(pose);
  }

  /** Pose sementara lalu kembali idle. */
  async pulsePose(id: string, pose: Pose, seconds: number): Promise<void> {
    const ch = this.char(id);
    ch.setPose(pose);
    await this.sleep(seconds);
    ch.setPose('idle');
  }

  sleep(seconds: number): Promise<void> {
    return new Promise((resolve) => gsap.delayedCall(seconds, resolve));
  }

  // ───────────────────────── Dadu & langkah ─────────────────────────

  async rollDice(value: number): Promise<void> {
    await this.dice.throw(value, () => {
      this.bus.emit('dice:land', { value });
      this.sm.shake(0.05);
    });
    await this.sleep(0.35);
    await this.dice.hide();
  }

  /** Lompat ke tengah petak `tile` (satu langkah). */
  async hopStep(id: string, tile: number): Promise<void> {
    const ch = this.char(id);
    const from = ch.tile;
    ch.tile = tile;
    await ch.hopTo(tileSurface(tile));
    this.board.bounceTile(tile);
    this.effects.sparkle(tileSurface(tile), 0xfff1a8, 6);
    if (from !== tile) this.layoutTile(from);
  }

  /** Kalah duel: pion terlempar dengan lompatan tinggi kembali ke Start. */
  async sendHome(id: string): Promise<void> {
    await this.sendTo(id, 0);
  }

  /** Pion terlempar dengan lompatan tinggi ke petak tertentu (kalah duel → Start, darah habis → petak 1). */
  async sendTo(id: string, tile: number): Promise<void> {
    const ch = this.characters.get(id);
    if (!ch) return;
    const from = ch.tile;
    if (from === tile) return;
    this.effects.sparkle(ch.root.position.clone(), 0xff6b6b, 14);
    ch.tile = tile;
    this.layoutTile(from);
    await ch.hopTo(this.slotPosition(tile, id), 1.1, 3.2);
    this.layoutTile(tile);
    ch.faceCamera();
  }

  /** Rapikan pion di petak tujuan setelah seluruh gerakan selesai. */
  settle(id: string): void {
    const ch = this.char(id);
    this.layoutTile(ch.tile);
    ch.faceCamera();
  }

  climbDuration(ladder: Ladder): number {
    return THREE.MathUtils.clamp(ladder.length * 0.17, 1.0, 2.4);
  }

  slideDuration(snake: Snake): number {
    return THREE.MathUtils.clamp(snake.curve.getLength() * 0.2, 1.0, 2.6);
  }

  async climb(id: string, ladder: Ladder): Promise<void> {
    const ch = this.char(id);
    const from = ch.tile;
    const duration = this.climbDuration(ladder);
    const mid = ladder.pointAt(0.5);
    void this.camera.shot(mid, 7.5, Math.max(0.2, duration - 0.5));
    ch.setPose('climb');
    ladder.light(duration);
    await ch.moveAlong((t) => ladder.pointAt(t), duration, 'power1.inOut');
    ch.tile = ladder.topTile;
    ch.root.position.copy(tileSurface(ladder.topTile));
    this.effects.burstConfetti(ch.root.position, 80);
    this.effects.sparkle(ch.root.position, 0xffe066, 16);
    ch.setPose('cheer');
    this.layoutTile(from);
    this.layoutTile(ladder.topTile);
    ch.faceCamera();
    await this.sleep(1.3);
    ch.setPose('idle');
  }

  async slide(id: string, snake: Snake): Promise<void> {
    const ch = this.char(id);
    const from = ch.tile;
    const head = snake.pointOnBody(0);
    void this.camera.shot(head, 6.2, 1.5);
    ch.setPose('scared');
    ch.root.position.copy(head);
    await snake.bite();
    this.sm.shake(0.22);
    const duration = this.slideDuration(snake);
    await ch.moveAlong((t) => snake.pointOnBody(t), duration, 'power1.in');
    ch.tile = snake.tailTile;
    ch.root.position.copy(tileSurface(snake.tailTile));
    ch.setPose('sad');
    this.layoutTile(from);
    this.layoutTile(snake.tailTile);
    ch.faceCamera();
    await this.sleep(1.2);
    ch.setPose('idle');
  }

  ladderAt(foot: number): Ladder {
    return this.ladders.get(foot)!;
  }

  snakeAt(head: number): Snake {
    return this.snakes.get(head)!;
  }

  // ───────────────────────── Kemenangan ─────────────────────────

  async showPodium(ranking: string[]): Promise<void> {
    this.clearPodium();
    this.camera.follow(null);
    const podium = new THREE.Group();
    podium.position.set(0, TILE_TOP, 0.4);
    const colors = [0xffd23f, 0xc9d1d9, 0xcd7f32, 0x7e8fa6];
    ranking.forEach((_id, i) => {
      const h = PODIUM_HEIGHTS[i];
      const block = new THREE.Mesh(
        new THREE.BoxGeometry(1.05, h, 1.05),
        new THREE.MeshStandardMaterial({ color: colors[i], roughness: 0.4, metalness: i === 0 ? 0.5 : 0.1 }),
      );
      block.position.set(PODIUM_X[i], h / 2, 0);
      block.castShadow = true;
      block.receiveShadow = true;
      podium.add(block);

      const c = document.createElement('canvas');
      c.width = c.height = 128;
      const g = c.getContext('2d')!;
      g.fillStyle = '#2a2350';
      g.font = "700 96px Fredoka, system-ui, sans-serif";
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(String(i + 1), 64, 68);
      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      const num = new THREE.Mesh(
        new THREE.PlaneGeometry(0.6, 0.6),
        new THREE.MeshBasicMaterial({ map: tex, transparent: true }),
      );
      num.position.set(PODIUM_X[i], h * 0.5, 0.53);
      podium.add(num);
    });
    podium.scale.setScalar(0.01);
    this.sm.world.add(podium);
    this.podium = podium;
    gsap.to(podium.scale, { x: 1, y: 1, z: 1, duration: 0.7, ease: 'back.out(1.8)' });

    ranking.forEach((id, i) => {
      const ch = this.char(id);
      ch.tile = -1;
      const pos = new THREE.Vector3(PODIUM_X[i], TILE_TOP + PODIUM_HEIGHTS[i] + 0.02, 0.4);
      ch.root.position.copy(pos);
      ch.root.rotation.y = 0;
      ch.popIn();
      ch.setPose(i === 0 ? 'cheer' : i === ranking.length - 1 && ranking.length > 2 ? 'sad' : 'idle');
    });
    // pada layar lebar, podium digeser ke kiri agar tidak tertutup kartu hasil
    const wide = window.innerWidth >= 900 && window.innerWidth / window.innerHeight >= 4 / 3;
    await this.camera.moveTo(new THREE.Vector3(wide ? 1.7 : 0, 1.2, 0.4), 7.5);
    this.effects.rainConfetti(new THREE.Vector3(0, 0, 0.4), 70);
    this.startFireworks();
  }

  private clearPodium(): void {
    if (!this.podium) return;
    this.podium.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      if (m.material) (Array.isArray(m.material) ? m.material : [m.material]).forEach((x) => x.dispose());
    });
    this.podium.removeFromParent();
    this.podium = null;
  }

  startFireworks(): void {
    this.stopFireworks();
    const tick = () => {
      const p = new THREE.Vector3((Math.random() - 0.5) * 12, 5 + Math.random() * 4, -5 + Math.random() * 5);
      this.effects.firework(p);
      this.sm.setBloomStrength(0.7);
      gsap.to({}, { duration: 0.3, onComplete: () => this.sm.setBloomStrength(0.45) });
      this.fireworkTimer = gsap.delayedCall(0.55 + Math.random() * 0.7, tick);
    };
    tick();
  }

  stopFireworks(): void {
    this.fireworkTimer?.kill();
    this.fireworkTimer = null;
  }

  /** Bersihkan semua yang bersifat sementara (keluar ke menu). */
  reset(): void {
    this.clearPlayers();
    this.clearItems();
    this.dice.reset();
  }
}
