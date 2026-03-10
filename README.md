# Turnitin Web Automation

MVP web lokal untuk:

- membaca pool akun dari file `akun turnitin`
- login otomatis ke Turnitin
- scan kelas dan assignment yang masih bisa dipakai
- submit satu atau banyak file dari UI lokal
- submit file dari bot Telegram
- menunggu similarity score
- menyimpan artefak hasil yang bisa diunduh dari web ini

Implementasi ini tidak mencoba meng-embed dashboard Turnitin asli ke browser user. User mengunggah file dari web ini, lalu backend Playwright yang menjalankan alur Turnitin di belakang layar.

## Jalankan

```bash
npm install
npm start
```

Lalu buka `http://127.0.0.1:3000`.

## Install Otomatis di VPS Ubuntu

Kalau repo ini sudah ada di VPS, cukup jalankan:

```bash
sudo bash scripts/install-ubuntu-vps.sh
```

## Install Sekali Perintah di VPS Ubuntu

Kalau mau benar-benar satu perintah dari VPS baru, pakai bootstrap script ini. Script akan:

- install `git` jika belum ada
- clone atau update repo ke VPS
- menjalankan installer utama
- membuat service `systemd`

Contoh pakai langsung dari repo raw:

```bash
curl -fsSL -o /tmp/turnitin-bootstrap.sh https://raw.githubusercontent.com/USER/REPO/main/scripts/bootstrap-ubuntu-vps.sh && \
sudo REPO_URL="https://github.com/USER/REPO.git" REPO_BRANCH="main" bash /tmp/turnitin-bootstrap.sh
```

Kalau mau ganti lokasi install:

```bash
curl -fsSL -o /tmp/turnitin-bootstrap.sh https://raw.githubusercontent.com/USER/REPO/main/scripts/bootstrap-ubuntu-vps.sh && \
sudo REPO_URL="https://github.com/USER/REPO.git" REPO_BRANCH="main" APP_DIR="/opt/plagiasimu-bot" SERVICE_NAME="plagiasimu-bot" bash /tmp/turnitin-bootstrap.sh
```

Setelah bootstrap selesai, edit env di VPS:

```bash
sudo nano /opt/turnitin-pool/.env
```

Lalu isi token Telegram, `chat_id`, kredensial panel, dan config Pakasir, kemudian restart:

```bash
sudo systemctl restart turnitin-pool
```

Default hasil install VPS:

- bind publik di `0.0.0.0:3101`
- panel bisa diakses via `http://IP_VPS:3101`
- jika `ufw` tersedia, port `3101/tcp` akan dibuka otomatis
- login admin default: `Andri14 / Andri14`
- login admin default: `Andri14 / Andri14`

Yang dikerjakan script ini:

- install package sistem dasar
- install Node.js 20
- install `poppler-utils`
- install dependency npm
- install dependency sistem Playwright + Chromium
- buat `.env` jika belum ada
- buat file akun default `akun-turnitin.txt`
- buat dan enable service `systemd`
- jalankan web app otomatis saat boot

File penting setelah install:

- env service: `.env`
- akun Turnitin: `akun-turnitin.txt`
- service: `turnitin-pool`

Kalau mau ganti login admin:

```bash
PANEL_AUTH_USERNAME="Andri14"
PANEL_AUTH_PASSWORD="Andri14"
```
- login panel: `Andri14 / Andri14`

Cek sesudah install:

```bash
systemctl status turnitin-pool --no-pager
journalctl -u turnitin-pool -f
curl -s http://127.0.0.1:3101/api/auth/session
```

Akses publiknya:

```bash
http://IP_VPS:3101
```

Kalau mau ganti nama user/service/path saat install:

```bash
sudo APP_USER=turnitin APP_DIR=/opt/turnitin-pool SERVICE_NAME=turnitin-pool \
  bash scripts/install-ubuntu-vps.sh
```

## Bot Telegram

Bot Telegram berjalan di proses yang sama dengan web app dan memakai long polling ke Bot API Telegram. Jika token tidak diisi, mode bot tidak aktif.

Set env yang dibutuhkan:

```bash
export TELEGRAM_BOT_TOKEN="123456:ABCDEF"
export TELEGRAM_ALLOWED_CHAT_IDS="123456789,987654321"
export TELEGRAM_RESTRICT_GENERAL_ACCESS="false"
export TURNITIN_MAX_ATTEMPTS_PER_ASSIGNMENT="2"
export TURNITIN_MAX_SUBMISSIONS_PER_ASSIGNMENT="2"
npm start
```

Catatan:

- `TELEGRAM_ADMIN_CHAT_IDS` hanya membatasi command admin.
- Bot umum tetap terbuka untuk user lain jika `TELEGRAM_RESTRICT_GENERAL_ACCESS=false`.
- Kalau ingin bot hanya bisa dipakai chat tertentu, aktifkan `TELEGRAM_RESTRICT_GENERAL_ACCESS=true`.

Kalau dijalankan lewat `systemd`, isi token dan chat id di `.env`, lalu restart:

```bash
sudo systemctl restart turnitin-pool
```

Perilaku bot:

- kirim file sebagai `document` ke bot
- caption baris pertama dipakai sebagai judul submission jika ada
- jika tanpa caption, bot akan tanya judul custom secara opsional lalu auto-lanjut dengan nama file default jika timeout
- bot membuat job baru di queue yang sama dengan web UI
- bot melakukan polling status berkala, menampilkan ETA kasar, dan merapikan log supaya info sensitif tidak ikut tampil
- saat hasil selesai, bot mengirim artefak seperti `similarity-report.pdf` dan `digital-receipt.pdf` jika tersedia, lalu mencoba menyematkan status hasil

Perintah bot:

- `/start` atau `/help` menampilkan cara pakai
- `/status` menampilkan ringkasan job terbaru dari chat itu
- `/skip` lanjut pakai nama file default saat bot sedang menunggu judul
- `/cancel` batalkan draft upload yang belum masuk queue

## Stress Test

Sebelum dipindah ke VPS, jalankan burn-in queue lokal supaya kelihatan apakah job benar-benar berpindah dari `queued` ke `running`, lalu selesai tanpa macet:

```bash
npm run stress -- \
  --serial \
  --title-prefix "Queue Burn-In" \
  --exclude-quotes \
  --exclude-bibliography \
  ./samples/a.pdf ./samples/b.pdf
```

Kalau cuma punya satu file contoh, Anda bisa ulang file yang sama:

```bash
npm run stress -- \
  --serial \
  --repeat 7 \
  --title-prefix "Queue Burn-In" \
  ./samples/a.pdf
```

Script ini akan:

- submit job ke `POST /api/jobs`
- polling `GET /api/health` dan `GET /api/jobs/:id`
- menulis ringkasan hasil ke `storage/runtime/stress-test-*.json`
- `--serial` akan menunggu 1 job selesai dulu sebelum submit berikutnya

## Format akun

File akun default ada di:

```text
/home/andri14/Documents/web turnitin/akun turnitin
```

Format tiap baris:

```text
email@example.com | password
```

## Endpoint utama

- `GET /api/accounts` lihat cache ringkasan akun
- `GET /api/accounts?refresh=1` scan ulang semua akun
- `POST /api/jobs` upload satu atau banyak file untuk dicek
- `GET /api/jobs/:id` cek progres job

## Catatan penting

- Default local dev masih aman di `127.0.0.1`, tetapi installer VPS sekarang membuka panel di `0.0.0.0:3101`.
- Karena panel dibuka publik via IP VPS, minimal pasang firewall/cloud security rule yang hanya membuka port yang memang dipakai, dan idealnya tambah autentikasi di depan panel.
- `GET /api/jobs` masih cache in-memory. Restart proses akan menghilangkan daftar job aktif yang belum selesai, jadi untuk deployment VPS gunakan process manager dan hindari restart saat queue berjalan.
- UI Turnitin bisa berubah sewaktu-waktu. Jika selector berbeda di akun Anda, titik tuning utamanya ada di [src/services/turnitin-automation.js](/home/andri14/Documents/web turnitin/src/services/turnitin-automation.js).
- Artefak hasil disimpan di `storage/reports/<jobId>/`.
- Default lokal sekarang membatasi retry assignment `2x` dan pemakaian sukses per assignment `2x` sebelum otomatis dilewati.
- UI web mendukung batch upload banyak file sekaligus tanpa batas jumlah file per request dari aplikasi ini. Jika field judul diisi saat batch upload, sistem akan menambahkan suffix nomor otomatis ke tiap job, dan job yang belum kebagian slot akun akan tetap masuk antrian.
