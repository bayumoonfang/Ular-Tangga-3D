import { io, type Socket } from 'socket.io-client';
import type { ChatMsg, ClientMsg, Role, RoomInfo, ServerMsg } from './protocol';

export type NetStatus = 'idle' | 'connecting' | 'connected' | 'disconnected';

type MsgOf<T extends ServerMsg['t']> = Extract<ServerMsg, { t: T }>;
type Handler<T extends ServerMsg['t']> = (msg: MsgOf<T>) => void;

const SESSION_KEY = 'sl3d.session';
/** sesi room yang lebih tua dari ini tidak dicoba lagi (room di server pasti sudah bubar) */
const SESSION_MAX_AGE_MS = 30 * 60 * 1000;

interface Session {
  code: string;
  token: string;
  /** terakhir kali sesi ini dipakai (ms) */
  at: number;
}

/** Pembungkus Socket.IO: koneksi, sambung ulang otomatis (rejoin), dan penyiar pesan bertipe. */
export class NetworkClient {
  status: NetStatus = 'idle';
  room: RoomInfo | null = null;
  myId = '';
  myName = '';
  /** peran di room saat ini: pemain atau penonton */
  role: Role | null = null;
  /** pesan chat room saat ini (riwayat dari server + pesan baru) */
  chat: ChatMsg[] = [];
  /** nomor percobaan sambung ulang saat ini (0 = tersambung) */
  attempts = 0;

  private socket: Socket | null = null;
  private handlers = new Map<string, Set<(msg: ServerMsg) => void>>();
  private statusListeners = new Set<(s: NetStatus) => void>();
  private session: Session | null = null;

  constructor() {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      const s = raw ? (JSON.parse(raw) as Session) : null;
      if (s && Date.now() - (s.at ?? 0) < SESSION_MAX_AGE_MS) this.session = s;
      else if (s) localStorage.removeItem(SESSION_KEY);
    } catch {
      /* abaikan */
    }
    // jaringan kembali / tab aktif lagi: jangan menunggu jeda backoff socket.io
    window.addEventListener('online', () => this.ensureConnected());
  }

  /** Sambungkan segera bila terputus (dipanggil saat tab aktif lagi atau jaringan kembali). */
  ensureConnected(): void {
    if (this.socket && !this.socket.connected) this.socket.connect();
  }

  /** Minta snapshot state terbaru dari server (mengejar ketertinggalan setelah tab di latar belakang). */
  sync(): void {
    if (this.room) this.send({ t: 'sync' });
  }

  get hasSession(): boolean {
    return this.session !== null;
  }

  get inRoom(): boolean {
    return this.room !== null;
  }

  get isHost(): boolean {
    return !!this.room && this.room.hostId === this.myId;
  }

  get isSpectator(): boolean {
    return !!this.room && this.role === 'spectator';
  }

  onStatus(fn: (s: NetStatus) => void): () => void {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  }

  on<T extends ServerMsg['t']>(type: T, fn: Handler<T>): () => void {
    let set = this.handlers.get(type);
    if (!set) this.handlers.set(type, (set = new Set()));
    const h = fn as (msg: ServerMsg) => void;
    set.add(h);
    return () => set.delete(h);
  }

  private setStatus(s: NetStatus): void {
    this.status = s;
    this.statusListeners.forEach((fn) => fn(s));
  }

  /** Buka koneksi (sekali). Bila ada sesi room tersimpan, otomatis mencoba masuk kembali. */
  connect(): void {
    if (this.socket) {
      if (!this.socket.connected) this.socket.connect();
      return;
    }
    this.setStatus('connecting');
    const url = import.meta.env.VITE_SERVER_URL as string | undefined;
    const socket = url ? io(url) : io();
    this.socket = socket;

    socket.io.on('reconnect_attempt', (n: number) => {
      this.attempts = n;
      this.setStatus('connecting');
    });
    socket.on('connect', () => {
      this.attempts = 0;
      this.setStatus('connected');
      if (this.session) this.send({ t: 'rejoin', code: this.session.code, token: this.session.token });
    });
    socket.on('disconnect', (reason) => {
      this.setStatus('disconnected');
      // diputus oleh server (mis. tab lain mengambil sesi) tidak otomatis menyambung ulang
      if (reason === 'io server disconnect') socket.connect();
    });
    socket.on('connect_error', () => this.setStatus('disconnected'));
    socket.on('msg', (msg: ServerMsg) => this.receive(msg));
  }

  private receive(msg: ServerMsg): void {
    switch (msg.t) {
      case 'joined':
        this.room = msg.room;
        this.myId = msg.you;
        this.myName = msg.name;
        this.role = msg.role;
        this.chat = [];
        this.saveSession({ code: msg.room.code, token: msg.token, at: Date.now() });
        break;
      case 'room_state':
        this.room = msg.room;
        break;
      case 'chat_history':
        this.chat = msg.msgs.slice();
        break;
      case 'chat':
        this.chat.push(msg.msg);
        if (this.chat.length > 100) this.chat.shift();
        break;
      case 'turn':
        if (this.session) this.saveSession({ ...this.session, at: Date.now() }); // sesi tetap segar selama bermain
        break;
      case 'left':
      case 'kicked':
        this.clearRoom();
        break;
      case 'error':
        if (msg.code === 'rejoin_failed' || msg.code === 'room_closed') this.clearRoom();
        break;
      default:
        break;
    }
    this.handlers.get(msg.t)?.forEach((fn) => fn(msg));
  }

  private saveSession(s: Session | null): void {
    this.session = s;
    try {
      if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
      else localStorage.removeItem(SESSION_KEY);
    } catch {
      /* abaikan */
    }
  }

  send(msg: ClientMsg): void {
    this.socket?.emit('msg', msg);
  }

  /** Keluar dari room (sesi dihapus). Koneksi tetap terbuka untuk membuat/gabung room lain. */
  leave(): void {
    if (this.room) this.send({ t: 'leave' });
    this.clearRoom();
  }

  private clearRoom(): void {
    this.room = null;
    this.myId = '';
    this.role = null;
    this.chat = [];
    this.saveSession(null);
  }
}
