import type { AudioManager } from '../audio/AudioManager';
import { CHARACTERS } from '../config';
import type { Game } from '../core/Game';
import { onLangChange, t } from '../i18n';
import type { NetworkClient } from '../network/NetworkClient';
import {
  FIGHT_BEAT_MS,
  FIGHT_HIT_AT,
  FIGHT_HP,
  FIGHT_ROUND_MS,
  FIGHT_WINDOWS,
  judgeBeat,
  type Arrow,
  type FightInfo,
  type Grade,
  type ServerMsg,
} from '../network/protocol';
import { h, setVisible } from './dom';
import { icon } from './icons';

type Hit = Extract<ServerMsg, { t: 'fight_hit' }>;
type End = Extract<ServerMsg, { t: 'fight_end' }>;
type Progress = Extract<ServerMsg, { t: 'fight_progress' }>;

const KEYS: Record<string, Arrow> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  KeyW: 'up',
  KeyS: 'down',
  KeyA: 'left',
  KeyD: 'right',
};
/** layar hasil duel tampil selama ini; game menunggu ±2,2 dtk lalu pion yang kalah melompat ke Start */
const RESULT_MS = 2800;
/** hitung mundur menampilkan "FIGHT!" pada sisa waktu ini (ms) */
const GO_MS = 600;
const ZONE = FIGHT_WINDOWS.find(([g]) => g === 'cool')![1];
const PERFECT = FIGHT_WINDOWS[0][1];

const hex = (n: number) => '#' + n.toString(16).padStart(6, '0');

interface FighterView {
  el: HTMLElement;
  fill: HTMLElement;
  hpText: HTMLElement;
  combo: HTMLElement;
  /** progres panah petarung ini pada ronde berjalan (live untuk pemain lain & penonton) */
  lane: HTMLElement;
  pop: HTMLElement;
  popTimer: number;
}

interface LaneState {
  round: number;
  typed: number;
  /** sudah menyerang pada ronde ini (nilai dari server) */
  grade: Grade | null;
}

/**
 * Duel ala Ayo Dance di layar tiap pemain yang berhenti di petak yang sama: tiap ronde ketik urutan
 * panah, lalu tekan Spasi saat kursor ketukan melewati zona. Penilaian (perfect…miss) dikirim ke
 * server; server menghitung damage + combo, HP, dan pemenang. Pemain lain & penonton menonton.
 */
export class FightOverlay {
  readonly el = h('div', { class: 'fight hidden', role: 'dialog', 'aria-modal': 'false' });
  private title = h('div', { class: 'fight-title' });
  private livePill = h('span', { class: 'fight-live' });
  private head = h('div', { class: 'fight-head' });
  private count = h('div', { class: 'fight-count hidden' });
  private roundLabel = h('div', { class: 'fight-round' });
  private arrows = h('div', { class: 'fight-arrows' });
  private cursor = h('i', { class: 'beat-cursor' });
  private bar = h(
    'div',
    { class: 'beat-bar' },
    h('div', { class: 'beat-zone', style: { left: `${(FIGHT_HIT_AT - ZONE) * 100}%`, width: `${ZONE * 200}%` } }),
    h('div', { class: 'beat-perfect', style: { left: `${(FIGHT_HIT_AT - PERFECT) * 100}%`, width: `${PERFECT * 200}%` } }),
    this.cursor,
  );
  private judge = h('div', { class: 'fight-judge' });
  private hint = h('div', { class: 'fight-hint' });
  private pad = h('div', { class: 'fight-pad' });
  private result = h('div', { class: 'fight-result hidden' });

  private info: FightInfo | null = null;
  /** performance.now() saat ronde pertama dimulai */
  private t0 = 0;
  private raf = 0;
  private round = -1;
  private typed = 0;
  private sent = false;
  private ended = false;
  private views = new Map<string, FighterView>();
  private lanes = new Map<string, LaneState>();
  private lastCount = '';
  private closeTimer = 0;
  private judgeTimer = 0;

  constructor(
    private net: NetworkClient,
    private game: Game,
    private audio: AudioManager,
  ) {
    this.el.append(
      h(
        'div',
        { class: 'fight-card' },
        this.title,
        this.head,
        h('div', { class: 'fight-stage' }, this.roundLabel, this.arrows, this.bar, this.judge, this.count, this.result),
        this.hint,
        this.pad,
      ),
    );
    this.buildPad();
    net.on('fight_start', ({ fight }) => this.open(fight));
    net.on('fight_hit', (m) => this.onHit(m));
    net.on('fight_progress', (m) => this.onProgress(m));
    net.on('room_state', () => this.updateLive());
    net.on('fight_end', (m) => this.onEnd(m));
    net.on('kicked', () => this.close());
    net.on('left', () => this.close());
    game.bus.on('game:exit', () => this.close());
    onLangChange(() => this.info && this.renderStatic());
    // fase capture: panah & Spasi milik duel, tidak sampai ke HUD (lempar dadu / ekspresi)
    window.addEventListener('keydown', (e) => this.onKey(e), true);
  }

  private get myId(): string {
    return this.net.myId;
  }

  /** Perangkat ini ikut bertarung dan masih berdiri. */
  private get fighting(): boolean {
    const f = this.info;
    return !!f && !this.ended && !this.net.isSpectator && f.fighters.includes(this.myId) && (f.hp[this.myId] ?? 0) > 0;
  }

  // ───────────────────────── Siklus ─────────────────────────

  private open(info: FightInfo): void {
    const same = this.info?.id === info.id && !this.ended;
    window.clearTimeout(this.closeTimer);
    this.info = info;
    this.t0 = performance.now() + info.startsIn;
    if (!same) {
      // duel baru (bukan penyegaran karena ada yang keluar / masuk kembali di tengah duel)
      this.round = -1;
      this.typed = 0;
      this.sent = false;
      this.ended = false;
      this.lastCount = '';
      this.judge.textContent = '';
      this.lanes.clear();
      setVisible(this.result, false);
    }
    this.renderStatic();
    setVisible(this.el, true);
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(() => this.loop());
  }

  private close(): void {
    cancelAnimationFrame(this.raf);
    window.clearTimeout(this.closeTimer);
    this.info = null;
    this.ended = true;
    setVisible(this.el, false);
  }

  private loop(): void {
    const f = this.info;
    if (!f || this.ended) return;
    const now = performance.now();
    if (now < this.t0) {
      const rem = this.t0 - now;
      const label = rem > GO_MS ? String(Math.ceil((rem - GO_MS) / 1000)) : t('fight.go');
      if (label !== this.lastCount) {
        this.lastCount = label;
        this.count.textContent = label;
        this.count.classList.toggle('go', rem <= GO_MS);
        setVisible(this.count, true);
        this.restartAnim(this.count);
        this.audio.playSfx(rem > GO_MS ? 'fight_count' : 'fight_go');
      }
      this.cursor.style.opacity = '0';
      if (this.round < 0) this.enterRound(0, true);
    } else {
      if (this.lastCount) {
        this.lastCount = '';
        setVisible(this.count, false);
      }
      const r = Math.floor((now - this.t0) / FIGHT_ROUND_MS);
      if (r < f.rounds.length) {
        if (r !== this.round) this.enterRound(r);
        const c = this.cursorAt(now);
        if (c <= 1) {
          this.cursor.style.opacity = '1';
          this.cursor.style.left = `${c * 100}%`;
        } else {
          this.cursor.style.opacity = '0';
          // kursor lewat tanpa Spasi = miss (combo putus)
          if (!this.sent && this.fighting) this.submit('miss');
        }
      } else {
        this.cursor.style.opacity = '0';
      }
    }
    this.raf = requestAnimationFrame(() => this.loop());
  }

  /** Posisi kursor ketukan pada ronde berjalan (0..1, >1 = sudah lewat). */
  private cursorAt(now = performance.now()): number {
    return (now - this.t0 - this.round * FIGHT_ROUND_MS) / FIGHT_BEAT_MS;
  }

  private enterRound(r: number, preview = false): void {
    this.round = r;
    this.typed = 0;
    this.sent = false;
    if (!preview) this.judge.textContent = '';
    this.lanes.clear();
    this.roundLabel.textContent = t('fight.round', { n: r + 1, total: this.info!.rounds.length });
    this.renderArrows();
    this.renderLanes();
  }

  // ───────────────────────── Input ─────────────────────────

  private canInput(): boolean {
    const f = this.info;
    if (!f || !this.fighting || this.sent) return false;
    const now = performance.now();
    return now >= this.t0 && this.round >= 0 && this.round < f.rounds.length && this.cursorAt(now) <= 1;
  }

  private onKey(e: KeyboardEvent): void {
    if (!this.fighting || isTyping(e)) return;
    const arrow = KEYS[e.code];
    const hit = e.code === 'Space' || e.code === 'Enter';
    if (!arrow && !hit) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.repeat) return;
    if (arrow) this.press(arrow);
    else this.hit();
  }

  private press(arrow: Arrow): void {
    if (!this.canInput()) return;
    const seq = this.info!.rounds[this.round];
    if (this.typed >= seq.length) return;
    const wrong = seq[this.typed] !== arrow;
    if (!wrong) {
      this.typed++;
      this.audio.playSfx('arrow_ok', this.typed);
    } else {
      // salah satu panah: urutan diulang dari awal (seperti Ayo Dance)
      this.typed = 0;
      this.audio.playSfx('arrow_bad');
      this.arrows.classList.remove('wrong');
      void this.arrows.offsetWidth;
      this.arrows.classList.add('wrong');
    }
    this.renderArrows();
    // siarkan ketikan agar pemain lain & penonton di room melihat duel berjalan live
    const f = this.info!;
    this.net.send({ t: 'fight_progress', id: f.id, round: this.round, typed: this.typed, ...(wrong ? { wrong } : {}) });
  }

  private hit(): void {
    if (!this.canInput()) return;
    const seq = this.info!.rounds[this.round];
    // Spasi sebelum urutan lengkap = miss
    this.submit(this.typed === seq.length ? judgeBeat(this.cursorAt()) : 'miss');
  }

  private submit(grade: Grade): void {
    const f = this.info!;
    this.sent = true;
    this.net.send({ t: 'fight_input', id: f.id, round: this.round, grade });
    this.showJudge(grade, 0);
    if (grade === 'miss') this.audio.playSfx('fight_miss');
  }

  // ───────────────────────── Pesan server ─────────────────────────

  private onHit(m: Hit): void {
    const f = this.info;
    if (!f || m.id !== f.id) return;
    f.hp = m.hp;
    f.combo[m.playerId] = m.combo;
    this.updateHp();
    const v = this.views.get(m.playerId);
    if (v) {
      v.combo.textContent = m.combo >= 2 ? t('fight.combo', { n: m.combo }) : '';
      this.popOn(v, m.damage > 0 ? `${t(`fight.grade.${m.grade}`)} −${m.damage}` : t(`fight.grade.${m.grade}`), m.grade);
    }
    if (m.damage > 0) {
      for (const id of f.fighters) {
        if (id === m.playerId) continue;
        const o = this.views.get(id);
        if (!o) continue;
        o.el.classList.remove('hurt');
        void o.el.offsetWidth;
        o.el.classList.add('hurt');
      }
      this.audio.playSfx('fight_hit', m.grade === 'perfect' ? 1 : m.grade === 'great' ? 0.7 : 0.4);
    }
    if (m.playerId === this.myId && m.grade !== 'miss') this.showJudge(m.grade, m.combo);
    if (m.round === this.round) {
      const prev = this.lanes.get(m.playerId);
      this.lanes.set(m.playerId, { round: m.round, typed: prev?.round === m.round ? prev.typed : 0, grade: m.grade });
      this.renderLanes();
    }
  }

  private onProgress(m: Progress): void {
    const f = this.info;
    if (!f || m.id !== f.id || m.playerId === this.myId || this.ended) return;
    // pesan bisa tiba sesaat sebelum ronde lokal berganti: ikuti ronde server
    if (m.round > this.round && m.round < f.rounds.length) this.enterRound(m.round);
    if (m.round !== this.round) return;
    if (this.lanes.get(m.playerId)?.grade) return;
    this.lanes.set(m.playerId, { round: m.round, typed: m.typed, grade: null });
    this.renderLanes();
    if (m.wrong) {
      const lane = this.views.get(m.playerId)?.lane;
      if (lane) this.restartAnim(lane, 'wrong');
    }
  }

  private onEnd(m: End): void {
    const f = this.info;
    if (!f || m.id !== f.id) return;
    this.ended = true;
    cancelAnimationFrame(this.raf);
    this.cursor.style.opacity = '0';
    setVisible(this.count, false);
    const ko = m.losers.some((id) => (f.hp[id] ?? 0) <= 0);
    const winner = this.game.state?.players.find((p) => p.id === m.winnerId);
    const me = this.myId;
    const lines: string[] = [m.losers.length ? (ko ? t('fight.ko') : t('fight.timeUp')) : ''];
    if (m.winnerId === me) lines.push(t('fight.youWin'));
    else if (m.losers.includes(me)) lines.push(t('fight.youLose'));
    else if (winner) lines.push(t('fight.win', { name: winner.name }));
    this.result.replaceChildren(...lines.filter(Boolean).map((s, i) => h(i === 0 ? 'b' : 'span', null, s)));
    this.result.classList.toggle('lose', m.losers.includes(me));
    setVisible(this.result, true);
    this.restartAnim(this.result);
    for (const [id, v] of this.views) {
      v.el.classList.toggle('winner', id === m.winnerId);
      v.el.classList.toggle('loser', m.losers.includes(id));
    }
    if (m.losers.length) this.audio.playSfx('fight_ko');
    this.closeTimer = window.setTimeout(() => this.close(), RESULT_MS);
  }

  // ───────────────────────── Tampilan ─────────────────────────

  private renderStatic(): void {
    const f = this.info!;
    const fighting = this.fighting;
    this.el.classList.toggle('watching', !fighting);
    this.title.replaceChildren(h('span', null, '⚔️'), t('fight.title'), h('small', null, t('hud.tile', { n: f.tile })), this.livePill);
    this.updateLive();
    this.views.clear();
    const players = this.game.state?.players ?? [];
    const cards = f.fighters.map((id) => {
      const p = players.find((x) => x.id === id);
      const fill = h('i', { style: { background: hex(p?.color ?? 0xffffff) } });
      const hpText = h('small', { class: 'hp-num' });
      const combo = h('span', { class: 'fighter-combo' });
      const lane = h('div', { class: 'fighter-lane' });
      const pop = h('span', { class: 'fighter-pop' });
      const el = h(
        'div',
        { class: `fighter ${id === this.myId ? 'me' : ''}`, style: { '--c': hex(p?.color ?? 0xffffff) } },
        h('span', { class: 'fighter-emoji' }, CHARACTERS.find((c) => c.id === p?.character)?.emoji ?? '🎲'),
        h(
          'div',
          { class: 'fighter-info' },
          h('b', null, p?.name ?? '?', id === this.myId ? h('em', null, t('hud.you')) : null),
          h('div', { class: 'hp-bar' }, fill),
          h('div', { class: 'fighter-meta' }, hpText, combo),
          lane,
        ),
        pop,
      );
      const view: FighterView = { el, fill, hpText, combo, lane, pop, popTimer: 0 };
      combo.textContent = (f.combo[id] ?? 0) >= 2 ? t('fight.combo', { n: f.combo[id] }) : '';
      this.views.set(id, view);
      return el;
    });
    const withVs: HTMLElement[] = [];
    cards.forEach((c, i) => {
      if (i > 0) withVs.push(h('span', { class: 'fight-vs' }, 'VS'));
      withVs.push(c);
    });
    this.head.replaceChildren(...withVs);
    this.updateHp();
    const touch = matchMedia('(pointer: coarse)').matches;
    this.hint.textContent = fighting ? t(touch ? 'fight.hintTouch' : 'fight.hint') : t('fight.watch');
    setVisible(this.pad, fighting);
    if (this.round >= 0) this.roundLabel.textContent = t('fight.round', { n: this.round + 1, total: f.rounds.length });
    this.renderArrows();
    this.renderLanes();
  }

  /** Pil LIVE + jumlah penonton room di judul duel. */
  private updateLive(): void {
    if (!this.info) return;
    const n = this.net.room?.viewers.length ?? 0;
    this.livePill.replaceChildren(h('i', { class: 'live-dot' }), 'LIVE', icon('eye'), String(n));
    this.livePill.title = t('live.viewers', { n });
  }

  /** Progres panah tiap petarung pada ronde berjalan (kartu sendiri disembunyikan lewat CSS saat bertarung). */
  private renderLanes(): void {
    const f = this.info;
    const seq = f && this.round >= 0 ? (f.rounds[this.round] ?? []) : [];
    for (const [id, v] of this.views) {
      const st = this.lanes.get(id);
      const typed = st && st.round === this.round ? st.typed : 0;
      const grade = st && st.round === this.round ? st.grade : null;
      v.lane.replaceChildren(...seq.map((a, i) => h('span', { class: `lane-arrow dir-${a} ${i < typed ? 'ok' : ''}` }, icon('arrow'))));
      v.lane.className = `fighter-lane ${grade ? `hit grade-${grade}` : typed === seq.length && seq.length ? 'ready' : ''}`;
    }
  }

  private updateHp(): void {
    const f = this.info;
    if (!f) return;
    for (const [id, v] of this.views) {
      const hp = Math.max(0, f.hp[id] ?? 0);
      v.fill.style.width = `${(hp / FIGHT_HP) * 100}%`;
      v.hpText.textContent = `HP ${hp}`;
      v.el.classList.toggle('low', hp > 0 && hp <= FIGHT_HP * 0.3);
      v.el.classList.toggle('down', hp <= 0);
    }
  }

  private renderArrows(): void {
    const f = this.info;
    const seq = f && this.round >= 0 ? (f.rounds[this.round] ?? []) : [];
    this.arrows.replaceChildren(
      ...seq.map((a, i) => h('span', { class: `arrow dir-${a} ${i < this.typed ? 'ok' : ''}` }, icon('arrow'))),
    );
    this.arrows.classList.toggle('done', seq.length > 0 && this.typed === seq.length);
  }

  private showJudge(grade: Grade, combo: number): void {
    this.judge.replaceChildren(h('b', { class: `grade-${grade}` }, t(`fight.grade.${grade}`)));
    if (combo >= 2) this.judge.append(h('span', null, t('fight.combo', { n: combo })));
    this.restartAnim(this.judge);
    window.clearTimeout(this.judgeTimer);
    this.judgeTimer = window.setTimeout(() => (this.judge.textContent = ''), 1100);
  }

  private popOn(v: FighterView, text: string, grade: Grade): void {
    v.pop.textContent = text;
    v.pop.className = `fighter-pop grade-${grade}`;
    this.restartAnim(v.pop, 'show');
    window.clearTimeout(v.popTimer);
    v.popTimer = window.setTimeout(() => v.pop.classList.remove('show'), 1000);
  }

  private restartAnim(el: HTMLElement, cls = 'pop'): void {
    el.classList.remove(cls);
    void el.offsetWidth;
    el.classList.add(cls);
  }

  /** Tombol layar sentuh: empat panah + HIT. */
  private buildPad(): void {
    const btn = (a: Arrow) =>
      h(
        'button',
        {
          class: `pad-btn arrow dir-${a}`,
          'aria-label': a,
          onpointerdown: (e: Event) => {
            e.preventDefault();
            this.press(a);
          },
        },
        icon('arrow'),
      );
    this.pad.append(
      h('div', { class: 'pad-arrows' }, btn('left'), btn('up'), btn('down'), btn('right')),
      h(
        'button',
        {
          class: 'pad-btn pad-hit',
          onpointerdown: (e: Event) => {
            e.preventDefault();
            this.hit();
          },
        },
        t('fight.hit'),
      ),
    );
  }
}

function isTyping(e: KeyboardEvent): boolean {
  const el = e.target as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
}
