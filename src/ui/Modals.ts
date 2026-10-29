import { CHARACTERS } from '../config';
import { onLangChange, t } from '../i18n';
import { settings, type Lang, type QualitySetting } from '../utils/settings';
import { h, setVisible } from './dom';
import { icon } from './icons';

abstract class Modal {
  readonly el = h('div', { class: 'screen modal hidden' });

  show(): void {
    this.render();
    setVisible(this.el, true);
  }

  hide(): void {
    setVisible(this.el, false);
  }

  protected abstract render(): void;
}

/** Pengaturan: volume (master/musik/SFX), mute, bahasa, kualitas, aksesibilitas. */
export class SettingsPanel extends Modal {
  constructor() {
    super();
    onLangChange(() => this.render());
    this.render();
  }

  private slider(label: string, key: 'master' | 'music' | 'sfx'): HTMLElement {
    const input = h('input', { type: 'range', min: 0, max: 100, value: Math.round(settings.get(key) * 100) });
    input.addEventListener('input', () => settings.set(key, Number(input.value) / 100));
    return h('label', { class: 'field row' }, h('span', null, label), input);
  }

  private check(label: string, key: 'muted' | 'highContrast' | 'reducedMotion' | 'fastBots'): HTMLElement {
    const input = h('input', { type: 'checkbox' });
    input.checked = settings.get(key);
    input.addEventListener('change', () => settings.set(key, input.checked));
    return h('label', { class: 'toggle' }, input, h('span', { class: 'switch' }), h('span', null, label));
  }

  protected render(): void {
    const lang = h('select', { class: 'select' }, h('option', { value: 'id' }, 'Bahasa Indonesia'), h('option', { value: 'en' }, 'English'));
    lang.value = settings.get('lang');
    lang.addEventListener('change', () => settings.set('lang', lang.value as Lang));

    const quality = h(
      'select',
      { class: 'select' },
      ...(['auto', 'high', 'medium', 'low'] as QualitySetting[]).map((q) => h('option', { value: q }, t(`settings.quality.${q}`))),
    );
    quality.value = settings.get('quality');
    quality.addEventListener('change', () => settings.set('quality', quality.value as QualitySetting));

    this.el.replaceChildren(
      h(
        'div',
        { class: 'modal-card' },
        h('h2', null, icon('settings'), t('settings.title')),
        this.slider(t('settings.master'), 'master'),
        this.slider(t('settings.music'), 'music'),
        this.slider(t('settings.sfx'), 'sfx'),
        this.check(t('settings.mute'), 'muted'),
        h('label', { class: 'field row' }, h('span', null, t('settings.lang')), lang),
        h('label', { class: 'field row' }, h('span', null, t('settings.quality')), quality),
        this.check(t('settings.contrast'), 'highContrast'),
        this.check(t('settings.motion'), 'reducedMotion'),
        this.check(t('settings.fast'), 'fastBots'),
        h('button', { class: 'btn primary', onclick: () => this.hide() }, t('settings.close')),
      ),
    );
  }
}

export class HowToPlay extends Modal {
  constructor() {
    super();
    onLangChange(() => this.render());
    this.render();
  }

  protected render(): void {
    this.el.replaceChildren(
      h(
        'div',
        { class: 'modal-card' },
        h('h2', null, icon('help'), t('howto.title')),
        h('ol', { class: 'howto' }, ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => h('li', null, t(`howto.${n}`)))),
        h('button', { class: 'btn primary', onclick: () => this.hide() }, t('howto.close')),
      ),
    );
  }
}

export class PauseMenu extends Modal {
  /** online: judul 'Menu' (permainan tidak dibekukan) dan tombol keluar room */
  setOnline(v: boolean, spectator = false): void {
    this.online = v;
    this.spectator = v && spectator;
    this.render();
  }

  private online = false;
  private spectator = false;
  /** host online: pemain lain yang bisa dikeluarkan (kosong = bagian disembunyikan) */
  private roster: { id: string; name: string; character: string }[] = [];
  private kickConfirm = '';
  private kickTimer = 0;

  setRoster(list: { id: string; name: string; character: string }[]): void {
    this.roster = list;
    if (!list.some((p) => p.id === this.kickConfirm)) this.kickConfirm = '';
    this.render();
  }

  constructor(private cb: { onResume(): void; onSettings(): void; onQuit(): void; onKick(id: string): void }) {
    super();
    onLangChange(() => this.render());
    this.render();
  }

  protected render(): void {
    this.el.replaceChildren(
      h(
        'div',
        { class: 'modal-card' },
        h('h2', null, icon('pause'), t(this.online ? 'pause.menu' : 'pause.title')),
        h('button', { class: 'btn primary big', onclick: () => this.cb.onResume() }, icon('play'), t('pause.resume')),
        h('button', { class: 'btn big', onclick: () => this.cb.onSettings() }, icon('settings'), t('pause.settings')),
        h('button', { class: 'btn danger big', onclick: () => this.cb.onQuit() }, icon('exit'), t(this.spectator ? 'live.stop' : this.online ? 'pause.leave' : 'pause.quit')),
        this.roster.length ? this.rosterView() : null,
      ),
    );
  }

  private rosterView(): HTMLElement {
    return h(
      'div',
      { class: 'pause-roster' },
      h('span', { class: 'hint' }, t('pause.players')),
      ...this.roster.map((p) => {
        const confirming = this.kickConfirm === p.id;
        return h(
          'div',
          { class: 'roster-row' },
          h('span', { class: 'roster-emoji' }, CHARACTERS.find((c) => c.id === p.character)?.emoji ?? '🎲'),
          h('b', null, p.name),
          h(
            'button',
            { class: `btn sm ${confirming ? 'danger' : ''}`, onclick: () => this.kick(p.id) },
            icon('kick'),
            confirming ? t('lobby.kickConfirm') : t('lobby.kick'),
          ),
        );
      }),
    );
  }

  /** Klik pertama meminta konfirmasi, klik kedua (dalam 3 dtk) mengeluarkan pemain. */
  private kick(id: string): void {
    window.clearTimeout(this.kickTimer);
    if (this.kickConfirm === id) {
      this.kickConfirm = '';
      this.cb.onKick(id);
    } else {
      this.kickConfirm = id;
      this.kickTimer = window.setTimeout(() => {
        this.kickConfirm = '';
        this.render();
      }, 3000);
    }
    this.render();
  }
}
