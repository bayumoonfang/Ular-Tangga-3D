import type { EventBus } from '../core/EventBus';
import { onLangChange, t } from '../i18n';
import type { NetworkClient } from '../network/NetworkClient';
import { CHAT_MAX, expressionEmoji, type ChatMsg } from '../network/protocol';
import { h, setVisible } from './dom';
import { icon } from './icons';

export type ChatContext = 'game' | 'lobby' | null;

const hex = (n: number) => '#' + n.toString(16).padStart(6, '0');
/** pesan di umpan memudar setelah ini (tetap ada di riwayat saat chat aktif) */
const FADE_MS = 9000;

/**
 * Live chat kiri bawah ala siaran langsung: umpan pesan transparan yang memudar sendiri dan tidak
 * menghalangi permainan (klik tembus ke kamera), plus bilah input ringkas. Saat input difokus / kursor
 * di atasnya, riwayat penuh tampil dengan latar kaca dan bisa digulir. Bisa diciutkan jadi tombol kecil.
 */
export class ChatPanel {
  readonly el = h('div', { class: 'chat-dock hidden' });
  private reactions = h('div', { class: 'reactions', 'aria-hidden': 'true' });
  private feed = h('div', { class: 'chat-feed', role: 'log', 'aria-live': 'polite' });
  private viewerList = h('div', { class: 'viewer-list hidden' });
  private note = h('div', { class: 'chat-note hidden' });
  private input = h('input', { type: 'text', class: 'chat-input', maxlength: CHAT_MAX, autocomplete: 'off', enterkeyhint: 'send' });
  private sendBtn = h('button', { type: 'submit', class: 'chat-send' }, icon('send'));
  private viewersBtn = h('button', { type: 'button', class: 'chat-viewers', onclick: () => this.toggleViewers() });
  private collapseBtn = h('button', { type: 'button', class: 'chat-collapse', onclick: () => this.setOpen(false) }, icon('down'));
  private fab = h('button', { type: 'button', class: 'chat-fab', onclick: () => this.setOpen(true) });
  private context: ChatContext = null;
  private open = false;
  private unread = 0;
  private noteTimer = 0;

  constructor(
    private net: NetworkClient,
    bus: EventBus,
    private getContext: () => ChatContext,
  ) {
    const form = h(
      'form',
      {
        class: 'chat-form',
        onsubmit: (e: Event) => {
          e.preventDefault();
          this.submit();
        },
      },
      icon('chat'),
      this.input,
      this.sendBtn,
    );
    // ketikan di chat tidak boleh memicu pintasan permainan (Spasi = lempar, P = jeda, 1–8 = ekspresi)
    for (const ev of ['keydown', 'keyup'] as const) this.input.addEventListener(ev, (e) => e.stopPropagation());
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.input.blur();
    });
    // chat aktif (riwayat penuh + latar) selama input difokus atau kursor berada di atas chat
    this.el.addEventListener('focusin', () => this.setActive(true));
    this.el.addEventListener('focusout', () => window.setTimeout(() => this.setActive(this.el.contains(document.activeElement) || this.el.matches(':hover')), 0));
    this.el.addEventListener('pointerenter', (e) => {
      if (e.pointerType === 'mouse') this.setActive(true);
    });
    this.el.addEventListener('pointerleave', (e) => {
      if (e.pointerType === 'mouse' && !this.el.contains(document.activeElement)) this.setActive(false);
    });

    this.el.append(
      this.reactions,
      this.viewerList,
      this.feed,
      this.note,
      h('div', { class: 'chat-bar' }, form, this.viewersBtn, this.collapseBtn),
      this.fab,
    );

    net.on('joined', () => this.renderAll());
    net.on('chat_history', () => this.renderAll());
    net.on('chat', ({ msg }) => this.onMessage(msg));
    net.on('error', ({ message, code }) => {
      if (code === 'chat_rate') this.showNote(message);
    });
    net.on('left', () => this.refresh());
    net.on('room_state', () => this.refresh());
    net.on('joined', () => this.refresh());
    net.onStatus(() => this.refresh());
    bus.on('game:start', () => this.refresh());
    bus.on('game:exit', () => this.refresh());
    // kejadian penting permainan masuk umpan chat (lokal, tidak dikirim ke server)
    bus.on('ui:log', ({ text, minor }) => {
      if (!minor && this.context === 'game') this.append(h('div', { class: 'chat-msg event' }, h('span', { class: 'txt' }, text)), true);
    });
    bus.on('expression', ({ spectator, name, id }) => {
      if (spectator && this.context) this.float(expressionEmoji(id), name);
    });
    onLangChange(() => this.renderStatic());
    this.renderStatic();
  }

  /** Hitung ulang apakah chat tampil (dipanggil saat layar/room berubah). */
  refresh(): void {
    const ctx = this.net.inRoom ? this.getContext() : null;
    if (ctx !== this.context) {
      this.context = ctx;
      // lobby: kartu lobby di tengah, chat diciutkan kecuali ada ruang kosong di kiri
      if (ctx) this.setOpen(ctx === 'game' || window.innerWidth >= 1480);
    }
    setVisible(this.el, ctx !== null);
    this.el.classList.toggle('in-lobby', ctx === 'lobby');
    if (ctx) this.renderViewers();
  }

  private setOpen(v: boolean): void {
    this.open = v;
    this.el.classList.toggle('open', v);
    if (v) {
      this.unread = 0;
      this.scrollToEnd();
    } else {
      this.input.blur();
      setVisible(this.viewerList, false);
      this.setActive(false);
    }
    this.renderFab();
  }

  private setActive(v: boolean): void {
    this.el.classList.toggle('active', v && this.open);
    this.scrollToEnd();
  }

  private submit(): void {
    const text = this.input.value.replace(/\s+/g, ' ').trim();
    if (!text) return;
    this.net.send({ t: 'chat', text });
    this.input.value = '';
  }

  private showNote(text: string): void {
    this.note.textContent = text;
    setVisible(this.note, true);
    window.clearTimeout(this.noteTimer);
    this.noteTimer = window.setTimeout(() => setVisible(this.note, false), 2500);
  }

  // ───────────────────────── Render ─────────────────────────

  private renderStatic(): void {
    this.input.placeholder = t('chat.placeholder');
    this.sendBtn.title = t('chat.send');
    this.sendBtn.setAttribute('aria-label', t('chat.send'));
    this.collapseBtn.title = t('chat.collapse');
    this.collapseBtn.setAttribute('aria-label', t('chat.collapse'));
    this.fab.title = t('chat.title');
    this.fab.setAttribute('aria-label', t('chat.title'));
    this.renderViewers();
  }

  /** Riwayat dari server: tampil di riwayat (saat aktif) tetapi tidak memenuhi umpan. */
  private renderAll(): void {
    this.feed.replaceChildren();
    for (const m of this.net.chat) this.feed.append(this.msgEl(m, false));
    this.unread = 0;
    this.renderFab();
    this.scrollToEnd();
  }

  private onMessage(msg: ChatMsg): void {
    this.append(this.msgEl(msg, true));
    if (!this.open && msg.from !== this.net.myId && msg.role !== 'system') {
      this.unread++;
      this.renderFab();
    }
  }

  /** @param fresh pesan baru: tampil di umpan lalu memudar; false = langsung "lama" (hanya di riwayat) */
  private msgEl(m: ChatMsg, fresh: boolean): HTMLElement {
    let el: HTMLElement;
    if (m.role === 'system') el = h('div', { class: 'chat-msg system' }, h('span', { class: 'txt' }, m.text));
    else {
      const who =
        m.role === 'player'
          ? h('b', { class: 'who', style: { '--c': hex(m.color ?? 0x7c4dff) } }, m.name)
          : h('b', { class: 'who viewer', title: t('chat.viewer') }, icon('eye'), m.name);
      el = h('div', { class: `chat-msg ${m.from === this.net.myId ? 'me' : ''}` }, who, h('span', { class: 'txt' }, m.text));
    }
    if (!fresh) el.classList.add('old');
    return el;
  }

  private append(el: HTMLElement, fresh = true): void {
    const atEnd = this.feed.scrollHeight - this.feed.scrollTop - this.feed.clientHeight < 40;
    this.feed.append(el);
    while (this.feed.childElementCount > 120) this.feed.firstElementChild?.remove();
    if (fresh) window.setTimeout(() => el.classList.add('old'), FADE_MS);
    if (atEnd || !this.el.classList.contains('active')) this.scrollToEnd();
  }

  private scrollToEnd(): void {
    requestAnimationFrame(() => (this.feed.scrollTop = this.feed.scrollHeight));
  }

  private viewers(): string[] {
    return this.net.room?.viewers ?? [];
  }

  private renderViewers(): void {
    const n = this.viewers().length;
    this.viewersBtn.replaceChildren(icon('eye'), String(n));
    this.viewersBtn.title = t('live.viewers', { n });
    this.viewersBtn.setAttribute('aria-label', t('live.viewers', { n }));
    if (!this.viewerList.classList.contains('hidden')) this.fillViewerList();
    this.renderFab();
  }

  private toggleViewers(): void {
    const show = this.viewerList.classList.contains('hidden');
    if (show) this.fillViewerList();
    setVisible(this.viewerList, show);
  }

  private fillViewerList(): void {
    const names = this.viewers();
    this.viewerList.replaceChildren(
      h('small', null, t('live.viewers', { n: names.length })),
      ...(names.length ? names.map((n) => h('span', { class: 'tag' }, n)) : [h('span', { class: 'hint' }, t('live.noViewers'))]),
    );
  }

  private renderFab(): void {
    this.fab.replaceChildren(
      icon('chat'),
      ...(this.unread > 0 ? [h('span', { class: 'fab-badge' }, this.unread > 99 ? '99+' : String(this.unread))] : []),
    );
  }

  /** Reaksi penonton: emoji melayang naik dari atas chat. */
  private float(emoji: string, name: string): void {
    if (this.reactions.childElementCount > 24) return;
    const el = h('span', { class: 'reaction', style: { left: `${8 + Math.random() * 70}%` } }, h('b', null, emoji), h('small', null, name));
    this.reactions.append(el);
    window.setTimeout(() => el.remove(), 2600);
  }
}
