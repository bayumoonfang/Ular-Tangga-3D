import * as THREE from 'three';
import gsap from 'gsap';
import { CHARACTERS, type BoardMap } from '../config';
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

  constructor(
    private sm: SceneManager,
    private bus: EventBus,
  ) {
    const w = sm.world;
    w.add(this.env.group, this.board.group, this.mapGroup, this.effects.group, ...this.dice.objects);
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
    const ch = this.char(id);
    const from = ch.tile;
    if (from <= 0) return;
    this.effects.sparkle(ch.root.position.clone(), 0xff6b6b, 14);
    ch.tile = 0;
    this.layoutTile(from);
    await ch.hopTo(this.slotPosition(0, id), 1.1, 3.2);
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
    this.dice.reset();
  }
}
