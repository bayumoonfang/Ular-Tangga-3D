import { onLangChange, t } from '../i18n';
import { h, setVisible } from './dom';
import { icon } from './icons';

export interface MenuCallbacks {
  onPlay(): void;
  onResume(): void;
  onOnline(): void;
  onWatch(): void;
  onSettings(): void;
  onHowTo(): void;
}

export class MainMenu {
  readonly el = h('div', { class: 'screen menu hidden' });
  private canResume = false;

  constructor(private cb: MenuCallbacks) {
    this.render();
    onLangChange(() => this.render());
  }

  private render(): void {
    const buttons = [
      this.canResume && h('button', { class: 'btn primary big', onclick: () => this.cb.onResume() }, icon('play'), t('menu.resume')),
      h('button', { class: `btn ${this.canResume ? '' : 'primary'} big`, onclick: () => this.cb.onPlay() }, icon('dice'), t('menu.play')),
      h('button', { class: 'btn accent big', onclick: () => this.cb.onOnline() }, icon('globe'), t('menu.online')),
      h('button', { class: 'btn big watch-menu', onclick: () => this.cb.onWatch() }, h('i', { class: 'live-dot' }), t('menu.watch')),
      h('button', { class: 'btn big', onclick: () => this.cb.onSettings() }, icon('settings'), t('menu.settings')),
      h('button', { class: 'btn big', onclick: () => this.cb.onHowTo() }, icon('help'), t('menu.howto')),
    ];
    this.el.replaceChildren(
      h(
        'div',
        { class: 'menu-card' },
        h('div', { class: 'logo' }, h('span', { class: 'logo-emoji' }, '🐍🎲🪜'), h('h1', null, t('app.title'))),
        h('p', { class: 'subtitle' }, t('menu.subtitle')),
        h('div', { class: 'menu-buttons' }, ...buttons),
      ),
    );
  }

  setResumeAvailable(v: boolean): void {
    if (this.canResume === v) return;
    this.canResume = v;
    this.render();
  }

  show(): void {
    setVisible(this.el, true);
  }

  hide(): void {
    setVisible(this.el, false);
  }
}
