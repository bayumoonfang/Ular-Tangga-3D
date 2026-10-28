import { randomBytes } from 'node:crypto';
import type { Socket } from 'socket.io';
import {
  NAME_MAX,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  type ClientMsg,
  type LiveRoom,
  type Role,
  type ServerMsg,
} from '../src/network/protocol';
import { Room, RoomError } from './Room';

interface Binding {
  room: Room;
  /** id pemain atau penonton */
  playerId: string;
  role: Role;
}

/** pesan yang hanya boleh dikirim pemain (penonton cuma menonton, chat & berekspresi) */
const PLAYER_ONLY = new Set<ClientMsg['t']>(['set_character', 'ready', 'settings', 'start_game', 'charge_start', 'roll', 'back_to_lobby', 'kick', 'fight_input', 'fight_progress']);

/** Menghubungkan socket ke room/pemain dan meneruskan pesan client ke Room. */
export class RoomManager {
  private rooms = new Map<string, Room>();
  private bindings = new Map<string, Binding>();
  private sockets = new Map<string, Socket>();

  private sendTo = (socketId: string, msg: ServerMsg): void => {
    this.sockets.get(socketId)?.emit('msg', msg);
  };

  attach(socket: Socket): void {
    this.sockets.set(socket.id, socket);
    socket.on('msg', (raw: unknown) => {
      try {
        this.handle(socket, raw as ClientMsg);
      } catch (e) {
        if (e instanceof RoomError) this.sendTo(socket.id, { t: 'error', message: e.message, code: e.code });
        else {
          console.error('[server] error', e);
          this.sendTo(socket.id, { t: 'error', message: 'Terjadi kesalahan di server.' });
        }
      }
    });
    socket.on('disconnect', () => {
      const b = this.bindings.get(socket.id);
      this.bindings.delete(socket.id);
      this.sockets.delete(socket.id);
      if (!b) return;
      if (b.role === 'spectator') b.room.disconnectSpectator(b.playerId);
      else b.room.disconnect(b.playerId);
    });
  }

  roomCount(): number {
    return this.rooms.size;
  }

  /** Room yang sedang bermain, paling ramai penontonnya lebih dulu. */
  liveRooms(): LiveRoom[] {
    const list: LiveRoom[] = [];
    for (const room of this.rooms.values()) {
      const info = room.liveInfo();
      if (info) list.push(info);
    }
    return list.sort((a, b) => b.viewers - a.viewers).slice(0, 20);
  }

  private newCode(): string {
    for (;;) {
      const bytes = randomBytes(ROOM_CODE_LENGTH);
      let code = '';
      for (const b of bytes) code += ROOM_CODE_ALPHABET[b % ROOM_CODE_ALPHABET.length];
      if (!this.rooms.has(code)) return code;
    }
  }

  private normalizeCode(code: unknown): string {
    return String(code ?? '')
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '')
      .slice(0, ROOM_CODE_LENGTH);
  }

  private createRoom(): Room {
    const code = this.newCode();
    const room: Room = new Room(code, this.sendTo, () => {
      this.rooms.delete(code);
      // sambungan yang masih terikat (penonton) dilepas dari room yang bubar
      for (const [sid, b] of this.bindings) if (b.room === room) this.bindings.delete(sid);
    });
    this.rooms.set(code, room);
    return room;
  }

  private bind(socket: Socket, room: Room, playerId: string, role: Role): void {
    this.bindings.set(socket.id, { room, playerId, role });
  }

  private leave(socket: Socket): void {
    const b = this.bindings.get(socket.id);
    if (!b) return;
    this.bindings.delete(socket.id);
    if (b.role === 'spectator') b.room.removeSpectator(b.playerId);
    else b.room.remove(b.playerId);
    this.sendTo(socket.id, { t: 'left' });
  }

  private handle(socket: Socket, msg: ClientMsg): void {
    if (!msg || typeof msg !== 'object') return;
    const bound = this.bindings.get(socket.id);

    switch (msg.t) {
      case 'create_room': {
        if (bound) this.leave(socket);
        const room = this.createRoom();
        const p = room.add(socket.id, String(msg.name ?? '').slice(0, NAME_MAX), String(msg.character));
        this.bind(socket, room, p.id, 'player');
        this.sendTo(socket.id, { t: 'joined', room: room.info(), you: p.id, token: p.token, role: 'player', name: p.name });
        room.sendChatHistory(p);
        return;
      }
      case 'join_room': {
        const room = this.rooms.get(this.normalizeCode(msg.code));
        if (!room) throw new RoomError('Room tidak ditemukan. Periksa kodenya.');
        if (bound) this.leave(socket);
        const p = room.add(socket.id, String(msg.name ?? '').slice(0, NAME_MAX), String(msg.character));
        this.bind(socket, room, p.id, 'player');
        this.sendTo(socket.id, { t: 'joined', room: room.info(), you: p.id, token: p.token, role: 'player', name: p.name });
        room.sendChatHistory(p);
        room.admitted(p); // di tengah permainan: semua anggota mendapat snapshot dengan pion baru
        return;
      }
      case 'spectate': {
        const room = this.rooms.get(this.normalizeCode(msg.code));
        if (!room) throw new RoomError('Room tidak ditemukan. Periksa kodenya.');
        if (bound) this.leave(socket);
        const s = room.addSpectator(socket.id, String(msg.name ?? ''));
        this.bind(socket, room, s.id, 'spectator');
        this.sendTo(socket.id, { t: 'joined', room: room.info(), you: s.id, token: s.token, role: 'spectator', name: s.name });
        room.sendChatHistory(s);
        room.announceSpectator(s);
        room.resync(s);
        return;
      }
      case 'list_live':
        this.sendTo(socket.id, { t: 'live_list', rooms: this.liveRooms() });
        return;
      case 'rejoin': {
        const room = this.rooms.get(this.normalizeCode(msg.code));
        const player = room?.players.find((p) => p.token === msg.token);
        const viewer = player ? undefined : room?.spectators.find((s) => s.token === msg.token);
        if (!room || (!player && !viewer)) {
          this.sendTo(socket.id, { t: 'error', code: 'rejoin_failed', message: 'Sesi room sudah berakhir.' });
          return;
        }
        if (player) {
          // sambungan lama (tab lain) digantikan
          if (player.socketId && player.socketId !== socket.id) this.bindings.delete(player.socketId);
          room.reconnect(player.id, socket.id);
          this.bind(socket, room, player.id, 'player');
          this.sendTo(socket.id, { t: 'joined', room: room.info(), you: player.id, token: player.token, role: 'player', name: player.name });
          room.sendChatHistory(player);
          room.resync(player);
        } else if (viewer) {
          if (viewer.socketId && viewer.socketId !== socket.id) this.bindings.delete(viewer.socketId);
          room.reconnectSpectator(viewer.id, socket.id);
          this.bind(socket, room, viewer.id, 'spectator');
          this.sendTo(socket.id, { t: 'joined', room: room.info(), you: viewer.id, token: viewer.token, role: 'spectator', name: viewer.name });
          room.sendChatHistory(viewer);
          room.resync(viewer);
        }
        return;
      }
      default:
        break;
    }

    if (!bound) throw new RoomError('Kamu belum berada di sebuah room.');
    const { room, playerId, role } = bound;
    if (role === 'spectator' && PLAYER_ONLY.has(msg.t)) throw new RoomError('Penonton hanya bisa menonton, chat, dan berekspresi.');
    switch (msg.t) {
      case 'set_character':
        room.setCharacter(playerId, String(msg.character));
        break;
      case 'ready':
        room.setReady(playerId, !!msg.ready);
        break;
      case 'settings':
        room.updateSettings(playerId, msg.boardPreset, msg.options, msg.fight);
        break;
      case 'start_game':
        room.start(playerId);
        break;
      case 'charge_start':
        room.noteChargeStart(playerId);
        break;
      case 'roll':
        room.handleRoll(playerId);
        break;
      case 'emote':
        room.emote(playerId, String(msg.id));
        break;
      case 'chat':
        room.chat(playerId, String(msg.text ?? ''));
        break;
      case 'sync': {
        const me = role === 'spectator' ? room.spectator(playerId) : room.player(playerId);
        if (me) room.resync(me);
        break;
      }
      case 'kick': {
        const sid = room.kick(playerId, String(msg.playerId));
        if (sid) this.bindings.delete(sid);
        break;
      }
      case 'fight_progress':
        room.fightProgress(playerId, Number(msg.id), Number(msg.round), Number(msg.typed), !!msg.wrong);
        break;
      case 'fight_input':
        room.fightInput(playerId, Number(msg.id), Number(msg.round), String(msg.grade));
        break;
      case 'back_to_lobby':
        room.backToLobby();
        break;
      case 'leave':
        this.leave(socket);
        break;
    }
  }
}
