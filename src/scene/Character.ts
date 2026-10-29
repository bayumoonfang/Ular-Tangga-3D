import * as THREE from 'three';
import gsap from 'gsap';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { CharacterDef } from '../config';

export type Pose = 'idle' | 'cheer' | 'sad' | 'scared' | 'climb';

const mat = (color: number, extra: Partial<THREE.MeshStandardMaterialParameters> = {}) =>
  new THREE.MeshStandardMaterial({ color, roughness: 0.55, ...extra });

function mesh(geo: THREE.BufferGeometry, material: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh {
  const m = new THREE.Mesh(geo, material);
  m.position.set(x, y, z);
  m.castShadow = true;
  return m;
}

/**
 * Karakter chibi prosedural (kapsul + bola + kerucut) sebagai placeholder model GLB.
 * Animasi: idle, hop (lintasan parabola), climb, scared (meluncur), cheer, sad.
 */
export class Character {
  readonly root = new THREE.Group();
  readonly label: CSS2DObject;
  /** petak logis pion saat ini (0 = start) */
  tile = 0;
  mode: Pose = 'idle';

  private pose = new THREE.Group();
  private armL = new THREE.Group();
  private armR = new THREE.Group();
  private extras: Record<string, THREE.Object3D> = {};
  private labelEl: HTMLDivElement;
  private emoteEl: HTMLSpanElement;
  private emoteTimer = 0;
  private squash = 0;
  private phase = Math.random() * 10;
  private hopHeight: number;

  constructor(
    readonly def: CharacterDef,
    displayName: string,
    ringColor: number,
  ) {
    this.hopHeight = def.id === 'pipi' ? 0.62 : 0.46;
    this.root.add(this.pose);
    this.pose.scale.setScalar(0.72);
    this.build();

    // cincin warna pemain di kaki
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(0.31, 0.045, 8, 32),
      mat(ringColor, { emissive: ringColor, emissiveIntensity: 0.5 }),
    );
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.04;
    this.root.add(ring);

    // label nama (CSS2D) + emote
    this.labelEl = document.createElement('div');
    this.labelEl.className = 'char-label';
    this.labelEl.style.setProperty('--c', '#' + new THREE.Color(ringColor).getHexString());
    this.emoteEl = document.createElement('span');
    this.emoteEl.className = 'char-emote';
    const nameEl = document.createElement('span');
    nameEl.className = 'char-name';
    nameEl.textContent = displayName;
    this.labelEl.append(this.emoteEl, nameEl);
    this.label = new CSS2DObject(this.labelEl);
    this.label.position.set(0, 1.12, 0);
    this.root.add(this.label);
  }

  setName(name: string): void {
    const el = this.labelEl.querySelector('.char-name');
    if (el) el.textContent = name;
  }

  // ───────────────────────── Model ─────────────────────────

  private build(): void {
    const id = this.def.id;
    const body = mat(this.def.color, id === 'rara' ? { metalness: 0.6, roughness: 0.3 } : {});
    const light = (c: THREE.ColorRepresentation) => mat(new THREE.Color(c).getHex());
    const white = mat(0xffffff, { roughness: 0.3 });
    const dark = mat(0x1a1a24, { roughness: 0.4 });
    const p = this.pose;

    const isRobot = id === 'rara';
    // badan & kepala
    if (isRobot) {
      p.add(mesh(new RoundedBoxGeometry(0.42, 0.44, 0.32, 3, 0.06), body, 0, 0.4, 0));
      p.add(mesh(new RoundedBoxGeometry(0.52, 0.42, 0.42, 3, 0.08), body, 0, 0.88, 0));
    } else {
      p.add(mesh(new THREE.CapsuleGeometry(0.2, 0.2, 6, 14), body, 0, 0.38, 0));
      p.add(mesh(new THREE.SphereGeometry(0.27, 24, 18), body, 0, 0.86, 0));
    }

    // kaki
    const footMat = id === 'pipi' ? mat(0xff9f1c) : isRobot ? mat(0x4a4f5a) : body;
    for (const s of [-1, 1]) {
      const foot = mesh(new THREE.SphereGeometry(0.1, 12, 10), footMat, s * 0.11, 0.09, 0.07);
      foot.scale.set(1, 0.7, 1.3);
      p.add(foot);
    }

    // lengan (pivot di bahu)
    for (const [arm, s] of [[this.armL, -1], [this.armR, 1]] as const) {
      arm.position.set(s * 0.25, 0.58, 0);
      arm.add(mesh(new THREE.CapsuleGeometry(0.06, 0.13, 4, 8), isRobot ? mat(0x9aa0ab, { metalness: 0.5 }) : body, 0, -0.11, 0));
      p.add(arm);
    }

    // wajah
    if (isRobot) {
      const eyeMat = mat(0x22e6ff, { emissive: 0x22e6ff, emissiveIntensity: 1.6 });
      for (const s of [-1, 1]) p.add(mesh(new THREE.BoxGeometry(0.11, 0.11, 0.03), eyeMat, s * 0.12, 0.91, 0.215));
      p.add(mesh(new THREE.BoxGeometry(0.22, 0.04, 0.03), dark, 0, 0.78, 0.215));
    } else {
      for (const s of [-1, 1]) {
        const eye = mesh(new THREE.SphereGeometry(0.075, 14, 10), white, s * 0.1, 0.9, 0.22);
        eye.castShadow = false;
        eye.add(mesh(new THREE.SphereGeometry(0.04, 10, 8), dark, 0, 0, 0.05));
        p.add(eye);
      }
      const smile = mesh(new THREE.TorusGeometry(0.055, 0.012, 6, 14, Math.PI), dark, 0, 0.8, 0.255);
      smile.rotation.z = Math.PI;
      smile.castShadow = false;
      p.add(smile);
    }

    // ciri khas tiap karakter
    switch (id) {
      case 'kiko': {
        for (const s of [-1, 1]) {
          const ear = mesh(new THREE.ConeGeometry(0.1, 0.19, 4), body, s * 0.17, 1.1, 0);
          ear.rotation.z = -s * 0.35;
          const inner = mesh(new THREE.ConeGeometry(0.055, 0.12, 4), light(0xffb3c7), 0, -0.02, 0.04);
          ear.add(inner);
          p.add(ear);
        }
        p.add(mesh(new THREE.SphereGeometry(0.035, 8, 6), light(0xff6f91), 0, 0.855, 0.265));
        const belly = mesh(new THREE.SphereGeometry(0.15, 12, 10), light(0xffe0bd), 0, 0.38, 0.1);
        belly.scale.set(1, 1.3, 0.55);
        p.add(belly);
        const tail = new THREE.Group();
        tail.position.set(0, 0.25, -0.18);
        const t = mesh(new THREE.CapsuleGeometry(0.045, 0.32, 4, 8), body, 0, 0.18, -0.04);
        t.rotation.x = -0.5;
        tail.add(t);
        p.add(tail);
        this.extras.tail = tail;
        break;
      }
      case 'bobo': {
        for (const s of [-1, 1]) {
          p.add(mesh(new THREE.SphereGeometry(0.095, 12, 10), body, s * 0.2, 1.07, 0));
          p.add(mesh(new THREE.SphereGeometry(0.05, 10, 8), light(0xd9a77a), s * 0.2, 1.07, 0.05));
        }
        const muzzle = mesh(new THREE.SphereGeometry(0.12, 14, 10), light(0xe8c9a0), 0, 0.8, 0.2);
        muzzle.scale.set(1, 0.85, 0.8);
        p.add(muzzle);
        p.add(mesh(new THREE.SphereGeometry(0.04, 8, 6), dark, 0, 0.85, 0.3));
        const hat = new THREE.Group();
        hat.position.set(0.03, 1.12, 0);
        hat.rotation.z = -0.22;
        hat.add(mesh(new THREE.ConeGeometry(0.13, 0.32, 16), mat(0xe53970), 0, 0.16, 0));
        hat.add(mesh(new THREE.SphereGeometry(0.05, 10, 8), mat(0xffd23f), 0, 0.34, 0));
        const band = mesh(new THREE.TorusGeometry(0.1, 0.014, 6, 16), mat(0xffd23f), 0, 0.07, 0);
        band.rotation.x = Math.PI / 2;
        hat.add(band);
        p.add(hat);
        this.extras.hat = hat;
        break;
      }
      case 'pipi': {
        const belly = mesh(new THREE.SphereGeometry(0.19, 16, 12), white, 0, 0.4, 0.07);
        belly.scale.set(0.9, 1.25, 0.6);
        p.add(belly);
        const face = mesh(new THREE.SphereGeometry(0.17, 16, 12), white, 0, 0.82, 0.12);
        face.scale.set(1.1, 0.9, 0.7);
        p.add(face);
        const beak = mesh(new THREE.ConeGeometry(0.06, 0.15, 10), mat(0xff9f1c), 0, 0.83, 0.31);
        beak.rotation.x = Math.PI / 2;
        p.add(beak);
        break;
      }
      case 'rara': {
        const stem = mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.2, 8), mat(0x7b8190), 0, 1.19, 0);
        p.add(stem);
        const bulb = mesh(new THREE.SphereGeometry(0.05, 12, 10), mat(0xff3b3b, { emissive: 0xff1010, emissiveIntensity: 2 }), 0, 1.3, 0);
        p.add(bulb);
        this.extras.bulb = bulb;
        for (const s of [-1, 1]) {
          const bolt = mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.06, 12), mat(0x7b8190, { metalness: 0.6 }), s * 0.28, 0.88, 0);
          bolt.rotation.z = Math.PI / 2;
          p.add(bolt);
        }
        p.add(mesh(new THREE.BoxGeometry(0.16, 0.1, 0.02), mat(0x2b303b), 0, 0.42, 0.165));
        break;
      }
      case 'dino': {
        const snout = mesh(new THREE.SphereGeometry(0.15, 14, 10), light(0x6fdc7e), 0, 0.8, 0.22);
        snout.scale.set(1, 0.75, 1.0);
        p.add(snout);
        const spikeMat = mat(0xff9f1c);
        [1.1, 0.78, 0.55, 0.36].forEach((y, i) => {
          const spike = mesh(new THREE.ConeGeometry(0.06 - i * 0.005, 0.13, 6), spikeMat, 0, y, -0.25 + (i === 0 ? 0.12 : 0));
          spike.rotation.x = -0.7;
          p.add(spike);
        });
        const tail = new THREE.Group();
        tail.position.set(0, 0.28, -0.14);
        tail.rotation.x = -Math.PI / 2 - 0.3;
        tail.add(mesh(new THREE.ConeGeometry(0.16, 0.55, 12), body, 0, 0.27, 0));
        p.add(tail);
        this.extras.tail = tail;
        break;
      }
      case 'mimi': {
        for (const s of [-1, 1]) {
          const ear = new THREE.Group();
          ear.position.set(s * 0.1, 1.08, 0);
          ear.rotation.z = -s * 0.15;
          ear.add(mesh(new THREE.CapsuleGeometry(0.07, 0.3, 4, 10), body, 0, 0.2, 0));
          const inner = mesh(new THREE.CapsuleGeometry(0.036, 0.22, 4, 8), light(0xffd6ea), 0, 0.2, 0.04);
          ear.add(inner);
          p.add(ear);
          this.extras[s < 0 ? 'earL' : 'earR'] = ear;
        }
        p.add(mesh(new THREE.SphereGeometry(0.1, 12, 10), white, 0, 0.22, -0.2));
        p.add(mesh(new THREE.SphereGeometry(0.032, 8, 6), light(0xff6f91), 0, 0.855, 0.265));
        for (const s of [-1, 1]) {
          const cheek = mesh(new THREE.SphereGeometry(0.04, 8, 6), light(0xff6f91), s * 0.17, 0.8, 0.2);
          cheek.scale.z = 0.5;
          p.add(cheek);
        }
        break;
      }
    }
  }

  // ───────────────────────── Animasi ─────────────────────────

  setPose(mode: Pose): void {
    this.mode = mode;
  }

  update(dt: number, t: number): void {
    const ph = this.phase;
    let py = 0;
    let rx = 0;
    let rz = 0;
    let sy = 1;
    let aL = 0.15;
    let aR = 0.15;
    const idleSway = Math.sin(t * 2.2 + ph);

    switch (this.mode) {
      case 'idle':
        py = idleSway * 0.012;
        sy = 1 + idleSway * 0.02;
        aL = aR = 0.15 + Math.sin(t * 2 + ph) * 0.06;
        if (this.def.id === 'pipi') rz = Math.sin(t * 3 + ph) * 0.05;
        break;
      case 'cheer':
        py = Math.abs(Math.sin(t * 9 + ph)) * 0.18;
        aL = aR = 2.5 + Math.sin(t * 15) * 0.35;
        rz = Math.sin(t * 9) * 0.08;
        break;
      case 'sad':
        rx = 0.3;
        sy = 0.9;
        aL = aR = 0.02;
        py = -0.015;
        break;
      case 'scared':
        rz = Math.sin(t * 38) * 0.14;
        sy = 1.08;
        aL = aR = 2.2 + Math.sin(t * 30) * 0.25;
        break;
      case 'climb': {
        const s = Math.sin(t * 13);
        rz = s * 0.14;
        aL = 1.7 + s * 0.9;
        aR = 1.7 - s * 0.9;
        break;
      }
    }

    const k = 1 - Math.exp(-dt * 14);
    const pose = this.pose;
    pose.position.y += (py - pose.position.y) * k;
    pose.rotation.x += (rx - pose.rotation.x) * k;
    pose.rotation.z += (rz - pose.rotation.z) * k;
    const scaleY = 0.72 * (sy - this.squash * 0.28);
    const scaleXZ = 0.72 * (1 + this.squash * 0.16);
    pose.scale.set(scaleXZ, scaleY, scaleXZ);
    this.armL.rotation.z += (-aL - this.armL.rotation.z) * k;
    this.armR.rotation.z += (aR - this.armR.rotation.z) * k;

    const fast = this.mode === 'cheer' ? 2 : 1;
    const { tail, bulb, hat, earL, earR } = this.extras;
    if (tail) {
      if (this.def.id === 'kiko') tail.rotation.y = Math.sin(t * 6 * fast + ph) * 0.6;
      else tail.rotation.z = Math.sin(t * 3 * fast + ph) * 0.25;
    }
    if (bulb) {
      (bulb as THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>).material.emissiveIntensity =
        Math.sin(t * 6 + ph) > 0 ? 3 : 0.3;
    }
    if (hat) hat.rotation.z = -0.22 + Math.sin(t * 2.4 + ph) * 0.06;
    if (earL && earR) {
      earL.rotation.z = 0.15 + Math.sin(t * 2.6 + ph) * 0.07 + (this.mode === 'sad' ? 0.7 : 0);
      earR.rotation.z = -0.15 - Math.sin(t * 2.6 + ph + 1) * 0.07 - (this.mode === 'sad' ? 0.7 : 0);
    }
  }

  faceYaw(angle: number, duration = 0.14): void {
    const cur = this.root.rotation.y;
    const delta = Math.atan2(Math.sin(angle - cur), Math.cos(angle - cur));
    gsap.to(this.root.rotation, { y: cur + delta, duration, ease: 'power2.out' });
  }

  faceCamera(): void {
    this.faceYaw(0, 0.25);
  }

  private landSquash(): void {
    gsap.fromTo(this, { squash: 1 }, { squash: 0, duration: 0.35, ease: 'elastic.out(1, 0.45)' });
  }

  /** Lompat satu petak (lintasan parabola). */
  hopTo(target: THREE.Vector3, duration = 0.28, height = this.hopHeight): Promise<void> {
    const from = this.root.position.clone();
    if (Math.hypot(target.x - from.x, target.z - from.z) > 0.01) {
      this.faceYaw(Math.atan2(target.x - from.x, target.z - from.z));
    }
    const o = { p: 0 };
    return new Promise((resolve) => {
      gsap.to(o, {
        p: 1,
        duration,
        ease: 'none',
        onUpdate: () => {
          this.root.position.lerpVectors(from, target, o.p);
          this.root.position.y += Math.sin(o.p * Math.PI) * height;
        },
        onComplete: () => {
          this.root.position.copy(target);
          this.landSquash();
          resolve();
        },
      });
    });
  }

  /** Bergerak mengikuti fungsi lintasan (tangga / tubuh ular). */
  moveAlong(
    pointAt: (t: number) => THREE.Vector3,
    duration: number,
    ease = 'none',
  ): Promise<void> {
    const prev = new THREE.Vector3();
    const o = { t: 0 };
    return new Promise((resolve) => {
      gsap.to(o, {
        t: 1,
        duration,
        ease,
        onUpdate: () => {
          prev.copy(this.root.position);
          this.root.position.copy(pointAt(o.t));
          const dx = this.root.position.x - prev.x;
          const dz = this.root.position.z - prev.z;
          if (Math.hypot(dx, dz) > 0.002) {
            const a = Math.atan2(dx, dz);
            const cur = this.root.rotation.y;
            this.root.rotation.y = cur + Math.atan2(Math.sin(a - cur), Math.cos(a - cur)) * 0.2;
          }
        },
        onComplete: () => resolve(),
      });
    });
  }

  /** Pindah halus ke posisi (penataan ulang pion di satu petak). */
  settleTo(target: THREE.Vector3, duration = 0.25): void {
    gsap.to(this.root.position, { x: target.x, y: target.y, z: target.z, duration, ease: 'power2.out' });
  }

  /** Muncul dengan efek pop (podium). */
  popIn(): void {
    this.root.scale.setScalar(0.01);
    gsap.to(this.root.scale, { x: 1, y: 1, z: 1, duration: 0.5, ease: 'back.out(2.2)' });
  }

  /** Teks dampak komik besar di atas pion (mis. "BOOM!" / "−40"); beberapa bisa tampil bertumpuk. */
  showImpact(text: string, kind: 'hit' | 'big' | 'shield' | 'heal' | 'ko', delay = 0): void {
    window.setTimeout(() => {
      const el = document.createElement('span');
      el.className = `char-impact ${kind}`;
      el.textContent = text;
      el.style.setProperty('--tilt', `${Math.round((Math.random() - 0.5) * 24)}deg`);
      this.labelEl.append(el);
      window.setTimeout(() => el.remove(), 1500);
    }, delay);
  }

  showEmote(emoji: string, ms = 1800): void {
    this.emoteEl.textContent = emoji;
    this.emoteEl.classList.remove('show');
    void this.emoteEl.offsetWidth; // restart animasi CSS
    this.emoteEl.classList.add('show');
    window.clearTimeout(this.emoteTimer);
    this.emoteTimer = window.setTimeout(() => this.emoteEl.classList.remove('show'), ms);
  }

  dispose(): void {
    gsap.killTweensOf(this);
    gsap.killTweensOf(this.root.position);
    gsap.killTweensOf(this.root.rotation);
    gsap.killTweensOf(this.root.scale);
    window.clearTimeout(this.emoteTimer);
    this.labelEl.remove();
    this.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
      if (m.material) (Array.isArray(m.material) ? m.material : [m.material]).forEach((x) => x.dispose());
    });
    this.root.removeFromParent();
  }
}
