import './ui/styles.css';
import { AudioManager } from './audio/AudioManager';
import { BOARD_PRESETS } from './config';
import { Game, readSave } from './core/Game';
import { EventBus } from './core/EventBus';
import { NetworkClient } from './network/NetworkClient';
import { SceneManager } from './scene/SceneManager';
import { Stage } from './scene/Stage';
import { CharacterSelect } from './ui/CharacterSelect';
import { ChatPanel } from './ui/ChatPanel';
import { HUD } from './ui/HUD';
import { ConnectionOverlay } from './ui/ConnectionOverlay';
import { FightOverlay } from './ui/FightOverlay';
import { Lobby } from './ui/Lobby';
import { Loading } from './ui/Loading';
import { MainMenu } from './ui/MainMenu';
import { HowToPlay, PauseMenu, SettingsPanel } from './ui/Modals';
import { toast } from './ui/toast';
import { VictoryScreen } from './ui/VictoryScreen';
import { t } from './i18n';
import { settings } from './utils/settings';

const uiRoot = document.getElementById('ui')!;
const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function applyAccessibility(): void {
  document.body.classList.toggle('hc', settings.get('highContrast'));
  document.body.classList.toggle('rm', settings.get('reducedMotion'));
  document.documentElement.lang = settings.get('lang');
}
applyAccessibility();
settings.subscribe(applyAccessibility);

async function boot(): Promise<void> {
  const loading = new Loading();
  uiRoot.append(loading.el);
  await nextFrame();
  const started = performance.now();

  // font dipakai di texture papan (canvas), jadi tunggu dulu (maks 1.5 dtk)
  loading.setProgress(0.1);
  await Promise.race([document.fonts?.load('700 40px Fredoka') ?? Promise.resolve(), wait(1500)]);

  loading.setProgress(0.3);
  await nextFrame();
  const audio = new AudioManager();
  const bus = new EventBus();
  const sm = new SceneManager(document.getElementById('scene') as HTMLCanvasElement, document.getElementById('labels')!);

  loading.setProgress(0.55);
  await nextFrame();
  const stage = new Stage(sm, bus);
  const game = new Game(bus, stage, sm, audio);
  audio.bindEvents(bus);

  loading.setProgress(0.8);
  await nextFrame();
  stage.setBoardMap(BOARD_PRESETS.normal);

  // ── layar & modal ──
  const net = new NetworkClient();
  const settingsPanel = new SettingsPanel();
  const howTo = new HowToPlay();

  const goMenu = () => {
    menu.setResumeAvailable(readSave() !== null);
    menu.show();
  };

  const menu: MainMenu = new MainMenu({
    onPlay: () => {
      menu.hide();
      setup.show();
    },
    onResume: () => {
      const save = readSave();
      if (!save) return;
      menu.hide();
      pause.setOnline(false);
      game.resume(save);
    },
    onOnline: () => {
      menu.hide();
      lobby.show();
    },
    onWatch: () => {
      menu.hide();
      lobby.show(undefined, true);
    },
    onSettings: () => settingsPanel.show(),
    onHowTo: () => howTo.show(),
  });

  const lobby: Lobby = new Lobby(net, {
    onBack: () => {
      lobby.hide();
      goMenu();
    },
    onVisibility: () => chat.refresh(),
  });

  // live chat kiri bawah: tampil selama berada di room (lobby room / permainan online)
  const chat: ChatPanel = new ChatPanel(net, bus, () => (game.online ? 'game' : lobby.isVisible ? 'lobby' : null));

  const setup: CharacterSelect = new CharacterSelect({
    onStart: (config) => {
      setup.hide();
      pause.setOnline(false);
      game.start(config);
    },
    onBack: () => {
      setup.hide();
      goMenu();
    },
  });

  const pause: PauseMenu = new PauseMenu({
    onResume: () => game.togglePause(),
    onSettings: () => settingsPanel.show(),
    onQuit: () => {
      pause.hide();
      if (game.online) net.leave();
      game.exit();
      goMenu();
    },
    onKick: (id) => net.send({ t: 'kick', playerId: id }),
  });
  /** host online: daftar pemain yang bisa dikeluarkan di menu */
  const syncPauseRoster = () => {
    const room = net.room;
    pause.setRoster(game.online && room && net.isHost && !net.isSpectator ? room.players.filter((p) => p.id !== net.myId) : []);
  };
  bus.on('pause', ({ paused }) => {
    if (paused) {
      syncPauseRoster();
      pause.show();
    } else pause.hide();
  });

  const hud = new HUD(game, {
    onPause: () => game.togglePause(),
    onResetCamera: () => stage.camera.resetView(),
  });

  const victory: VictoryScreen = new VictoryScreen(game, {
    onAgain: () => {
      victory.hide();
      if (game.online) {
        // online: kembali ke lobby room yang sama untuk main lagi (penonton ikut menunggu di lobby)
        if (!net.isSpectator) net.send({ t: 'back_to_lobby' });
        game.exit();
        lobby.show();
      } else {
        game.start(game.config);
      }
    },
    onMenu: () => {
      victory.hide();
      if (game.online) net.leave();
      game.exit();
      goMenu();
    },
  });

  const fight = new FightOverlay(net, game, audio);

  const netOverlay = new ConnectionOverlay(net, {
    onLeave: () => {
      net.leave();
      if (game.online) game.exit();
      lobby.hide();
      goMenu();
      netOverlay.update();
    },
  });

  // chat sebelum modal: aturan CSS .modal:nth-last-child menumpuk modal terakhir paling atas
  uiRoot.append(menu.el, setup.el, lobby.el, hud.el, fight.el, victory.el, chat.el, pause.el, howTo.el, settingsPanel.el, netOverlay.el);

  // suara tombol (delegasi)
  uiRoot.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('button')) audio.playSfx('click');
  });
  uiRoot.addEventListener('pointerover', (e) => {
    const b = (e.target as HTMLElement).closest('button');
    if (b && !b.contains(e.relatedTarget as Node | null)) audio.playSfx('hover');
  });

  // Tab di latar belakang: browser menghentikan requestAnimationFrame (animasi membeku). Game lokal cukup
  // berhenti di tempat lalu lanjut mulus; game online terus berjalan di server, jadi saat tab aktif lagi
  // client mengambil snapshot terbaru dan melompat ke keadaan sekarang (bukan memutar ulang giliran lama).
  let hiddenAt = 0;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      hiddenAt = Date.now();
      audio.suspend();
      return;
    }
    audio.resume();
    if (!game.online) return;
    net.ensureConnected();
    const away = Date.now() - hiddenAt;
    if (away > 1500 && game.machine.phase !== 'GAME_OVER' && net.status === 'connected') net.sync();
  });

  if (import.meta.env.DEV) {
    (window as unknown as Record<string, unknown>).__sl3d = { game, stage, sm, audio, net };
  }

  // ── multiplayer: pesan server yang menggerakkan layar ──
  let autoRejoin = net.hasSession;
  net.on('game_start', ({ state }) => {
    autoRejoin = false;
    lobby.hide();
    menu.hide();
    pause.setOnline(true, net.isSpectator);
    game.startOnline(net, state, false);
  });
  net.on('game_snapshot', ({ state }) => {
    autoRejoin = false;
    lobby.hide();
    menu.hide();
    pause.setOnline(true, net.isSpectator);
    game.startOnline(net, state, true);
  });
  net.on('joined', () => {
    autoRejoin = false;
  });
  net.on('error', ({ code }) => {
    // sesi room lama sudah tidak ada (server restart / room bubar): kembali ke menu
    if (code === 'rejoin_failed') {
      autoRejoin = false;
      lobby.setRestoring(false);
      if (game.online) game.exit();
      lobby.hide();
      goMenu();
      toast(t('net.expired'), 'bad');
    } else if (code === 'room_closed') {
      // penonton: semua pemain keluar dan room bubar → kembali ke daftar live
      pause.hide();
      victory.hide();
      if (game.online) game.exit();
      lobby.show();
    }
  });
  net.on('kicked', () => {
    // dikeluarkan host: kembali ke layar buat/gabung room (pesan tampil di lobby)
    autoRejoin = false;
    pause.hide();
    victory.hide();
    if (game.online) game.exit();
    lobby.show();
  });
  net.on('room_state', ({ room }) => {
    syncPauseRoster();
    // room kembali ke lobby saat permainan masih berjalan = lawan semua keluar
    if (game.online && room.phase === 'lobby' && game.machine.phase !== 'GAME_OVER') {
      game.exit();
      lobby.show();
      lobby.notify(t('net.aborted'));
    }
  });
  let wasOffline = false;
  net.onStatus((s) => {
    if (!game.online) return;
    if (s === 'disconnected') {
      wasOffline = true;
    } else if (s === 'connected' && wasOffline) {
      wasOffline = false;
      toast(t('net.reconnected'), 'good');
    }
  });

  sm.start();
  loading.setProgress(1);
  const elapsed = performance.now() - started;
  if (elapsed < 1300) await wait(1300 - elapsed);

  audio.playMusic('menu');
  stage.camera.attract(true);
  const params = new URLSearchParams(location.search);
  const inviteCode = params.get('room');
  const watchCode = params.get('watch');
  if (inviteCode || watchCode) {
    // tautan undangan ?room=KODE / tautan tonton ?watch=KODE: langsung ke lobby dengan kode terisi
    history.replaceState(null, '', location.pathname);
    lobby.show(inviteCode ?? watchCode ?? undefined, !inviteCode);
  } else if (autoRejoin) {
    // mencoba masuk kembali ke room terakhir (mis. setelah tab tertutup / refresh)
    lobby.setRestoring(true);
    lobby.show();
  } else {
    goMenu();
  }
  loading.hide();
}

boot().catch((err) => {
  console.error(err);
  uiRoot.replaceChildren();
  const box = document.createElement('div');
  box.className = 'screen error';
  box.textContent = 'WebGL 2 diperlukan untuk memainkan game ini. / WebGL 2 is required to play.';
  uiRoot.append(box);
});
