import { CHARACTERS, CHARGE_FILL_SECONDS, CHARGE_OVERHEAT_GRACE, CHARGE_PERFECT_FROM, TILE_COUNT } from '../config';
import type { Game } from '../core/Game';
import { onLangChange, t } from '../i18n';
import { EXPRESSIONS, expressionEmoji, type ExpressionId } from '../network/protocol';
import { settings } from '../utils/settings';
import { h, setVisible } from './dom';
import { icon } from './icons';

interface Card {
  el: HTMLElement;
  info: HTMLElement;
  bar: HTMLElement;
  bubble: HTMLElement;
  bubbleTimer: number;
}

/** jeda minimal antar ekspresi dari perangkat ini (server juga membatasi) */
const EXPRESSION_COOLDOWN_MS = 1200;

const hex = (n: number) => '#' + n.toString(16).padStart(6, '0');

/** Overlay in-game: daftar pemain, tombol LEMPAR DADU, banner giliran, hasil dadu, log, kontrol. */
export class HUD {
  readonly el = h('div', { class: 'hud hidden' });
  private players = h('div', { class: 'hud-players' });
  private banner = h('div', { class: 'banner' });
  private dicePop = h('div', { class: 'dice-pop' });
  private log = h('div', { class: 'hud-log' });
  private rollBtn = h('button', { class: 'roll-btn' });
  private hint = h('div', { class: 'roll-hint' });
  private timer = h('div', { class: 'turn-timer hidden' });
  private exprPop = h('div', { class: 'expr-pop hidden', role: 'menu' });
  private exprToggle = h('button', { class: 'icon-btn expr-toggle', 'aria-haspopup': 'menu', onclick: () => this.toggleExpressions() }, icon('smile'));
  private exprDock = h('div', { class: 'expr-dock' }, this.exprPop, this.exprToggle);
  private livePill = h('div', { class: 'live-pill hidden' });
  /** online: menunggu pemain pengganti / slot kosong yang bisa diisi */
  private notice = h('div', { class: 'hud-notice hidden' });
  private chargeFill = h('i');
  private charge = h(
    'div',
    { class: 'charge' },
    h('div', { class: 'charge-zone', style: { left: `${CHARGE_PERFECT_FROM * 100}%` } }),
    this.chargeFill,
  );
  /** waktu mulai menahan (ms); null = tidak sedang mengisi */
  private chargeStart: number | null = null;
  private chargeRaf = 0;
  private cards = new Map<string, Card>();
  private speedBtn = h('button', { class: 'icon-btn', onclick: () => settings.set('fastBots', !settings.get('fastBots')) });
  private cameraBtn = h('button', { class: 'icon-btn', onclick: () => this.cb.onResetCamera() }, icon('camera'));
  private soundBtn = h('button', { class: 'icon-btn', onclick: () => settings.set('muted', !settings.get('muted')) });
  private pauseBtn = h('button', { class: 'icon-btn', onclick: () => this.cb.onPause() }, icon('pause'));
  private bannerTimer = 0;
  private popTimer = 0;
  private visible = false;
  /** pemain yang gilirannya sedang berjalan (state.current sudah maju lebih dulu saat animasi) */
  private activeId = '';
  private deadline: { playerId: string; at: number } | null = null;
  private exprLockedUntil = 0;

  constructor(
    private game: Game,
    private cb: { onPause(): void; onResetCamera(): void },
  ) {
    this.speedBtn.append(icon('fast'));
    const controls = h('div', { class: 'hud-controls' }, this.speedBtn, this.cameraBtn, this.soundBtn, this.pauseBtn);
    this.el.append(
      this.players,
      controls,
      this.livePill,
      this.notice,
      this.banner,
      this.dicePop,
      this.log,
      this.exprDock,
      h('div', { class: 'hud-bottom' }, this.timer, this.charge, this.rollBtn, this.hint),
    );
    // klik di luar panel ekspresi menutupnya
    document.addEventListener('pointerdown', (e) => {
      if (!this.exprDock.contains(e.target as Node)) this.toggleExpressions(false);
    });
    // tahan untuk mengisi tenaga, lepas untuk melempar
    this.rollBtn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.rollBtn.setPointerCapture(e.pointerId);
      this.beginCharge();
    });
    for (const ev of ['pointerup', 'pointercancel'] as const) {
      this.rollBtn.addEventListener(ev, () => this.endCharge(false));
    }
    this.refreshStatic();
    onLangChange(() => this.refreshStatic());
    settings.subscribe((_s, k) => {
      if (k === 'fastBots' || k === 'muted') this.refreshStatic();
    });

    const bus = game.bus;
    bus.on('game:start', () => this.onStart());
    bus.on('game:exit', () => this.hide());
    bus.on('game:win', () => {
      this.updateRoll();
      this.refresh();
    });
    bus.on('turn:start', ({ playerId }) => {
      this.activeId = playerId;
      this.refresh();
      this.updateRoll();
    });
    bus.on('turn:deadline', ({ playerId, deadline }) => {
      this.deadline = { playerId, at: deadline };
    });
    bus.on('net:room', ({ room }) => {
      for (const p of room.players) this.cards.get(p.id)?.el.classList.toggle('offline', !p.connected);
      this.renderLive(room.viewers.length);
      this.renderNotice();
      this.updateRoll();
    });
    bus.on('fight:start', () => this.updateRoll());
    bus.on('fight:end', () => {
      this.refresh();
      this.updateRoll();
    });
    bus.on('expression', ({ playerId, spectator, id }) => {
      if (!spectator) this.cardBubble(playerId, id);
    });
    bus.on('phase', () => {
      this.updateRoll();
      if (game.machine.phase !== 'AWAIT_ROLL') this.cancelCharge();
    });
    bus.on('pause', () => this.cancelCharge());
    bus.on('move:step', () => this.refresh());
    bus.on('dice:rolled', ({ value }) => this.popDice(value));
    bus.on('ui:banner', ({ text, kind }) => this.showBanner(text, kind));
    bus.on('ui:log', ({ text }) => this.addLog(text));

    // penghitung mundur giliran (online)
    window.setInterval(() => this.tickTimer(), 400);

    window.addEventListener('keydown', (e) => {
      if (!this.visible || isTyping(e)) return;
      if (e.code === 'Space' || e.code === 'Enter') {
        e.preventDefault();
        if (!e.repeat) this.beginCharge();
      } else if (e.code === 'Escape' || e.code === 'KeyP') {
        this.cb.onPause();
      } else if (/^Digit[1-8]$/.test(e.code) && !e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey) {
        this.sendExpression(EXPRESSIONS[Number(e.code.slice(5)) - 1].id);
      }
    });
    window.addEventListener('keyup', (e) => {
      if (this.visible && !isTyping(e) && (e.code === 'Space' || e.code === 'Enter')) this.endCharge(false);
    });
    window.addEventListener('blur', () => this.cancelCharge());
  }

  // ───────────────────────── Tenaga lempar ─────────────────────────

  private beginCharge(): void {
    if (this.chargeStart !== null || !this.game.canRoll()) return;
    this.chargeStart = performance.now();
    this.charge.classList.add('active');
    this.charge.classList.remove('overheat', 'perfect');
    this.hint.textContent = '';
    this.game.bus.emit('charge:start', {});
    const tick = () => {
      if (this.chargeStart === null) return;
      const elapsed = (performance.now() - this.chargeStart) / 1000;
      const power = Math.min(1, elapsed / CHARGE_FILL_SECONDS);
      this.chargeFill.style.width = `${power * 100}%`;
      const perfect = power >= CHARGE_PERFECT_FROM;
      this.charge.classList.toggle('perfect', perfect);
      if (perfect) this.hint.textContent = t('hud.charge.perfect');
      this.game.bus.emit('charge:update', { power });
      // terlalu lama menahan setelah penuh: tenaga hangus, lemparan biasa
      if (elapsed > CHARGE_FILL_SECONDS + CHARGE_OVERHEAT_GRACE) {
        this.endCharge(true);
        return;
      }
      this.chargeRaf = requestAnimationFrame(tick);
    };
    this.chargeRaf = requestAnimationFrame(tick);
  }

  /** Lepas tombol: lempar dadu. Perfect bila bar ada di zona hijau dan tidak hangus. */
  private endCharge(overheated: boolean): void {
    if (this.chargeStart === null) return;
    const elapsed = (performance.now() - this.chargeStart) / 1000;
    const power = Math.min(1, elapsed / CHARGE_FILL_SECONDS);
    const perfect = !overheated && power >= CHARGE_PERFECT_FROM;
    this.chargeStart = null;
    cancelAnimationFrame(this.chargeRaf);
    this.charge.classList.remove('active', 'perfect');
    this.charge.classList.toggle('overheat', overheated);
    this.chargeFill.style.width = '0%';
    this.game.bus.emit('charge:end', { power, perfect, overheated });
    if (overheated) this.showBanner(t('hud.charge.overheat'), 'bad');
    this.game.requestRoll({ boost: perfect });
  }

  /** Batalkan tanpa melempar (pause, ganti tab, fase berubah). */
  private cancelCharge(): void {
    if (this.chargeStart === null) return;
    this.chargeStart = null;
    cancelAnimationFrame(this.chargeRaf);
    this.charge.classList.remove('active', 'perfect');
    this.chargeFill.style.width = '0%';
    this.game.bus.emit('charge:end', { power: 0, perfect: false, overheated: false });
  }

  // ───────────────────────── Tampilan ─────────────────────────

  private refreshStatic(): void {
    this.speedBtn.title = t('hud.speed');
    this.speedBtn.classList.toggle('active', settings.get('fastBots'));
    this.soundBtn.replaceChildren(icon(settings.get('muted') ? 'mute' : 'volume'));
    this.soundBtn.title = t('hud.sound');
    this.cameraBtn.title = t('hud.camera');
    this.pauseBtn.title = t('hud.pause');
    this.exprToggle.title = t('expr.title');
    this.exprToggle.setAttribute('aria-label', t('expr.title'));
    this.buildExpressions();
    this.updateRoll();
    if (this.visible) this.refresh();
  }

  private onStart(): void {
    this.cards.clear();
    this.activeId = this.game.state.players[this.game.state.current].id;
    this.deadline = null;
    this.players.replaceChildren();
    this.log.replaceChildren();
    const online = !!this.game.online;
    // tombol percepat hanya berguna melawan komputer
    this.speedBtn.classList.toggle('hidden', online);
    // online: log kejadian pindah ke umpan chat (kiri bawah)
    this.el.classList.toggle('online', online);
    this.el.classList.toggle('spectating', !!this.game.online?.isSpectator);
    this.toggleExpressions(false);
    setVisible(this.livePill, online);
    this.renderLive(this.game.online?.room?.viewers.length ?? 0);
    this.renderNotice();
    for (const p of this.game.state.players) {
      const emoji = CHARACTERS.find((c) => c.id === p.character)?.emoji ?? '🎲';
      const info = h('small');
      const bar = h('i', { style: { background: hex(p.color) } });
      const tag = p.isBot ? t('hud.bot') : online && this.game.isMine(p.id) ? t('hud.you') : null;
      const bubble = h('span', { class: 'pcard-bubble', 'aria-hidden': 'true' });
      const el = h(
        'div',
        { class: 'pcard', style: { '--c': hex(p.color) } },
        h('span', { class: 'pemoji' }, emoji),
        h('div', { class: 'pinfo' }, h('b', null, h('span', { class: 'pname' }, p.name), tag ? h('em', null, tag) : null), info, h('div', { class: 'bar' }, bar)),
        bubble,
      );
      this.players.append(el);
      this.cards.set(p.id, { el, info, bar, bubble, bubbleTimer: 0 });
    }
    if (online && this.game.online?.room) {
      for (const p of this.game.online.room.players) this.cards.get(p.id)?.el.classList.toggle('offline', !p.connected);
    }
    this.visible = true;
    setVisible(this.el, true);
    this.refresh();
    this.updateRoll();
  }

  // ───────────────────────── Ekspresi ─────────────────────────

  private buildExpressions(): void {
    this.exprPop.replaceChildren(
      ...EXPRESSIONS.map((e, i) =>
        h(
          'button',
          { class: 'expr-btn', role: 'menuitem', title: `${t(`expr.${e.id}`)} (${i + 1})`, onclick: () => this.sendExpression(e.id) },
          h('span', { class: 'expr-emoji' }, e.emoji),
          h('span', { class: 'expr-label' }, t(`expr.${e.id}`)),
          h('kbd', null, String(i + 1)),
        ),
      ),
    );
  }

  private toggleExpressions(force?: boolean): void {
    const show = force ?? this.exprPop.classList.contains('hidden');
    setVisible(this.exprPop, show);
    this.exprToggle.classList.toggle('active', show);
    this.exprToggle.setAttribute('aria-expanded', String(show));
  }

  private sendExpression(id: ExpressionId): void {
    const now = Date.now();
    if (now < this.exprLockedUntil) return;
    this.exprLockedUntil = now + EXPRESSION_COOLDOWN_MS;
    this.exprDock.classList.add('locked');
    window.setTimeout(() => this.exprDock.classList.remove('locked'), EXPRESSION_COOLDOWN_MS);
    this.game.expression(id);
  }

  /** Ekspresi pemain juga tampil di kartunya — selalu terlihat walau pionnya di luar layar kamera. */
  private cardBubble(playerId: string, id: ExpressionId): void {
    const card = this.cards.get(playerId);
    if (!card) return;
    card.bubble.textContent = expressionEmoji(id);
    card.bubble.classList.remove('show');
    void card.bubble.offsetWidth; // restart animasi CSS
    card.bubble.classList.add('show');
    window.clearTimeout(card.bubbleTimer);
    card.bubbleTimer = window.setTimeout(() => card.bubble.classList.remove('show'), 2000);
  }

  private renderLive(viewers: number): void {
    const watching = !!this.game.online?.isSpectator;
    this.livePill.replaceChildren(
      h('i', { class: 'live-dot' }),
      'LIVE',
      h('span', { class: 'live-count', title: t('live.viewers', { n: viewers }) }, icon('eye'), String(viewers)),
      ...(watching ? [h('em', null, t('live.watching'))] : []),
    );
  }

  private renderNotice(): void {
    const room = this.game.online?.room;
    const text =
      !room || room.phase !== 'playing'
        ? ''
        : room.waiting
          ? t('hud.waitPlayers', { code: room.code })
          : room.openSlots > 0
            ? t('hud.openSlots', { n: room.openSlots, code: room.code })
            : '';
    this.notice.textContent = text;
    this.notice.classList.toggle('waiting', !!room?.waiting);
    setVisible(this.notice, !!text);
  }

  private hide(): void {
    this.visible = false;
    this.cancelCharge();
    setVisible(this.el, false);
  }

  /** Perbarui daftar pemain dari posisi yang sedang tampil (mengikuti animasi). */
  refresh(): void {
    const s = this.game.state;
    if (!s) return;
    s.players.forEach((p) => {
      const card = this.cards.get(p.id);
      if (!card) return;
      const tile = this.game.displayTile(p.id);
      card.info.textContent = tile === 0 ? t('hud.start') : t('hud.tile', { n: tile });
      card.bar.style.width = `${(tile / TILE_COUNT) * 100}%`;
      card.el.classList.toggle('active', p.id === this.activeId && !s.winnerId);
    });
  }

  private updateRoll(): void {
    const g = this.game;
    if (!g.state) return;
    const phase = g.machine.phase;
    const player = g.state.players.find((p) => p.id === this.activeId) ?? g.state.players[g.state.current];
    const mine = g.isMine(player.id);
    const ready = mine && phase === 'AWAIT_ROLL' && !g.state.winnerId && !g.rollBlocked;
    this.rollBtn.disabled = !ready;
    this.rollBtn.classList.toggle('ready', ready);
    const label = ready ? t('hud.roll') : phase === 'ROLLING' ? t('hud.rolling') : mine ? t('hud.roll') : t('hud.botTurn', { name: player.name });
    this.rollBtn.replaceChildren(...(mine ? [icon('dice')] : []), h('span', null, label));
    if (ready && this.chargeStart === null) this.hint.textContent = t('hud.holdShort');
    else if (!ready && this.chargeStart === null)
      this.hint.textContent = g.fightActive ? t('hud.fightWait') : g.online?.isSpectator ? t('live.watchingHint') : '';
    this.charge.classList.toggle('ready', ready);
    if (!ready) this.charge.classList.remove('overheat');
    setVisible(this.rollBtn, phase !== 'GAME_OVER');
    this.tickTimer();
  }

  /** Sisa waktu giliran (hanya online, saat menunggu lemparan). */
  private tickTimer(): void {
    const g = this.game;
    const show =
      !!g.online && this.visible && !!this.deadline && g.machine.phase === 'AWAIT_ROLL' && this.deadline.playerId === this.activeId && !g.rollBlocked;
    setVisible(this.timer, show);
    if (!show || !this.deadline) return;
    const secs = Math.max(0, Math.ceil((this.deadline.at - Date.now()) / 1000));
    this.timer.textContent = `${t('hud.timer')}: ${secs}`;
    this.timer.classList.toggle('low', secs <= 5);
  }

  private showBanner(text: string, kind: 'info' | 'bonus' | 'bad' = 'info'): void {
    this.banner.textContent = text;
    this.banner.className = `banner ${kind}`;
    void this.banner.offsetWidth;
    this.banner.classList.add('show');
    window.clearTimeout(this.bannerTimer);
    this.bannerTimer = window.setTimeout(() => this.banner.classList.remove('show'), 1500);
  }

  private popDice(value: number): void {
    this.dicePop.textContent = String(value);
    this.dicePop.classList.remove('show');
    void this.dicePop.offsetWidth;
    this.dicePop.classList.add('show');
    window.clearTimeout(this.popTimer);
    this.popTimer = window.setTimeout(() => this.dicePop.classList.remove('show'), 1100);
  }

  private addLog(text: string): void {
    if (this.game.online) return; // online: tampil di umpan chat
    const line = h('div', { class: 'log-line' }, text);
    this.log.append(line);
    while (this.log.childElementCount > 3) this.log.firstElementChild?.remove();
    window.setTimeout(() => line.remove(), 6000);
  }
}

/** Sedang mengetik di input (mis. chat): pintasan keyboard permainan diabaikan. */
function isTyping(e: KeyboardEvent): boolean {
  const el = e.target as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
}
