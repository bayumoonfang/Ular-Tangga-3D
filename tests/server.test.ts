// @vitest-environment node
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server } from 'socket.io';
import { io as connect, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GameState } from '../src/core/GameState';
import { applyRoll, rollDie } from '../src/core/Rules';
import { FIGHT_HIT_AT, fightDamage, judgeBeat, type ClientMsg, type RoomInfo, type ServerMsg } from '../src/network/protocol';
import { createRng } from '../src/utils/random';
import { BOARD_PRESETS } from '../src/config';
import {
  ARENA_HP,
  ATTACK_ITEMS,
  BAG_SIZE,
  ITEM_MIN_GAP,
  SHIELD_MAX,
  SHIELD_PER_ITEM,
  inReach,
  isItem,
  itemRange,
  randomAttackItem,
  spawnItems,
  type ItemId,
} from '../src/core/Arena';

// jeda server dipercepat 100x agar permainan penuh selesai dalam detik
process.env.SL3D_TIME_SCALE = '0.01';

let http: HttpServer;
let url: string;

beforeAll(async () => {
  const { RoomManager } = await import('../server/RoomManager');
  const manager = new RoomManager();
  http = createServer();
  const io = new Server(http, { cors: { origin: true } });
  io.on('connection', (s) => manager.attach(s));
  await new Promise<void>((r) => http.listen(0, r));
  url = `http://localhost:${(http.address() as AddressInfo).port}`;
});

afterAll(() => {
  http.close();
});

/** Klien uji: mengumpulkan semua pesan server dan menyediakan helper menunggu. */
class TestClient {
  socket: Socket;
  msgs: ServerMsg[] = [];
  me = '';
  token = '';
  room: RoomInfo | null = null;
  state: GameState | null = null;

  constructor() {
    this.socket = connect(url, { forceNew: true, transports: ['websocket'] });
    this.socket.on('msg', (m: ServerMsg) => {
      this.msgs.push(m);
      if (m.t === 'joined') {
        this.me = m.you;
        this.token = m.token;
        this.room = m.room;
      } else if (m.t === 'room_state') this.room = m.room;
      else if (m.t === 'game_start' || m.t === 'game_snapshot') this.state = m.state;
      else if (m.t === 'kicked') this.room = null;
    });
  }

  send(msg: ClientMsg): void {
    this.socket.emit('msg', msg);
  }

  async wait<T extends ServerMsg['t']>(type: T, timeout = 4000, from = 0): Promise<Extract<ServerMsg, { t: T }>> {
    const t0 = Date.now();
    for (;;) {
      const found = this.msgs.slice(from).find((m) => m.t === type);
      if (found) return found as Extract<ServerMsg, { t: T }>;
      if (Date.now() - t0 > timeout) throw new Error(`timeout menunggu ${type}`);
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  close(): void {
    this.socket.close();
  }
}

async function open(): Promise<TestClient> {
  const c = new TestClient();
  await new Promise<void>((r) => c.socket.on('connect', () => r()));
  return c;
}

async function makeRoom(n: number): Promise<TestClient[]> {
  const host = await open();
  host.send({ t: 'create_room', name: 'Host', character: 'kiko' });
  await host.wait('joined');
  const clients = [host];
  for (let i = 1; i < n; i++) {
    const c = await open();
    c.send({ t: 'join_room', code: host.room!.code, name: `P${i}`, character: 'kiko' });
    await c.wait('joined');
    clients.push(c);
  }
  return clients;
}

describe('room & lobby', () => {
  it('membuat room dengan kode 6 karakter, host otomatis', async () => {
    const [host] = await makeRoom(1);
    expect(host.room!.code).toMatch(/^[A-HJKMNP-Z2-9]{6}$/);
    expect(host.room!.hostId).toBe(host.me);
    host.close();
  });

  it('karakter bentrok otomatis diganti, nama kembar dibedakan', async () => {
    const [host, b] = await makeRoom(2);
    const chars = b.room!.players.map((p) => p.character);
    expect(new Set(chars).size).toBe(2);
    b.send({ t: 'set_character', character: host.room!.players[0].character });
    const err = await b.wait('error');
    expect(err.message).toMatch(/sudah dipakai/);
    host.close();
    b.close();
  });

  it('maksimal 4 pemain: pemain ke-5 ditolak', async () => {
    const clients = await makeRoom(4);
    const extra = await open();
    extra.send({ t: 'join_room', code: clients[0].room!.code, name: 'Lima', character: 'mimi' });
    const err = await extra.wait('error');
    expect(err.message).toMatch(/penuh/);
    [...clients, extra].forEach((c) => c.close());
  });

  it('kode salah ditolak', async () => {
    const c = await open();
    c.send({ t: 'join_room', code: 'ZZZZZZ', name: 'X', character: 'kiko' });
    expect((await c.wait('error')).message).toMatch(/tidak ditemukan/);
    c.close();
  });

  it('minimal 2 pemain dan semua siap sebelum mulai; hanya host yang boleh mulai', async () => {
    const [host, b] = await makeRoom(1).then(async ([h]) => {
      const c = await open();
      return [h, c] as const;
    });
    host.send({ t: 'start_game' });
    expect((await host.wait('error')).message).toMatch(/minimal 2/);

    b.send({ t: 'join_room', code: host.room!.code, name: 'B', character: 'bobo' });
    await b.wait('joined');
    b.send({ t: 'start_game' });
    expect((await b.wait('error')).message).toMatch(/host/);

    const from = host.msgs.length;
    host.send({ t: 'start_game' });
    expect((await host.wait('error', 4000, from)).message).toMatch(/siap/);

    b.send({ t: 'ready', ready: true });
    await new Promise((r) => setTimeout(r, 50));
    host.send({ t: 'start_game' });
    await host.wait('game_start');
    host.close();
    b.close();
  });
});

describe('permainan online', () => {
  it('4 pemain memainkan satu game penuh; simulasi client = server', async () => {
    const clients = await makeRoom(4);
    for (const c of clients.slice(1)) c.send({ t: 'ready', ready: true });
    await new Promise((r) => setTimeout(r, 80));
    clients[0].send({ t: 'start_game' });
    const start = await clients[0].wait('game_start');
    expect(start.state.players).toHaveLength(4);
    const states = new Map<TestClient, GameState>();
    for (const c of clients) states.set(c, (await c.wait('game_start')).state);

    // setiap klien mereplikasi aturan dari hasil server dan harus selalu cocok
    let finished = false;
    const done = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('game tidak selesai')), 20000);
      for (const c of clients) {
        c.socket.on('msg', (m: ServerMsg) => {
          if (m.t === 'turn' && m.playerId === c.me) c.send({ t: 'roll' });
          if (m.t === 'turn_result') {
            const { state } = applyRoll(states.get(c)!, m.value);
            states.set(c, state);
            expect(state.players.map((p) => p.position)).toEqual(m.after.positions);
            expect(state.current).toBe(m.after.current);
            if (m.after.winnerId && !finished) {
              finished = true;
              clearTimeout(timeout);
              resolve();
            }
          }
        });
      }
    });
    await done;
    await new Promise((r) => setTimeout(r, 100)); // beri waktu pesan terakhir sampai ke semua klien
    const results = clients[0].msgs.filter((m) => m.t === 'turn_result');
    expect(results.length).toBeGreaterThan(10);
    // semua klien menerima urutan lemparan yang sama
    const seqs = clients.map((c) => c.msgs.filter((m) => m.t === 'turn_result').map((m) => (m as Extract<ServerMsg, { t: 'turn_result' }>).value).join(','));
    expect(new Set(seqs).size).toBe(1);
    await new Promise((r) => setTimeout(r, 50));
    expect(clients[0].room!.phase).toBe('finished');

    // kembali ke lobby untuk main lagi
    clients[1].send({ t: 'back_to_lobby' });
    await new Promise((r) => setTimeout(r, 60));
    expect(clients[0].room!.phase).toBe('lobby');
    clients.forEach((c) => c.close());
  }, 30000);

  it('lemparan di luar giliran ditolak', async () => {
    const [host, b] = await makeRoom(2);
    b.send({ t: 'ready', ready: true });
    await new Promise((r) => setTimeout(r, 50));
    host.send({ t: 'start_game' });
    const start = await host.wait('game_start');
    const first = start.state.players[start.state.current].id;
    const other = first === host.me ? b : host;
    other.send({ t: 'roll' });
    expect((await other.wait('error')).message).toMatch(/giliran/);
    host.close();
    b.close();
  });

  it('pemain AFK dilempar otomatis oleh server (timeout giliran)', async () => {
    const [host, b] = await makeRoom(2);
    b.send({ t: 'ready', ready: true });
    await new Promise((r) => setTimeout(r, 50));
    host.send({ t: 'start_game' });
    await host.wait('game_start');
    const res = await host.wait('turn_result', 3000); // tidak ada yang melempar
    expect(res.value).toBeGreaterThanOrEqual(1);
    expect(res.boost).toBe(false);
    host.close();
    b.close();
  });

  it('terputus lalu masuk kembali dengan token: mendapat snapshot state', async () => {
    const [host, b] = await makeRoom(2);
    b.send({ t: 'ready', ready: true });
    await new Promise((r) => setTimeout(r, 50));
    host.send({ t: 'start_game' });
    await host.wait('game_start');
    await host.wait('turn_result', 3000);

    const code = host.room!.code;
    const token = b.token;
    b.close();
    await new Promise((r) => setTimeout(r, 60));
    expect(host.room!.players.find((p) => p.id !== host.me)!.connected).toBe(false);

    const back = await open();
    back.send({ t: 'rejoin', code, token });
    const joined = await back.wait('joined');
    expect(joined.you).toBe(b.me);
    const snap = await back.wait('game_snapshot');
    expect(snap.state.players).toHaveLength(2);
    expect(host.room!.players.every((p) => p.connected)).toBe(true);
    host.close();
    back.close();
  });

  it('token salah ditolak saat rejoin', async () => {
    const [host] = await makeRoom(1);
    const c = await open();
    c.send({ t: 'rejoin', code: host.room!.code, token: 'palsu' });
    const err = await c.wait('error');
    expect(err.code).toBe('rejoin_failed');
    host.close();
    c.close();
  });

  it('host keluar: host berpindah ke pemain berikutnya', async () => {
    const [host, b] = await makeRoom(2);
    host.send({ t: 'leave' });
    await new Promise((r) => setTimeout(r, 60));
    expect(b.room!.hostId).toBe(b.me);
    expect(b.room!.players).toHaveLength(1);
    host.close();
    b.close();
  });
});

describe('sambung ulang', () => {
  it('sync mengirim snapshot state terbaru saat bermain', async () => {
    const [host, b] = await makeRoom(2);
    b.send({ t: 'ready', ready: true });
    await new Promise((r) => setTimeout(r, 50));
    host.send({ t: 'start_game' });
    await host.wait('game_start');
    await host.wait('turn_result', 3000);
    const from = b.msgs.length;
    b.send({ t: 'sync' });
    const snap = await b.wait('game_snapshot', 3000, from);
    expect(snap.state.players).toHaveLength(2);
    expect(snap.state.turn).toBeGreaterThan(1);
    host.close();
    b.close();
  });

  it('pemain terputus tetap di room dan menerima snapshot saat kembali (dua kali berturut-turut)', async () => {
    const [host, b] = await makeRoom(2);
    b.send({ t: 'ready', ready: true });
    await new Promise((r) => setTimeout(r, 50));
    host.send({ t: 'start_game' });
    await host.wait('game_start');
    const code = host.room!.code;
    let token = b.token;
    let cur = b;
    for (let i = 0; i < 2; i++) {
      cur.close();
      await new Promise((r) => setTimeout(r, 60));
      expect(host.room!.players.some((p) => !p.connected)).toBe(true);
      const back = await open();
      back.send({ t: 'rejoin', code, token });
      await back.wait('game_snapshot');
      token = (await back.wait('joined')).token;
      expect(host.room!.players.every((p) => p.connected)).toBe(true);
      cur = back;
    }
    host.close();
    cur.close();
  });

  it('game selesai: pemain yang masuk kembali mendapat state akhir (pemenang terisi)', async () => {
    const [host, b] = await makeRoom(2);
    b.send({ t: 'ready', ready: true });
    await new Promise((r) => setTimeout(r, 50));
    host.send({ t: 'start_game' });
    await host.wait('game_start');
    // kedua pemain melempar begitu gilirannya tiba sampai ada pemenang
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('tidak selesai')), 25000);
      for (const c of [host, b]) {
        c.socket.on('msg', (m: ServerMsg) => {
          if (m.t === 'turn' && m.playerId === c.me) c.send({ t: 'roll' });
          if (c === host && m.t === 'turn_result' && m.after.winnerId) {
            clearTimeout(timeout);
            resolve();
          }
        });
      }
    });
    const code = host.room!.code;
    const token = b.token;
    b.close();
    await new Promise((r) => setTimeout(r, 60));
    const back = await open();
    back.send({ t: 'rejoin', code, token });
    const snap = await back.wait('game_snapshot');
    expect(snap.state.winnerId).not.toBeNull();
    host.close();
    back.close();
  }, 30000);
});

async function startGame(n: number): Promise<TestClient[]> {
  const clients = await makeRoom(n);
  for (const c of clients.slice(1)) c.send({ t: 'ready', ready: true });
  await new Promise((r) => setTimeout(r, 50));
  clients[0].send({ t: 'start_game' });
  await clients[0].wait('game_start');
  return clients;
}

describe('ekspresi', () => {
  it('ekspresi pemain sampai ke pemain lain dan pengirimnya', async () => {
    const [host, b] = await makeRoom(2);
    host.send({ t: 'emote', id: 'clap' });
    const atB = await b.wait('emote');
    expect(atB).toMatchObject({ playerId: host.me, id: 'clap', spectator: false, name: 'Host' });
    expect((await host.wait('emote')).id).toBe('clap');
    host.close();
    b.close();
  });

  it('ekspresi tak dikenal diabaikan dan spam dibatasi', async () => {
    const [host, b] = await makeRoom(2);
    host.send({ t: 'emote', id: 'bukan-ekspresi' });
    host.send({ t: 'emote', id: 'laugh' });
    host.send({ t: 'emote', id: 'wow' }); // terlalu cepat setelah yang sebelumnya
    await new Promise((r) => setTimeout(r, 80));
    expect(b.msgs.filter((m) => m.t === 'emote').map((m) => (m as Extract<ServerMsg, { t: 'emote' }>).id)).toEqual(['laugh']);
    host.close();
    b.close();
  });
});

describe('live: penonton & chat', () => {
  it('nama wajib diisi untuk menonton', async () => {
    const [host] = await makeRoom(1);
    const v = await open();
    v.send({ t: 'spectate', code: host.room!.code, name: '   ' });
    expect((await v.wait('error')).message).toMatch(/nama/i);
    host.close();
    v.close();
  });

  it('penonton masuk saat bermain: dapat snapshot, jumlah penonton tampil, tidak boleh melempar', async () => {
    const [host, b] = await startGame(2);
    const v = await open();
    v.send({ t: 'spectate', code: host.room!.code, name: 'Budi' });
    const joined = await v.wait('joined');
    expect(joined.role).toBe('spectator');
    expect(joined.name).toBe('Budi');
    const snap = await v.wait('game_snapshot');
    expect(snap.state.players).toHaveLength(2);
    await new Promise((r) => setTimeout(r, 50));
    expect(host.room!.viewers).toEqual(['Budi']);
    // penonton tetap menerima hasil lemparan
    await v.wait('turn_result', 3000);
    const from = v.msgs.length;
    v.send({ t: 'roll' });
    expect((await v.wait('error', 2000, from)).message).toMatch(/Penonton/);
    v.send({ t: 'back_to_lobby' });
    await new Promise((r) => setTimeout(r, 50));
    expect(host.room!.phase).toBe('playing');
    // penonton keluar → hitungan turun
    v.send({ t: 'leave' });
    await new Promise((r) => setTimeout(r, 60));
    expect(host.room!.viewers).toEqual([]);
    [host, b, v].forEach((c) => c.close());
  });

  it('nama penonton yang sama dengan pemain dibedakan', async () => {
    const [host] = await makeRoom(1);
    const v = await open();
    v.send({ t: 'spectate', code: host.room!.code, name: 'host' });
    expect((await v.wait('joined')).name).toBe('host 2');
    host.close();
    v.close();
  });

  it('chat pemain & penonton sampai ke semua anggota; riwayat dikirim ke yang baru masuk', async () => {
    const [host, b] = await makeRoom(2);
    const v = await open();
    v.send({ t: 'spectate', code: host.room!.code, name: 'Budi' });
    await v.wait('joined');
    host.send({ t: 'chat', text: '  halo   semua  ' });
    const atV = await v.wait('chat');
    // pesan pertama yang diterima penonton adalah sambutan sistem miliknya sendiri
    expect(atV.msg.role).toBe('system');
    await new Promise((r) => setTimeout(r, 60));
    const texts = (c: TestClient) => c.msgs.filter((m) => m.t === 'chat').map((m) => (m as Extract<ServerMsg, { t: 'chat' }>).msg);
    const hello = texts(v).find((m) => m.text === 'halo semua');
    expect(hello).toMatchObject({ role: 'player', name: 'Host', from: host.me });

    v.send({ t: 'chat', text: 'semangat!' });
    await new Promise((r) => setTimeout(r, 60));
    expect(texts(b).find((m) => m.text === 'semangat!')).toMatchObject({ role: 'spectator', name: 'Budi' });

    // penonton kedua mendapat riwayat
    const w = await open();
    w.send({ t: 'spectate', code: host.room!.code, name: 'Wati' });
    const hist = await w.wait('chat_history');
    expect(hist.msgs.map((m) => m.text)).toEqual(expect.arrayContaining(['halo semua', 'semangat!']));
    // ekspresi penonton ditandai spectator
    w.send({ t: 'emote', id: 'cheer' });
    expect(await host.wait('emote')).toMatchObject({ spectator: true, name: 'Wati', id: 'cheer' });
    [host, b, v, w].forEach((c) => c.close());
  });

  it('chat kosong diabaikan, terlalu cepat ditolak dengan kode chat_rate', async () => {
    const [host, b] = await makeRoom(2);
    host.send({ t: 'chat', text: '    ' });
    host.send({ t: 'chat', text: 'satu' });
    host.send({ t: 'chat', text: 'dua' });
    const err = await host.wait('error');
    expect(err.code).toBe('chat_rate');
    await new Promise((r) => setTimeout(r, 50));
    expect(b.msgs.filter((m) => m.t === 'chat')).toHaveLength(1);
    host.close();
    b.close();
  });

  it('daftar live hanya berisi room yang sedang bermain', async () => {
    const [lobbyHost] = await makeRoom(1);
    const [host, b] = await startGame(2);
    const v = await open();
    v.send({ t: 'list_live' });
    const list = await v.wait('live_list');
    const codes = list.rooms.map((r) => r.code);
    expect(codes).toContain(host.room!.code);
    expect(codes).not.toContain(lobbyHost.room!.code);
    expect(list.rooms.find((r) => r.code === host.room!.code)!.players).toHaveLength(2);
    [lobbyHost, host, b, v].forEach((c) => c.close());
  });

  it('penonton terputus bisa kembali dengan token', async () => {
    const [host, b] = await startGame(2);
    const v = await open();
    v.send({ t: 'spectate', code: host.room!.code, name: 'Budi' });
    const joined = await v.wait('joined');
    v.close();
    await new Promise((r) => setTimeout(r, 60));
    expect(host.room!.viewers).toEqual([]);
    const back = await open();
    back.send({ t: 'rejoin', code: host.room!.code, token: joined.token });
    const again = await back.wait('joined');
    expect(again).toMatchObject({ role: 'spectator', you: joined.you, name: 'Budi' });
    await back.wait('game_snapshot');
    await back.wait('chat_history');
    expect(host.room!.viewers).toEqual(['Budi']);
    [host, b, back].forEach((c) => c.close());
  });

  it('semua pemain keluar: penonton diberi tahu room bubar', async () => {
    const [host, b] = await makeRoom(2);
    const v = await open();
    v.send({ t: 'spectate', code: host.room!.code, name: 'Budi' });
    await v.wait('joined');
    host.send({ t: 'leave' });
    b.send({ t: 'leave' });
    expect((await v.wait('error')).code).toBe('room_closed');
    // room benar-benar hilang dari server
    const late = await open();
    late.send({ t: 'spectate', code: host.room!.code, name: 'Telat' });
    expect((await late.wait('error')).message).toMatch(/tidak ditemukan/);
    [host, b, v, late].forEach((c) => c.close());
  });
});

describe('kick & slot kosong', () => {
  it('hanya host yang boleh kick; yang di-kick menerima pesan kicked dan keluar dari room', async () => {
    const [host, b, c] = await makeRoom(3);
    b.send({ t: 'kick', playerId: c.me });
    expect((await b.wait('error')).message).toMatch(/host/);
    host.send({ t: 'kick', playerId: host.me });
    expect((await host.wait('error')).message).toMatch(/diri sendiri/);
    host.send({ t: 'kick', playerId: c.me });
    await c.wait('kicked');
    await new Promise((r) => setTimeout(r, 60));
    expect(host.room!.players.map((p) => p.id)).not.toContain(c.me);
    // sambungan yang di-kick tidak lagi terikat ke room
    const from = c.msgs.length;
    c.send({ t: 'ready', ready: true });
    expect((await c.wait('error', 2000, from)).message).toMatch(/belum berada/);
    [host, b, c].forEach((x) => x.close());
  });

  it('kick saat bermain: pion diangkat, slot kosong bisa diisi pemain baru yang mulai dari Start', async () => {
    const [host, b, c] = await startGame(3);
    const from = host.msgs.length;
    host.send({ t: 'kick', playerId: c.me });
    await c.wait('kicked');
    const snap = await host.wait('game_snapshot', 3000, from);
    expect(snap.state.players.map((p) => p.id)).not.toContain(c.me);
    await new Promise((r) => setTimeout(r, 40));
    expect(host.room!.openSlots).toBe(1);
    expect(host.room!.waiting).toBe(false);

    const d = await open();
    d.send({ t: 'join_room', code: host.room!.code, name: 'Dodi', character: 'kiko' });
    const joined = await d.wait('joined');
    const dsnap = await d.wait('game_snapshot');
    const me = dsnap.state.players.find((p) => p.id === joined.you)!;
    expect(me.position).toBe(0);
    expect(dsnap.state.players).toHaveLength(3);
    // karakter tidak bentrok dengan pemain yang tersisa
    expect(new Set(dsnap.state.players.map((p) => p.character)).size).toBe(3);
    await new Promise((r) => setTimeout(r, 40));
    expect(host.room!.openSlots).toBe(0);

    // slot sudah terisi: pemain lain ditolak
    const e = await open();
    e.send({ t: 'join_room', code: host.room!.code, name: 'Eka', character: 'kiko' });
    expect((await e.wait('error')).message).toMatch(/sudah dimulai/);
    [host, b, c, d, e].forEach((x) => x.close());
  });

  it('tinggal 1 pemain setelah kick: permainan menunggu, lalu lanjut saat ada yang bergabung', async () => {
    const [host, b] = await startGame(2);
    const from = host.msgs.length;
    host.send({ t: 'kick', playerId: b.me });
    await b.wait('kicked');
    await host.wait('game_snapshot', 3000, from);
    await new Promise((r) => setTimeout(r, 40));
    expect(host.room!.phase).toBe('playing');
    expect(host.room!.waiting).toBe(true);
    host.send({ t: 'roll' });
    expect((await host.wait('error', 2000, from)).message).toMatch(/Menunggu/);

    const d = await open();
    const turnFrom = host.msgs.length;
    d.send({ t: 'join_room', code: host.room!.code, name: 'Dodi', character: 'kiko' });
    await d.wait('joined');
    await host.wait('turn', 3000, turnFrom);
    expect(host.room!.waiting).toBe(false);
    // giliran berjalan lagi (AFK = dilempar otomatis)
    await host.wait('turn_result', 3000, turnFrom);
    [host, b, d].forEach((x) => x.close());
  });

  it('pemain keluar saat bermain juga membuka slot', async () => {
    const [host, b, c] = await startGame(3);
    c.send({ t: 'leave' });
    await new Promise((r) => setTimeout(r, 60));
    expect(host.room!.openSlots).toBe(1);
    expect(host.state!.players).toHaveLength(2);
    [host, b, c].forEach((x) => x.close());
  });
});

describe('duel', () => {
  it('penilaian & damage: miss tanpa serangan, perfect lebih besar, combo menambah damage', () => {
    expect(judgeBeat(FIGHT_HIT_AT)).toBe('perfect');
    expect(judgeBeat(FIGHT_HIT_AT + 0.04)).toBe('great');
    expect(judgeBeat(FIGHT_HIT_AT - 0.07)).toBe('cool');
    expect(judgeBeat(FIGHT_HIT_AT + 0.12)).toBe('bad');
    expect(judgeBeat(0.3)).toBe('miss');
    expect(fightDamage(5, 'miss', 0)).toBe(0);
    expect(fightDamage(5, 'perfect', 1)).toBeGreaterThan(fightDamage(5, 'cool', 1));
    expect(fightDamage(5, 'perfect', 4)).toBeGreaterThan(fightDamage(5, 'perfect', 1));
  });

  it('berhenti di petak lawan memicu duel; HP lebih tinggi menang, yang kalah kembali ke Start', async () => {
    const { Room } = await import('../server/Room');
    const sent: ServerMsg[] = [];
    const room = new Room('DUEL01', (sid, msg) => sid === 'sa' && sent.push(msg), () => {});
    const a = room.add('sa', 'Ana', 'kiko');
    const b = room.add('sb', 'Budi', 'bobo');
    room.updateSettings(a.id, undefined, undefined, true);
    room.setReady(b.id, true);
    room.start(a.id);
    const state = (room as unknown as { state: GameState }).state;
    state.board = { ladders: {}, snakes: {} };
    const mover = state.players[state.current];
    const rival = state.players[1 - state.current];
    mover.position = 10;
    // lemparan berikutnya sudah bisa dihitung dari RNG state: taruh lawan tepat di petak tujuan
    const rng = createRng(1);
    rng.setState(state.rngState);
    rival.position = 10 + rollDie(rng, false);
    const target = rival.position;

    const waitFor = async <T extends ServerMsg['t']>(t: T): Promise<Extract<ServerMsg, { t: T }>> => {
      for (let i = 0; i < 400; i++) {
        const m = sent.find((x) => x.t === t);
        if (m) return m as Extract<ServerMsg, { t: T }>;
        await new Promise((r) => setTimeout(r, 5));
      }
      throw new Error(`timeout menunggu ${t}`);
    };
    room.handleRoll(mover.id);
    expect((await waitFor('turn_result')).fight).toBe(true);
    const { fight } = await waitFor('fight_start');
    expect(fight.fighters).toEqual([mover.id, rival.id]);
    expect(fight.rounds).toHaveLength(6);

    // input ronde yang belum dimulai ditolak
    room.fightInput(mover.id, fight.id, 3, 'perfect');
    expect(sent.some((m) => m.t === 'fight_hit')).toBe(false);
    await new Promise((r) => setTimeout(r, fight.startsIn + 3));
    room.fightInput(mover.id, fight.id, 0, 'perfect');
    const hit = await waitFor('fight_hit');
    expect(hit.damage).toBeGreaterThan(0);
    expect(hit.hp[rival.id]).toBe(100 - hit.damage);
    // input ganda untuk ronde yang sama diabaikan
    room.fightInput(mover.id, fight.id, 0, 'perfect');
    expect(sent.filter((m) => m.t === 'fight_hit' && m.playerId === mover.id && m.round === 0)).toHaveLength(1);

    // lawan tidak pernah menekan apa pun: semua ronde miss, waktu habis → lawan kalah
    const end = await waitFor('fight_end');
    expect(end.winnerId).toBe(mover.id);
    expect(end.losers).toEqual([rival.id]);
    const after = (room as unknown as { state: GameState }).state;
    expect(after.players.find((p) => p.id === rival.id)!.position).toBe(0);
    expect(after.players.find((p) => p.id === mover.id)!.position).toBe(target);
    // giliran berlanjut setelah duel
    sent.length = 0;
    await waitFor('turn');
    room.destroy();
  });

  it('tanpa opsi duel: berhenti di petak yang sama tidak memicu duel', async () => {
    const { Room } = await import('../server/Room');
    const sent: ServerMsg[] = [];
    const room = new Room('DUEL02', (sid, msg) => sid === 'sa' && sent.push(msg), () => {});
    const a = room.add('sa', 'Ana', 'kiko');
    const b = room.add('sb', 'Budi', 'bobo');
    room.setReady(b.id, true);
    room.start(a.id);
    const state = (room as unknown as { state: GameState }).state;
    state.board = { ladders: {}, snakes: {} };
    const mover = state.players[state.current];
    mover.position = 10;
    const rng = createRng(1);
    rng.setState(state.rngState);
    state.players[1 - state.current].position = 10 + rollDie(rng, false);
    room.handleRoll(mover.id);
    const res = sent.find((m) => m.t === 'turn_result') as Extract<ServerMsg, { t: 'turn_result' }>;
    expect(res.fight).toBeUndefined();
    room.destroy();
  });
});

describe('duel live di room', () => {
  it('pemain lain & penonton di room menerima duel secara live: mulai, ketikan panah, serangan, hasil', async () => {
    const { Room } = await import('../server/Room');
    const inbox = new Map<string, ServerMsg[]>();
    const room = new Room('DUEL03', (sid, msg) => {
      if (!inbox.has(sid)) inbox.set(sid, []);
      inbox.get(sid)!.push(msg);
    }, () => {});
    const a = room.add('sa', 'Ana', 'kiko');
    const b = room.add('sb', 'Budi', 'bobo');
    const c = room.add('sc', 'Cici', 'pipi');
    room.addSpectator('sv', 'Vina');
    room.updateSettings(a.id, undefined, undefined, true);
    room.setReady(b.id, true);
    room.setReady(c.id, true);
    room.start(a.id);
    const state = (room as unknown as { state: GameState }).state;
    state.board = { ladders: {}, snakes: {} };
    const mover = state.players[state.current];
    const rest = state.players.filter((p) => p.id !== mover.id);
    const [rival, bystander] = rest;
    mover.position = 10;
    const rng = createRng(1);
    rng.setState(state.rngState);
    rival.position = 10 + rollDie(rng, false);
    bystander.position = 50;
    const sidOf = (id: string) => ({ [a.id]: 'sa', [b.id]: 'sb', [c.id]: 'sc' })[id];
    const watchers = [sidOf(bystander.id), 'sv']; // pemain yang tidak bertarung + penonton

    const waitFor = async <T extends ServerMsg['t']>(sid: string, t: T, pred: (m: Extract<ServerMsg, { t: T }>) => boolean = () => true) => {
      for (let i = 0; i < 400; i++) {
        const m = (inbox.get(sid) ?? []).find((x) => x.t === t && pred(x as Extract<ServerMsg, { t: T }>));
        if (m) return m as Extract<ServerMsg, { t: T }>;
        await new Promise((r) => setTimeout(r, 5));
      }
      throw new Error(`${sid}: timeout menunggu ${t}`);
    };

    room.handleRoll(mover.id);
    for (const sid of watchers) expect((await waitFor(sid, 'turn_result')).fight).toBe(true);
    const { fight } = await waitFor('sv', 'fight_start');
    expect(fight.fighters).toEqual([mover.id, rival.id]);
    expect((await waitFor(sidOf(bystander.id), 'fight_start')).fight.id).toBe(fight.id);

    // bukan petarung / ronde belum dimulai: progres tidak disiarkan
    room.fightProgress(bystander.id, fight.id, 0, 1, false);
    room.fightProgress(mover.id, fight.id, 0, 1, false);
    expect(watchers.some((sid) => inbox.get(sid)!.some((m) => m.t === 'fight_progress'))).toBe(false);

    await new Promise((r) => setTimeout(r, fight.startsIn + 3));
    room.fightProgress(mover.id, fight.id, 0, 2, false);
    room.fightProgress(rival.id, fight.id, 0, 0, true);
    room.fightProgress(mover.id, fight.id, 0, 99, false); // di luar panjang urutan: diabaikan
    room.fightInput(mover.id, fight.id, 0, 'great');
    for (const sid of watchers) {
      const prog = await waitFor(sid, 'fight_progress', (m) => m.playerId === mover.id);
      expect(prog).toMatchObject({ round: 0, typed: 2, wrong: false });
      expect(await waitFor(sid, 'fight_progress', (m) => m.playerId === rival.id)).toMatchObject({ typed: 0, wrong: true });
      expect(inbox.get(sid)!.filter((m) => m.t === 'fight_progress' && m.playerId === mover.id)).toHaveLength(1);
      const hit = await waitFor(sid, 'fight_hit', (m) => m.playerId === mover.id);
      expect(hit.grade).toBe('great');
      expect(hit.hp[rival.id]).toBe(100 - hit.damage);
    }
    // penonton yang baru masuk di tengah duel langsung mendapat duel berjalan (HP terkini)
    const late = room.addSpectator('sw', 'Wati');
    room.resync(late);
    const lateStart = await waitFor('sw', 'fight_start');
    expect(lateStart.fight.id).toBe(fight.id);
    expect(lateStart.fight.startsIn).toBeLessThanOrEqual(0);
    expect(lateStart.fight.hp[rival.id]).toBeLessThan(100);
    expect(inbox.get('sw')!.some((m) => m.t === 'turn')).toBe(false);

    // setelah menyerang, progres ronde itu tidak disiarkan lagi
    room.fightProgress(mover.id, fight.id, 0, 3, false);
    expect(inbox.get('sv')!.filter((m) => m.t === 'fight_progress' && m.playerId === mover.id)).toHaveLength(1);

    for (const sid of watchers) {
      const end = await waitFor(sid, 'fight_end');
      expect(end).toMatchObject({ winnerId: mover.id, losers: [rival.id] });
    }
    room.destroy();
  });

  it('opsi duel diatur host; penonton tidak bisa mengirim progres/input duel', async () => {
    const [host, b] = await makeRoom(2);
    host.send({ t: 'settings', fight: true });
    b.send({ t: 'ready', ready: true });
    await new Promise((r) => setTimeout(r, 50));
    expect(host.room!.settings.fight).toBe(true);
    const v = await open();
    v.send({ t: 'spectate', code: host.room!.code, name: 'Vina' });
    await v.wait('joined');
    const from = v.msgs.length;
    v.send({ t: 'fight_progress', id: 1, round: 0, typed: 1 });
    expect((await v.wait('error', 2000, from)).message).toMatch(/Penonton/);
    [host, b, v].forEach((x) => x.close());
  });
});

describe('mode arena', () => {
  type ArenaInternals = {
    hp: Record<string, number>;
    shield: Record<string, number>;
    bags: Record<string, string[]>;
    tileItems: { tile: number; item: string }[];
    respawns: unknown[];
  };
  const sleep = (n: number) => new Promise((r) => setTimeout(r, n));

  async function arenaRoom(code: string) {
    const { Room } = await import('../server/Room');
    const inbox: ServerMsg[] = [];
    const room = new Room(code, (sid, msg) => sid === 'sa' && inbox.push(msg), () => {});
    const a = room.add('sa', 'Ana', 'kiko');
    const b = room.add('sb', 'Budi', 'bobo');
    room.setReady(b.id, true);
    room.start(a.id);
    const internals = room as unknown as { state: GameState; arena: ArenaInternals };
    internals.state.board = { ladders: {}, snakes: {} };
    await sleep(40); // intro (2500 ms × 0,01) selesai: pemain giliran pertama boleh beraksi
    const s = internals.state;
    const mover = s.players[s.current];
    const other = s.players[1 - s.current];
    const place = (moverTile: number, otherTile: number) => {
      internals.state.players.find((p) => p.id === mover.id)!.position = moverTile;
      internals.state.players.find((p) => p.id === other.id)!.position = otherTile;
    };
    return { room, inbox, arena: () => internals.arena, state: () => internals.state, mover, other, place };
  }

  function nextTarget(s: GameState, from: number): number {
    const rng = createRng(1);
    rng.setState(s.rngState);
    return from + rollDie(rng, false);
  }

  const lastAttack = (inbox: ServerMsg[]) =>
    (inbox.filter((m) => m.t === 'arena_event' && m.ev.kind === 'attack').pop() as Extract<ServerMsg, { t: 'arena_event' }>).ev;

  it('item di papan tersebar berjauhan, bukan di petak 1/100, tangga, ular, atau pion', () => {
    const board = BOARD_PRESETS.normal;
    for (let i = 0; i < 50; i++) {
      const items = spawnItems(createRng(1000 + i), board, [5, 40]);
      expect(items.length).toBeGreaterThanOrEqual(4);
      for (const c of items) {
        expect(c.tile).toBeGreaterThan(1);
        expect(c.tile).toBeLessThan(100);
        expect([5, 40]).not.toContain(c.tile);
        expect(board.ladders[c.tile]).toBeUndefined();
        expect(board.snakes[c.tile]).toBeUndefined();
        expect(isItem(c.item)).toBe(true);
      }
      for (const x of items) for (const y of items) if (x !== y) expect(Math.abs(x.tile - y.tile)).toBeGreaterThanOrEqual(ITEM_MIN_GAP);
      const [extra] = spawnItems(createRng(7 + i), board, [], items, 1);
      if (extra) for (const x of items) expect(Math.abs(x.tile - extra.tile)).toBeGreaterThanOrEqual(ITEM_MIN_GAP);
    }
  });

  it('jarak serang per senjata: tinju 1, bom ≤3, panah ≤6, roket 2–12; petak sama & Start tidak berlaku', () => {
    const reach = (item: ItemId, a: number, b: number) => {
      const r = itemRange(item);
      return inReach(a, b, r.max, r.min);
    };
    expect(reach('punch', 5, 6)).toBe(true);
    expect(reach('punch', 5, 7)).toBe(false);
    expect(reach('bomb', 5, 8)).toBe(true);
    expect(reach('bomb', 5, 9)).toBe(false);
    expect(reach('arrow', 20, 14)).toBe(true);
    expect(reach('arrow', 20, 13)).toBe(false);
    expect(reach('rocket', 10, 11)).toBe(false); // terlalu dekat untuk roket
    expect(reach('rocket', 10, 22)).toBe(true);
    expect(reach('rocket', 10, 23)).toBe(false);
    expect(reach('bomb', 5, 5)).toBe(false);
    expect(reach('bomb', 0, 2)).toBe(false);
  });

  it('modal awal: darah penuh, 1 senjata serang acak di tas + perisai', async () => {
    const { room, inbox, mover } = await arenaRoom('ARN001');
    const msg = inbox.find((m) => m.t === 'arena') as Extract<ServerMsg, { t: 'arena' }>;
    expect(msg.arena.hp[mover.id]).toBe(ARENA_HP);
    expect(msg.arena.shield[mover.id]).toBe(SHIELD_PER_ITEM);
    expect(msg.arena.bags[mover.id]).toHaveLength(1);
    expect(ATTACK_ITEMS).toContain(msg.arena.bags[mover.id][0]);
    expect(msg.arena.tileItems.length).toBeGreaterThan(0);
    // modal acak: dalam banyak pemain tidak selalu senjata yang sama
    const seen = new Set<string>();
    const rng = createRng(3);
    for (let i = 0; i < 3000; i++) seen.add(randomAttackItem(rng));
    expect(seen.size).toBe(ATTACK_ITEMS.length);
    room.destroy();
  });

  it('berhenti di petak ber-item: masuk tas, hilang dari papan, muncul lagi 15 dtk kemudian', async () => {
    const { room, inbox, arena, state, mover } = await arenaRoom('ARN002');
    const s = state();
    s.players.find((p) => p.id === mover.id)!.position = 10;
    const target = nextTarget(s, 10);
    const before = [...arena().bags[mover.id]];
    arena().tileItems = [{ tile: target, item: 'potion' }];
    room.handleRoll(mover.id);
    const res = inbox.find((m) => m.t === 'turn_result') as Extract<ServerMsg, { t: 'turn_result' }>;
    expect(res.pickup).toEqual({ tile: target, item: 'potion' });
    expect(arena().bags[mover.id]).toEqual([...before, 'potion']);
    expect(arena().tileItems).toHaveLength(0);
    for (let i = 0; i < 100 && !inbox.some((m) => m.t === 'arena_event' && m.ev.kind === 'spawn'); i++) await sleep(10);
    expect(inbox.some((m) => m.t === 'arena_event' && m.ev.kind === 'spawn')).toBe(true);
    expect(arena().tileItems).toHaveLength(1);
    room.destroy();
  });

  it('tas penuh: item biasa tidak bisa diambil; perisai tetap bisa (tanpa slot, menambah daya tahan)', async () => {
    const { room, inbox, arena, state, mover } = await arenaRoom('ARN003');
    const s = state();
    s.players.find((p) => p.id === mover.id)!.position = 10;
    const target = nextTarget(s, 10);
    arena().bags[mover.id] = ['bomb', 'arrow', 'punch'];
    arena().tileItems = [{ tile: target, item: 'mirror' }];
    room.handleRoll(mover.id);
    let res = inbox.find((m) => m.t === 'turn_result') as Extract<ServerMsg, { t: 'turn_result' }>;
    expect(res.pickup).toBeUndefined();
    expect(arena().bags[mover.id]).toHaveLength(BAG_SIZE);
    expect(arena().tileItems).toEqual([{ tile: target, item: 'mirror' }]);

    // perisai: diambil walau tas penuh, daya tahan maksimal SHIELD_MAX
    const r = arena() as unknown as { pickup(id: string, tile: number): unknown };
    arena().tileItems = [{ tile: 50, item: 'shield' }];
    res = { ...res, pickup: r.pickup(mover.id, 50) as never };
    expect(res.pickup).toEqual({ tile: 50, item: 'shield' });
    expect(arena().shield[mover.id]).toBe(Math.min(SHIELD_MAX, SHIELD_PER_ITEM * 2));
    expect(arena().bags[mover.id]).toHaveLength(BAG_SIZE);
    room.destroy();
  });

  it('item dipakai = slot kosong; tidak bisa memakai item yang tidak ada di tas', async () => {
    const { room, arena, other } = await arenaRoom('ARN004');
    arena().bags[other.id] = ['potion', 'mirror', 'punch'];
    expect(() => room.useItem(other.id, 'potion')).toThrow(/penuh/);
    arena().hp[other.id] = 80;
    room.useItem(other.id, 'potion');
    expect(arena().hp[other.id]).toBe(ARENA_HP);
    expect(arena().bags[other.id]).toEqual(['mirror', 'punch']);
    expect(() => room.useItem(other.id, 'bomb')).toThrow(/tidak ada di tasmu/);
    expect(() => room.useItem(other.id, 'mirror')).toThrow(/otomatis/);
    room.destroy();
  });

  it('serangan: giliran sendiri & dalam jangkauan senjata; perisai menyerap damage', async () => {
    const { room, inbox, arena, mover, other, place } = await arenaRoom('ARN005');
    arena().bags[mover.id] = ['punch', 'rocket', 'bomb'];
    place(30, 32);
    expect(() => room.useItem(other.id, 'punch', mover.id)).toThrow(/giliranmu/);
    expect(() => room.useItem(mover.id, 'punch', other.id)).toThrow(/jangkauan/);
    expect(() => room.useItem(mover.id, 'rocket', other.id)).not.toThrow(); // jarak 2 → roket bisa
    let ev = lastAttack(inbox);
    expect(ev).toMatchObject({ outcome: 'hit', victimId: other.id, absorbed: 30, damage: 0, shieldBroken: false });
    expect(arena().shield[other.id]).toBe(SHIELD_PER_ITEM - 30);
    expect(arena().hp[other.id]).toBe(ARENA_HP);
    expect(() => room.useItem(mover.id, 'bomb', other.id)).toThrow(/Satu serangan/);

    // giliran berikutnya: bom 40 menghabiskan sisa perisai 30, 10 mengenai darah
    const s = (room as unknown as { state: GameState }).state;
    s.turn += 1;
    room.useItem(mover.id, 'bomb', other.id);
    ev = lastAttack(inbox);
    expect(ev).toMatchObject({ absorbed: 30, damage: 10, shieldBroken: true });
    expect(arena().shield[other.id]).toBe(0);
    expect(arena().hp[other.id]).toBe(ARENA_HP - 10);
    room.destroy();
  });

  it('petir menembus perisai; meteor hanya jarak jauh (5–25)', async () => {
    const { room, inbox, arena, mover, other, place } = await arenaRoom('ARN008');
    const s = (room as unknown as { state: GameState }).state;
    arena().bags[mover.id] = ['lightning', 'meteor'];
    place(20, 27);
    room.useItem(mover.id, 'lightning', other.id);
    expect(lastAttack(inbox)).toMatchObject({ absorbed: 0, damage: 20, shieldBroken: false });
    expect(arena().shield[other.id]).toBe(SHIELD_PER_ITEM);
    expect(arena().hp[other.id]).toBe(ARENA_HP - 20);
    s.turn += 1;
    place(20, 23);
    expect(() => room.useItem(mover.id, 'meteor', other.id)).toThrow(/jangkauan/);
    place(20, 45);
    room.useItem(mover.id, 'meteor', other.id);
    expect(lastAttack(inbox)).toMatchObject({ absorbed: 45, damage: 0 });
    room.destroy();
  });

  it('roket menyerang dari jauh; darah habis = kembali ke petak 1 dengan darah penuh', async () => {
    const { room, inbox, arena, state, mover, other, place } = await arenaRoom('ARN006');
    arena().bags[mover.id] = ['rocket'];
    place(20, 32);
    arena().shield[other.id] = 0;
    arena().hp[other.id] = 25;
    room.useItem(mover.id, 'rocket', other.id);
    expect(lastAttack(inbox)).toMatchObject({ kind: 'attack', outcome: 'hit', damage: 30, ko: other.id });
    expect(state().players.find((p) => p.id === other.id)!.position).toBe(1);
    expect(arena().hp[other.id]).toBe(ARENA_HP);
    room.destroy();
  });

  it('cermin memantulkan serangan ke penyerang (perisai penyerang ikut menyerap)', async () => {
    const { room, inbox, arena, mover, other, place } = await arenaRoom('ARN007');
    arena().bags[mover.id] = ['bomb'];
    arena().bags[other.id] = ['mirror'];
    place(12, 14);
    room.useItem(mover.id, 'bomb', other.id);
    expect(lastAttack(inbox)).toMatchObject({ outcome: 'reflected', victimId: mover.id, absorbed: 40, damage: 0 });
    expect(arena().bags[other.id]).toEqual([]);
    expect(arena().shield[mover.id]).toBe(SHIELD_PER_ITEM - 40);
    expect(arena().shield[other.id]).toBe(SHIELD_PER_ITEM);
    room.destroy();
  });

  it('pemain baru yang mengisi slot kosong mendapat modal arena', async () => {
    const [host, b, c] = await startGame(3);
    host.send({ t: 'kick', playerId: c.me });
    await c.wait('kicked');
    const d = await open();
    d.send({ t: 'join_room', code: host.room!.code, name: 'Dodi', character: 'kiko' });
    const joined = await d.wait('joined');
    const arena = await d.wait('arena');
    expect(arena.arena.bags[joined.you]).toHaveLength(1);
    expect(arena.arena.shield[joined.you]).toBe(SHIELD_PER_ITEM);
    expect(arena.arena.hp[joined.you]).toBe(ARENA_HP);
    expect(arena.arena.bags[c.me]).toBeUndefined();
    [host, b, c, d].forEach((x) => x.close());
  });
});

describe('opsi mode arena', () => {
  it('host bisa mematikan Mode Arena: tanpa darah & item, permainan biasa', async () => {
    const [host, b] = await makeRoom(2);
    expect(host.room!.settings.arena).toBe(true); // bawaan aktif
    b.send({ t: 'settings', arena: false });
    expect((await b.wait('error')).message).toMatch(/host/);
    host.send({ t: 'settings', arena: false });
    await new Promise((r) => setTimeout(r, 50));
    expect(b.room!.settings.arena).toBe(false);
    b.send({ t: 'ready', ready: true });
    await new Promise((r) => setTimeout(r, 50));
    host.send({ t: 'start_game' });
    await host.wait('game_start');
    const res = await host.wait('turn_result', 3000); // AFK = dilempar otomatis
    expect(res.pickup).toBeUndefined();
    expect(host.msgs.some((m) => m.t === 'arena' || m.t === 'arena_event')).toBe(false);
    const from = host.msgs.length;
    host.send({ t: 'use_item', item: 'potion' });
    expect((await host.wait('error', 2000, from)).message).toMatch(/Mode Arena/);
    [host, b].forEach((x) => x.close());
  });
});
