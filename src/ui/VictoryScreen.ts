import { CHARACTERS } from '../config';
import type { Game } from '../core/Game';
import { onLangChange, t } from '../i18n';
import { h, setVisible } from './dom';
import { icon } from './icons';

const MEDALS = ['🥇', '🥈', '🥉', '4️⃣'];

/** Layar kemenangan: muncul di atas podium 3D (podium, confetti & kembang api ada di Stage). */
export class VictoryScreen {
  readonly el = h('div', { class: 'victory hidden' });
  private timer = 0;
  private ranking: string[] = [];

  constructor(
    private game: Game,
    private cb: { onAgain(): void; onMenu(): void },
  ) {
    game.bus.on('game:win', ({ ranking }) => {
      this.ranking = ranking;
      window.clearTimeout(this.timer);
      this.timer = window.setTimeout(() => this.show(), 2600);
    });
    game.bus.on('game:exit', () => this.hide());
    // penonton yang masih di layar ini saat permainan baru dimulai
    game.bus.on('game:start', () => this.hide());
    onLangChange(() => this.el.classList.contains('hidden') || this.render());
  }

  private render(): void {
    const players = this.game.state.players;
    const online = !!this.game.online;
    const winner = players.find((p) => p.id === this.ranking[0])!;
    const youWon = this.game.isMine(winner.id);
    const watching = !!this.game.online?.isSpectator;
    this.el.replaceChildren(
      h(
        'div',
        { class: 'victory-card' },
        h('h2', null, icon('trophy'), t('victory.title', { name: winner.name })),
        watching
          ? h('p', { class: 'win' }, t('live.winnerMsg', { name: winner.name }))
          : h('p', { class: youWon ? 'win' : 'lose' }, youWon ? t('victory.youWin') : t('victory.youLose')),
        h(
          'ol',
          { class: 'ranking' },
          ...this.ranking.map((id, i) => {
            const p = players.find((x) => x.id === id)!;
            const emoji = CHARACTERS.find((c) => c.id === p.character)?.emoji ?? '';
            return h('li', null, h('span', { class: 'medal' }, MEDALS[i] ?? ''), h('span', { class: 'rname' }, `${emoji} ${p.name}`), h('small', null, t('victory.place', { n: i + 1 })));
          }),
        ),
        h(
          'div',
          { class: 'victory-actions' },
          h('button', { class: 'btn primary big', onclick: () => this.cb.onAgain() }, icon(online ? 'users' : 'repeat'), t(online ? 'victory.lobby' : 'victory.again')),
          h('button', { class: 'btn big', onclick: () => this.cb.onMenu() }, icon(online ? 'exit' : 'home'), t(watching ? 'live.stop' : online ? 'victory.leaveRoom' : 'victory.menu')),
        ),
      ),
    );
  }

  private show(): void {
    this.render();
    setVisible(this.el, true);
  }

  hide(): void {
    window.clearTimeout(this.timer);
    setVisible(this.el, false);
  }
}
