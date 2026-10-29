# Snake & Ladder 3D

Ular Tangga 3D berbasis web (Three.js + Vite + TypeScript). Spesifikasi lengkap: [snake-ladder-3d-spec.md](./snake-ladder-3d-spec.md).

**Mode:** Single Player vs Komputer (1–3 bot) dan **Multiplayer Online** (room dengan kode, 2–4 pemain,
server authoritative). Hot-seat (satu perangkat) belum ada.

## Perintah

```bash
npm install
npm run dev      # client saja (Vite); tambah ?speed=4 di URL untuk mempercepat animasi saat uji
npm run dev:all  # client + server multiplayer sekaligus (client bisa dibuka dari HP lewat IP LAN)
npm run server   # server multiplayer saja (port 3001, ubah dengan PORT=...)
npm start        # build client lalu server menyajikan client + soket di satu port (cocok untuk LAN/hosting)
npm run build    # tsc --noEmit && vite build
npm test         # Vitest — aturan permainan + integrasi server multiplayer (game 4 pemain penuh)
npm run lint
```

## Multiplayer online

- Menu **Main Online** → *Buat Room* (dapat kode 6 karakter + tombol salin kode/link `?room=KODE`) atau *Gabung* dengan kode.
- Room **2–4 pemain**: tiap pemain memilih karakter (tidak boleh kembar), non-host menekan *Siap*, host mengatur papan/aturan lalu *Mulai*.
- **Server authoritative** (`server/Room.ts`): RNG dadu & validasi giliran di server; client hanya mengirim `roll`. Lemparan "sempurna" dinilai server dari selisih waktu `charge_start` → `roll`. Client mereplikasi aturan dari hasil server dan mengikuti server bila berbeda.
- Giliran 25 dtk (+ waktu animasi) → auto-roll bila AFK. Pemain terputus dimainkan otomatis dan bisa masuk lagi (token di `localStorage`, juga setelah refresh) dan mendapat snapshot state; di lobby slot dilepas setelah 20 dtk. Room kosong dihapus setelah 60 dtk.
- **Sambung ulang:** tab tertutup/refresh/sinyal putus → client menyambung otomatis (backoff socket.io, juga saat jaringan kembali atau tab aktif lagi) dan masuk kembali dengan token sesi (`localStorage`, berlaku 30 menit sejak aktivitas terakhir), lalu mendapat snapshot state dan melanjutkan permainan. Selama terputus muncul lapisan "menyambung ulang" (dengan tombol sambungkan sekarang / keluar); pemain terputus punya masa tenggang 45 dtk dengan pewaktu giliran biasa sebelum giliran mereka dimainkan otomatis dengan cepat. Ping server 8 dtk agar pemutusan cepat terlihat oleh pemain lain.
- **Tab di latar belakang:** browser menghentikan animasi tab tersembunyi. Game online tetap berjalan di server; saat tab aktif lagi client meminta snapshot (`sync`) dan langsung melompat ke keadaan terkini. Game lawan komputer berhenti di tempat dan lanjut mulus (tidak lagi memunculkan menu jeda otomatis). Audio dihentikan saat tab tersembunyi.
- **Live / penonton:** menu *Tonton Live* atau lobby → daftar *Live sekarang* (room yang sedang bermain + jumlah penonton), tombol *Tonton sebagai penonton* dengan kode, atau link `?watch=KODE`. **Nama wajib diisi** untuk menonton (divalidasi juga di server). Penonton boleh masuk kapan saja (lobby/bermain/selesai), mendapat snapshot, tidak bisa melempar/mengubah room, punya token sambung ulang seperti pemain. Room bubar (semua pemain keluar) → penonton menerima `room_closed`.
- **Live chat** kiri bawah untuk pemain & penonton: riwayat 50 pesan di server, batas kirim (5 pesan / 5 dtk, jeda 0,4 dtk, kode `chat_rate`), jumlah & daftar penonton (pil LIVE), umpan kejadian permainan (tangga/ular/6). Bisa diciutkan jadi tombol dengan badge pesan belum dibaca.
- **Ekspresi + SFX** (kanan bawah, pintasan 1–8): tepuk tangan, tertawa, teriak, horee, wow, huuu, menangis, muah — SFX disintesis WebAudio. Ekspresi pemain tampil di atas pion **dan** di kartu pemain HUD; ekspresi penonton melayang di atas chat (SFX lebih pelan). Juga bisa dipakai saat lawan komputer.
- **Mode Arena** — opsi host di lobby *Mode Arena (Darah & Item di Papan)* (default **aktif**; dimatikan = permainan biasa). Tiap pemain punya ❤️ 100 darah, 🛡️ perisai 60, dan tas **3 slot**; modal awal **1 senjata serang acak** + perisai. Tidak ada koin & Shop. **12 item** acak (berbobot) tersebar di petak yang berjauhan (beda nomor ≥ 4 & jarak grid ≥ 2; bukan petak 1/100, tangga, ular, atau pion). Pion yang **berhenti** di petak ber-item mengambilnya bila tas belum penuh (tas penuh = item tetap di papan); item yang diambil muncul lagi **15 dtk** kemudian (item & petak acak), dan **seluruh item diacak ulang tiap 2 menit** (hitung mundur 🔀 di tas). Item dipakai = slotnya kosong. 12 senjata (jarak = selisih nomor petak; Start tidak bisa diserang): 🥊 Tinju 1 (−20), 🔨 Palu 1 (−35), 🔥 Semburan Api ≤2 (−30), 🧨 Dinamit ≤2 (−50), 💣 Bom ≤3 (−40), 🪃 Bumerang ≤4 (−25), ❄️ Bola Salju ≤5 (−15), 🏹 Panah ≤6 (−25), ⚡ Petir ≤8 (−20, tembus perisai), 🚀 Roket 2–12 (−30), dan **jarak bebas** (lawan di petak mana pun): 🛸 Sinar UFO (−25), ☄️ Meteor (−40). 🛡️ Perisai = meter daya tahan yang selalu aktif: menyerap **separuh** damage tiap serangan sampai habis — sisanya tetap mengurangi darah, jadi setiap serangan yang kena terasa; diisi ulang +60 (maks 100) dengan mengambil 🛡️ (tanpa slot tas). 🪞 Cermin memantulkan 1 serangan; 🍎 +20 / 🧪 +40 darah. Serangan 1× per lemparan, hanya pada giliran sendiri sebelum melempar. Darah habis → kembali ke **Start** dengan darah penuh. Efek (terlihat semua anggota room): kamera menyorot sasaran, proyektil per gaya serangan, hit-stop (slow-motion sesaat), ledakan + gelombang kejut, pion terpental & berputar, teks komik besar (POW!/BOOM!/KABOOM!/ZZZAP! + angka damage), gelembung/pecahan perisai, K.O. = pion melambung tinggi ke Start; kartu pemain bergetar merah dengan angka damage, darah/perisai di HUD baru turun saat serangan mengenai; kilat merah/biru + guncangan untuk yang terkena, kilat putih untuk serangan berat. SFX berlapis: teriakan penyerang, suara lepas & kena per senjata, stab dramatis, "Ooooh!" penonton, "aduh!". Tas di kolom kanan tepat di atas tombol ekspresi, detail item di tooltip slot. Semua di server (`server/Arena.ts`, aturan bersama `src/core/Arena.ts`; pesan `arena`, `arena_event`, `use_item`, `turn_result.pickup`). Duel di petak yang sama tetap berlaku.
- **Duel (Fight)** — opsi host di lobby *Duel di petak yang sama* (default mati). Pion yang berhenti di petak yang sudah ditempati pemain lain (setelah ular/tangga; Start tidak dihitung) memicu duel ala Ayo Dance di layar tiap petarung: hitung mundur 3-2-1-FIGHT, 6 ronde (4→8 panah). Tiap ronde ketik urutan panah (↑↓←→ / WASD / tombol layar; salah satu panah = ulang dari awal), lalu Spasi/HIT saat kursor ketukan di zona: PERFECT/GREAT/COOL/BAD, lewat zona / Spasi sebelum urutan lengkap = MISS (tanpa serangan, combo putus). Damage = (10 + 2×panah) × nilai × combo (+10%/ronde beruntun, maks +50%) ke semua lawan, HP 100. KO atau ronde habis → HP tertinggi menang (seri: damage terbanyak, lalu penghuni petak); yang kalah melompat kembali ke Start. Penilaian ketepatan dihitung client, HP/combo/pemenang/batas waktu ronde di server (`fight_start`/`fight_input`/`fight_hit`/`fight_end`); semua anggota room (pemain lain & penonton) menonton **live**: kartu tiap petarung menampilkan ketikan panahnya per ronde (`fight_progress`, disiarkan server, dibatasi) + HP/nilai/combo, pil LIVE berisi jumlah penonton, kamera 3D menuju petak duel dan pion bereaksi tiap serangan (👊/🔥/💥/💨). Penonton yang masuk di tengah duel langsung mendapat duel berjalan.
- **Kick** — hanya host: tombol *Keluarkan* (klik 2× untuk konfirmasi) di slot lobby dan di menu (Esc) saat bermain. Yang di-kick menerima `kicked` dan kembali ke layar buat/gabung room. Saat bermain, pion pemain yang di-kick **atau keluar** diangkat dari papan dan slotnya terbuka: pemain baru bisa gabung dengan kode / tombol *Gabung* di daftar Live dan mulai dari Start (urutan giliran paling akhir). Bila tinggal 1 pemain, permainan **menunggu** (giliran berhenti, HUD menampilkan kode) sampai ada yang bergabung — dulu permainan dibatalkan ke lobby.
- Timer giliran, penanda pemain terputus.
- Variabel: `PORT`, `CLIENT_ORIGIN` (CORS, pisahkan koma) di server; `VITE_SERVER_URL` di client bila server beda origin. Saat `npm run dev`, `/socket.io` di-proxy ke `localhost:3001`.
- Main bareng teman di jaringan yang sama: `npm run dev:all`, buka `http://<IP-PC>:5173` dari perangkat lain.

## Performa

Beban terbesar ada di GPU (resolusi/fill-rate, bloom, bayangan), bukan logika game (~0,25 ms/frame JS). Pixel ratio dibatasi 1,5; bloom setengah resolusi; bayangan 1024; MSAA kanvas dimatikan; efek partikel tidur saat tidak ada. Kualitas *Otomatis* memantau FPS: menurunkan resolusi lalu mematikan bloom/bayangan bila lambat (Pengaturan → Kualitas: Otomatis / Tinggi / Sedang / Rendah).

## Yang sudah ada

- Papan 3D 10×10 zig-zag, 4 preset (Mudah / Normal / Kacau / Acak tervalidasi), ular (tube meruncing + kepala beranimasi), tangga menyala berurutan, dadu 3D dengan hasil ditentukan dulu.
- 6 karakter prosedural (placeholder model GLB) dengan animasi idle / hop / climb / scared / cheer / sad, label nama, emote bot sesuai kepribadian.
- State machine giliran + EventBus; `Rules.ts` / `GameState.ts` bebas Three.js (aturan 6 = lempar lagi maks 3x, harus pas 100 dengan pantulan, opsi dimatikan lewat setup).
- Lempar dadu dengan **tahan & lepas**: bar tenaga terisi 1,8 dtk; lepas di zona hijau (≥ 88%) = lemparan sempurna (dua dadu, diambil yang terbesar: peluang angka 6 naik 16,7% → 30,6%). Menahan terlalu lama setelah penuh = tenaga hangus, lemparan biasa. Hanya untuk pemain; bot tetap lemparan biasa.
- Audio sintetis WebAudio (tanpa file aset): 4 musik 8-bar (menu/game/tension/victory, crossfade) dengan bass, drum, marimba, melodi ber-vibrato + echo/reverb; SFX langkah (marimba pentatonik naik tiap petak), tangga (arpeggio harpa + akor berkilau), ular (desis → gigit → slide whistle → trombon sedih), bar tenaga, dll; volume Master/Musik/SFX + mute tersimpan.
- Efek: confetti, kembang api, percikan, bloom ringan, screen shake, kamera mengikuti pion + cut sinematik, podium 3D juara.
- UI: loading, menu, setup + pratinjau 3D, HUD, pause, victory, pengaturan, cara main; ID/EN; kontras tinggi; kurangi gerakan; kualitas Low otomatis di perangkat lemah; save/resume per giliran.

## Penyimpangan dari spek

- Howler.js & cannon-es tidak dipakai: audio disintesis dengan WebAudio, dadu memakai opsi A (GSAP).
- Pemenang ditentukan saat pemain pertama tiba di 100; peringkat lain berdasar posisi saat itu (tidak lanjut main sampai semua selesai).
- Model GLB belum ada; karakter prosedural.
