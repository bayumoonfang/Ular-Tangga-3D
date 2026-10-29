import { CHARACTERS, type BoardPresetId } from '../config';
import { onLangChange, t } from '../i18n';
import type { NetworkClient, NetStatus } from '../network/NetworkClient';
import { MAX_PLAYERS, MIN_PLAYERS, ROOM_CODE_LENGTH, type LiveRoom, type RoomInfo } from '../network/protocol';
import { h, setVisible } from './dom';
import { icon } from './icons';

const BOARDS: BoardPresetId[] = ['easy', 'normal', 'chaos', 'random'];
const NAME_KEY = 'sl3d.playerName';
const CHAR_KEY = 'sl3d.playerChar';

const hex = (n: number) => '#' + n.toString(16).padStart(6, '0');
const emojiOf = (id: string) => CHARACTERS.find((c) => c.id === id)?.emoji ?? '🎲';
/** jeda penyegaran daftar "Live sekarang" */
const LIVE_POLL_MS = 4000;

/** Lobby online: buat / gabung / tonton room, daftar pemain (2–4), siap, pengaturan host, mulai. */
export class Lobby {
  readonly el = h('div', { class: 'screen lobby hidden' });
  private name = '';
  private character: string = CHARACTERS[0].id;
  private codeInput = '';
  private error = '';
  private errorTimer = 0;
  private copied = '';
  private visible = false;
  private busy = false;
  /** sedang mencoba masuk kembali ke room terakhir (setelah refresh / tab tertutup) */
  private restoring = false;
  /** room yang sedang bermain dan bisa ditonton */
  private live: LiveRoom[] = [];
  private livePoll = 0;
  /** nama kosong saat mencoba menonton: kolom nama disorot */
  private nameInvalid = false;
  /** host menekan Keluarkan sekali: tombol meminta konfirmasi (id pemain) */
  private kickConfirm = '';
  private kickTimer = 0;

  constructor(
    private net: NetworkClient,
    private cb: { onBack(): void; onVisibility(visible: boolean): void },
  ) {
    try {
      this.name = localStorage.getItem(NAME_KEY) ?? '';
      const c = localStorage.getItem(CHAR_KEY);
      if (c && CHARACTERS.some((x) => x.id === c)) this.character = c;
    } catch {
      /* abaikan */
    }
    onLangChange(() => this.render());
    net.onStatus(() => {
      this.render();
      this.requestLive();
    });
    net.on('joined', () => {
      this.busy = false;
      this.restoring = false;
      this.render();
    });
    net.on('room_state', () => this.render());
    net.on('kicked', () => {
      this.busy = false;
      this.showError(t('net.kicked'));
      this.requestLive();
    });
    net.on('left', () => {
      this.render();
      this.requestLive();
    });
    net.on('live_list', ({ rooms }) => {
      this.live = rooms;
      if (!this.net.room) this.render();
    });
    net.on('error', ({ message, code }) => {
      this.busy = false;
      if (code === 'chat_rate') return; // ditampilkan di panel chat
      if (code === 'room_closed') {
        this.showError(t('live.closed'));
        this.requestLive();
      } else if (code !== 'rejoin_failed') this.showError(message);
      else {
        this.restoring = false;
        this.render();
      }
    });
  }

  get isVisible(): boolean {
    return this.visible;
  }

  /** Minta daftar room live (hanya di layar buat/gabung, saat tersambung). */
  private requestLive(): void {
    if (this.visible && !this.net.room && this.net.status === 'connected') this.net.send({ t: 'list_live' });
  }

  /** Tampilkan layar "menyambungkan kembali" alih-alih form buat/gabung room. */
  setRestoring(v: boolean): void {
    this.restoring = v;
    this.render();
  }

  /** @param watch tautan tonton (?watch=KODE) / menu Tonton Live: kolom nama disorot bila masih kosong */
  show(prefillCode?: string, watch = false): void {
    this.visible = true;
    if (prefillCode) this.codeInput = prefillCode.toUpperCase().slice(0, ROOM_CODE_LENGTH);
    this.net.connect();
    this.render();
    setVisible(this.el, true);
    window.clearInterval(this.livePoll);
    this.livePoll = window.setInterval(() => this.requestLive(), LIVE_POLL_MS);
    this.requestLive();
    if (watch && !this.net.room) {
      if (!this.name.trim()) this.el.querySelector<HTMLInputElement>('[data-focus="name"]')?.focus();
      this.el.querySelector('.live-section')?.scrollIntoView({ block: 'nearest' });
    }
    this.cb.onVisibility(true);
  }

  hide(): void {
    this.visible = false;
    window.clearInterval(this.livePoll);
    setVisible(this.el, false);
    this.cb.onVisibility(false);
  }

  /** Pesan singkat di lobby (mis. room bubar). */
  notify(message: string): void {
    this.showError(message);
  }

  private showError(message: string): void {
    this.error = message;
    this.render();
    window.clearTimeout(this.errorTimer);
    this.errorTimer = window.setTimeout(() => {
      this.error = '';
      this.render();
    }, 4500);
  }

  private saveProfile(): void {
    try {
      localStorage.setItem(NAME_KEY, this.name.trim());
      localStorage.setItem(CHAR_KEY, this.character);
    } catch {
      /* abaikan */
    }
  }

  // ───────────────────────── Render ─────────────────────────

  private render(): void {
    if (!this.visible) return;
    const room = this.net.room;
    const card = h(
      'div',
      { class: 'lobby-card' },
      this.statusBar(),
      room ? this.roomView(room) : this.restoring ? this.restoringView() : this.entryView(),
      this.error ? h('div', { class: 'lobby-error', role: 'alert' }, this.error) : null,
    );
    // pertahankan fokus & posisi kursor pada input saat re-render
    const active = document.activeElement as HTMLInputElement | null;
    const focusId = active?.dataset?.focus;
    const caret = active?.selectionStart ?? null;
    this.el.replaceChildren(card);
    if (focusId) {
      const next = this.el.querySelector<HTMLInputElement>(`[data-focus="${focusId}"]`);
      next?.focus();
      if (next && caret !== null) next.setSelectionRange(caret, caret);
    }
  }

  private statusBar(): HTMLElement {
    const s: NetStatus = this.net.status;
    const label =
      s === 'connected' ? t('lobby.status.connected') : s === 'connecting' ? t('lobby.status.connecting') : t('lobby.status.disconnected');
    return h(
      'div',
      { class: 'lobby-head' },
      h('h2', null, icon('globe'), t('lobby.title')),
      h(
        'div',
        { class: `status-pill ${s}` },
        h('i'),
        label,
        s === 'disconnected' ? h('button', { class: 'pill-btn', onclick: () => this.net.connect() }, icon('refresh'), t('lobby.retry')) : null,
      ),
    );
  }

  private charPicker(taken: Set<string>, onPick: (id: string) => void): HTMLElement {
    return h(
      'div',
      { class: 'char-chips' },
      ...CHARACTERS.map((c) => {
        const blocked = taken.has(c.id);
        return h(
          'button',
          {
            class: `chip ${c.id === this.character ? 'active' : ''}`,
            disabled: blocked,
            title: t(`char.${c.id}`),
            'aria-label': t(`char.${c.id}`),
            onclick: () => onPick(c.id),
          },
          c.emoji,
        );
      }),
    );
  }

  private restoringView(): HTMLElement {
    return h(
      'div',
      { class: 'lobby-body restoring' },
      h('div', { class: 'spinner', 'aria-hidden': 'true' }),
      h('h3', null, t('net.restoring')),
      h('p', { class: 'hint' }, t('net.restoringSub')),
      h(
        'button',
        {
          class: 'btn',
          onclick: () => {
            this.restoring = false;
            this.net.leave();
            this.cb.onBack();
          },
        },
        icon('back'),
        t('setup.back'),
      ),
    );
  }

  // ───────────────────────── Sebelum masuk room ─────────────────────────

  /** Masuk sebagai penonton: nama wajib diisi lebih dulu. */
  private spectate(code: string): void {
    if (!this.name.trim()) {
      this.nameInvalid = true;
      this.showError(t('live.nameRequired'));
      this.el.querySelector<HTMLInputElement>('[data-focus="name"]')?.focus();
      return;
    }
    this.saveProfile();
    this.busy = true;
    this.net.send({ t: 'spectate', code, name: this.name.trim() });
  }

  /** Gabung sebagai pemain (lobby, atau slot kosong di tengah permainan — mulai dari Start). */
  private join(code: string): void {
    this.saveProfile();
    this.busy = true;
    this.net.send({ t: 'join_room', code, name: this.name, character: this.character });
  }

  /** Host: klik pertama meminta konfirmasi, klik kedua (dalam 3 dtk) mengeluarkan pemain. */
  private kick(id: string): void {
    window.clearTimeout(this.kickTimer);
    if (this.kickConfirm !== id) {
      this.kickConfirm = id;
      this.kickTimer = window.setTimeout(() => {
        this.kickConfirm = '';
        this.render();
      }, 3000);
    } else {
      this.kickConfirm = '';
      this.net.send({ t: 'kick', playerId: id });
    }
    this.render();
  }

  private entryView(): HTMLElement {
    const online = this.net.status === 'connected';
    const nameInput = h('input', {
      type: 'text',
      class: `text-input ${this.nameInvalid ? 'invalid' : ''}`,
      maxlength: 14,
      placeholder: t('setup.namePlaceholder'),
      value: this.name,
      'data-focus': 'name',
      'aria-invalid': this.nameInvalid ? 'true' : undefined,
      oninput: () => {
        this.name = nameInput.value;
        if (this.nameInvalid && this.name.trim()) {
          this.nameInvalid = false;
          nameInput.classList.remove('invalid');
          nameInput.removeAttribute('aria-invalid');
        }
      },
    });
    const codeInput = h('input', {
      type: 'text',
      class: 'text-input code-input',
      maxlength: ROOM_CODE_LENGTH,
      placeholder: t('lobby.codePlaceholder'),
      value: this.codeInput,
      autocapitalize: 'characters',
      autocomplete: 'off',
      spellcheck: false,
      'data-focus': 'code',
      oninput: () => {
        this.codeInput = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
        codeInput.value = this.codeInput;
        joinBtn.disabled = watchBtn.disabled = !online || this.busy || this.codeInput.length < ROOM_CODE_LENGTH;
      },
      onkeydown: (e: Event) => {
        if ((e as KeyboardEvent).key === 'Enter' && !joinBtn.disabled) joinBtn.click();
      },
    });
    const create = h(
      'button',
      {
        class: 'btn primary big',
        disabled: !online || this.busy,
        onclick: () => {
          this.saveProfile();
          this.busy = true;
          this.net.send({ t: 'create_room', name: this.name, character: this.character });
        },
      },
      icon('plus'),
      t('lobby.create'),
    );
    const joinBtn = h(
      'button',
      {
        class: 'btn big',
        disabled: !online || this.busy || this.codeInput.length < ROOM_CODE_LENGTH,
        onclick: () => this.join(this.codeInput),
      },
      icon('users'),
      t('lobby.join'),
    );
    const watchBtn = h(
      'button',
      {
        class: 'btn sm watch-btn',
        disabled: !online || this.busy || this.codeInput.length < ROOM_CODE_LENGTH,
        onclick: () => this.spectate(this.codeInput),
      },
      icon('eye'),
      t('live.watchCode'),
    );

    return h(
      'div',
      { class: 'lobby-body' },
      h('label', { class: 'field' }, h('span', null, t('setup.name'), h('small', { class: 'hint' }, ' — ' + t('live.nameHint'))), nameInput),
      h('div', { class: 'field' }, h('span', null, t('setup.character')), this.charPicker(new Set(), (id) => {
        this.character = id;
        this.render();
      })),
      h(
        'div',
        { class: 'lobby-actions two' },
        h('div', { class: 'action-box' }, create),
        h(
          'div',
          { class: 'action-box' },
          h('span', { class: 'action-label' }, t('lobby.codeLabel')),
          h('div', { class: 'join-row' }, codeInput, joinBtn),
          watchBtn,
        ),
      ),
      this.liveView(online),
      h('div', { class: 'lobby-foot' }, h('button', { class: 'btn', onclick: () => this.cb.onBack() }, icon('back'), t('setup.back'))),
    );
  }

  /** Daftar pertandingan yang sedang berlangsung — klik Tonton untuk masuk sebagai penonton. */
  private liveView(online: boolean): HTMLElement {
    const items = this.live.map((r) =>
      h(
        'div',
        { class: 'live-item' },
        h(
          'div',
          { class: 'live-info' },
          h(
            'div',
            { class: 'live-players' },
            ...r.players.map((p) =>
              h('span', { class: 'live-player', style: { '--c': hex(p.color) }, title: t('hud.tile', { n: p.position }) }, emojiOf(p.character), h('b', null, p.name), h('small', null, String(p.position))),
            ),
          ),
          h('small', { class: 'hint' }, t('live.meta', { code: r.code, turn: r.turn })),
        ),
        h('span', { class: 'live-viewers', title: t('live.viewers', { n: r.viewers }) }, icon('eye'), String(r.viewers)),
        r.openSlots > 0
          ? h('button', { class: 'btn sm primary', disabled: !online || this.busy, onclick: () => this.join(r.code) }, icon('users'), t('live.joinSlot', { n: r.openSlots }))
          : null,
        h('button', { class: 'btn sm accent', disabled: !online || this.busy, onclick: () => this.spectate(r.code) }, icon('eye'), t('live.watch')),
      ),
    );
    return h(
      'div',
      { class: 'field live-section' },
      h('span', { class: 'live-title' }, h('i', { class: 'live-dot' }), t('live.title')),
      h('div', { class: 'live-list' }, ...(items.length ? items : [h('div', { class: 'live-empty hint' }, t('live.empty'))])),
    );
  }

  // ───────────────────────── Di dalam room ─────────────────────────

  private roomView(room: RoomInfo): HTMLElement {
    const me = room.players.find((p) => p.id === this.net.myId);
    const isHost = room.hostId === this.net.myId;
    const watching = this.net.isSpectator;
    const taken = new Set(room.players.filter((p) => p.id !== this.net.myId).map((p) => p.character));
    const base = `${location.origin}${location.pathname}`;
    const links = { code: room.code, link: `${base}?room=${room.code}`, watch: `${base}?watch=${room.code}` };

    const copy = (what: 'code' | 'link' | 'watch') => {
      const text = links[what];
      const done = () => {
        this.copied = what;
        this.render();
        window.setTimeout(() => {
          this.copied = '';
          this.render();
        }, 1400);
      };
      if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done, () => window.prompt('', text));
      else window.prompt('', text);
    };

    const slots = Array.from({ length: MAX_PLAYERS }, (_, i) => {
      const p = room.players[i];
      if (!p) {
        return h('div', { class: 'slot empty' }, h('div', { class: 'slot-avatar' }, icon('users')), h('div', { class: 'slot-info' }, h('b', null, t('lobby.slot.empty'))));
      }
      const badges = [
        p.isHost ? h('span', { class: 'badge host' }, icon('crown'), t('lobby.host')) : null,
        p.id === this.net.myId ? h('span', { class: 'badge you' }, t('lobby.you')) : null,
        !p.connected ? h('span', { class: 'badge off' }, t('lobby.offline')) : p.isHost ? null : h('span', { class: `badge ${p.ready ? 'ok' : 'wait'}` }, p.ready ? t('lobby.ready') : t('lobby.notReady')),
      ];
      const confirming = this.kickConfirm === p.id;
      const kickBtn =
        isHost && p.id !== this.net.myId
          ? h(
              'button',
              {
                class: `slot-kick ${confirming ? 'confirm' : ''}`,
                title: t('lobby.kick'),
                'aria-label': `${t('lobby.kick')} ${p.name}`,
                onclick: () => this.kick(p.id),
              },
              icon('kick'),
              confirming ? h('span', null, t('lobby.kickConfirm')) : null,
            )
          : null;
      return h(
        'div',
        { class: `slot ${p.connected ? '' : 'offline'}`, style: { '--c': hex(p.color) } },
        h('div', { class: 'slot-avatar' }, emojiOf(p.character)),
        h('div', { class: 'slot-info' }, h('b', null, p.name), h('div', { class: 'badges' }, ...badges)),
        kickBtn,
      );
    });

    const settingsView = isHost
      ? h(
          'div',
          { class: 'room-settings' },
          h('div', { class: 'field' }, h('span', null, t('setup.board')), h('div', { class: 'seg' }, ...BOARDS.map((b) =>
            h('button', {
              class: `seg-btn ${room.settings.boardPreset === b ? 'active' : ''}`,
              onclick: () => this.net.send({ t: 'settings', boardPreset: b }),
            }, t(`board.${b}`)),
          ))),
          this.toggle(t('setup.sixAgain'), room.settings.options.sixRollsAgain, (v) => this.net.send({ t: 'settings', options: { sixRollsAgain: v } })),
          this.toggle(t('setup.exact'), room.settings.options.exactFinish, (v) => this.net.send({ t: 'settings', options: { exactFinish: v } })),
          this.toggle(t('lobby.arena'), room.settings.arena, (v) => this.net.send({ t: 'settings', arena: v })),
          h('small', { class: 'hint toggle-hint' }, t('lobby.arenaHint')),
          this.toggle(t('lobby.fight'), room.settings.fight, (v) => this.net.send({ t: 'settings', fight: v })),
          h('small', { class: 'hint toggle-hint' }, t('lobby.fightHint')),
        )
      : h(
          'div',
          { class: 'room-settings readonly' },
          h('span', { class: 'hint' }, t('lobby.settingsReadonly')),
          h('div', { class: 'chips-line' },
            h('span', { class: 'tag' }, t('setup.board') + ': ' + t(`board.${room.settings.boardPreset}`)),
            h('span', { class: 'tag' }, (room.settings.options.sixRollsAgain ? '✓ ' : '✗ ') + t('setup.sixAgain')),
            h('span', { class: 'tag' }, (room.settings.options.exactFinish ? '✓ ' : '✗ ') + t('setup.exact')),
            h('span', { class: 'tag' }, (room.settings.arena ? '✓ 🪙 ' : '✗ 🪙 ') + t('lobby.arenaTag')),
            h('span', { class: 'tag' }, (room.settings.fight ? '✓ ⚔️ ' : '✗ ⚔️ ') + t('lobby.fightTag')),
          ),
        );

    // tombol & petunjuk aksi utama
    const count = room.players.length;
    const allConnected = room.players.every((p) => p.connected);
    const othersReady = room.players.every((p) => p.isHost || p.ready);
    let hint: string;
    let canStart = false;
    if (watching) {
      hint = t('live.lobbyWait');
    } else if (isHost) {
      if (count < MIN_PLAYERS) hint = t('lobby.hint.min');
      else if (!allConnected) hint = t('lobby.hint.offline');
      else if (!othersReady) hint = t('lobby.hint.notReady');
      else {
        hint = t('lobby.hint.ready');
        canStart = true;
      }
    } else {
      hint = me?.ready ? t('lobby.hint.hostWait') : '';
    }

    const primary = watching
      ? null
      : isHost
      ? h('button', { class: 'btn primary big', disabled: !canStart, onclick: () => this.net.send({ t: 'start_game' }) }, icon('play'), t('lobby.start'))
      : h(
          'button',
          { class: `btn big ${me?.ready ? '' : 'primary'}`, onclick: () => this.net.send({ t: 'ready', ready: !me?.ready }) },
          icon(me?.ready ? 'refresh' : 'check'),
          me?.ready ? t('lobby.cancelReady') : t('lobby.readyBtn'),
        );

    const copyBtn = (what: 'code' | 'link' | 'watch', ico: 'copy' | 'link' | 'eye', label: string) =>
      h('button', { class: 'btn sm', onclick: () => copy(what) }, icon(this.copied === what ? 'check' : ico), this.copied === what ? t('lobby.copied') : label);

    const viewers = room.viewers;
    const viewersView = h(
      'div',
      { class: 'field' },
      h('span', { class: 'live-title' }, icon('eye'), t('live.viewers', { n: viewers.length })),
      h('div', { class: 'chips-line viewers-line' }, ...(viewers.length ? viewers.map((n) => h('span', { class: 'tag' }, n)) : [h('span', { class: 'hint' }, t('live.noViewers'))])),
    );

    return h(
      'div',
      { class: 'lobby-body' },
      watching ? h('div', { class: 'watch-banner' }, icon('eye'), h('b', null, t('live.youWatch', { name: this.net.myName }))) : null,
      h(
        'div',
        { class: 'room-code-box' },
        h('div', { class: 'room-code-text' }, h('span', { class: 'action-label' }, t('lobby.share')), h('div', { class: 'room-code' }, room.code)),
        h(
          'div',
          { class: 'room-code-actions' },
          copyBtn('code', 'copy', t('lobby.copyCode')),
          watching ? null : copyBtn('link', 'link', t('lobby.copyLink')),
          copyBtn('watch', 'eye', t('live.copyWatch')),
        ),
      ),
      h('div', { class: 'field' }, h('span', null, t('lobby.players', { n: count, max: MAX_PLAYERS })), h('div', { class: 'slots' }, ...slots)),
      watching
        ? null
        : h('div', { class: 'field' }, h('span', null, t('lobby.myChar')), this.charPicker(taken, (id) => {
            this.character = id;
            this.saveProfile();
            this.net.send({ t: 'set_character', character: id });
          })),
      h('div', { class: 'field' }, h('span', null, t('lobby.settings')), settingsView),
      viewersView,
      h('div', { class: 'lobby-hint' }, hint),
      h(
        'div',
        { class: 'lobby-foot' },
        h('button', { class: 'btn', onclick: () => this.leave() }, icon('exit'), watching ? t('live.stop') : t('lobby.leave')),
        primary,
      ),
    );
  }

  private leave(): void {
    this.net.leave();
    this.render();
  }

  private toggle(label: string, checked: boolean, onChange: (v: boolean) => void): HTMLElement {
    const input = h('input', { type: 'checkbox', onchange: () => onChange(input.checked) });
    input.checked = checked;
    return h('label', { class: 'toggle' }, input, h('span', { class: 'switch' }), h('span', null, label));
  }
}
