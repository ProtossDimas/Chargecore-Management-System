# NEXUS/OPS — Logistics & Asset Management System

Sistem web untuk mengelola aset EV Charger & Battery Swap Station (BSS), maintenance, warehouse, inventory, dan logistik dalam satu control center. Tema visual futuristik senada dengan logo perusahaan (hijau elektrik di atas dasar gelap).

Live Map, dashboard, dan seluruh data ditenagai oleh **Google Sheets** sebagai database, diakses lewat **Cloudflare Pages Functions**. Tidak perlu database server terpisah.

## Struktur File

```
.
├── index.html                  Seluruh frontend (UI + CSS + JS dalam satu file)
├── functions/
│   └── [[catchall]].js         Backend API — Cloudflare Pages Function
└── README.md                   Dokumen ini
```

Ini pola dua-file standar: `index.html` untuk semua yang dilihat browser, `functions/[[catchall]].js` untuk semua yang butuh rahasia (kredensial Google, dsb) — Cloudflare Pages otomatis menjalankan file di folder `functions/` sebagai serverless API tanpa konfigurasi tambahan.

Repo ini **tidak berisi file Excel/database** — datanya hidup langsung di Google Sheets, dan koneksi ke sana diatur lewat environment variable di Cloudflare (lihat langkah deploy di bawah). File `NEXUS-OPS-database.xlsx` yang sebelumnya dibuatkan hanya untuk Anda upload/isi langsung di Google Sheets, tidak perlu ikut di-push ke GitHub.

### `index.html`
- Sidebar navigasi + 8 halaman (Dashboard, Live Map, Assets, Work Orders, Incidents, Inventory, Shipment Tracking, Reports, Settings) dalam satu single-page app (tidak reload).
- Memanggil endpoint `/api/*` untuk semua data. Kalau endpoint belum aktif, otomatis pakai data contoh (badge "PREVIEW" di kanan atas) supaya tetap bisa dilihat sebelum Sheets tersambung.
- Live Map beralih otomatis: peta CSS pratinjau → Google Maps asli (gaya gelap kustom) begitu `GOOGLE_MAPS_API_KEY` terdeteksi.

### `functions/[[catchall]].js`
Menangani semua request ke `/api/...`:

| Endpoint | Method | Fungsi |
|---|---|---|
| `/api/config` | GET | Kirim `GOOGLE_MAPS_API_KEY` ke frontend |
| `/api/assets` | GET, POST, PUT | Data EV Charger & BSS |
| `/api/locations` | GET | Data warehouse & lokasi |
| `/api/workorders` | GET, POST, PUT | Maintenance work order |
| `/api/incidents` | GET, POST, PUT | Laporan insiden |
| `/api/inventory` | GET, POST, PUT | Stok spare part per gudang |
| `/api/shipments` | GET, POST, PUT | Pelacakan pengiriman |

Autentikasi ke Google memakai **Service Account** — JWT ditandatangani langsung dengan Web Crypto API (tidak ada dependency `npm install`), lalu ditukar ke access token OAuth2 untuk memanggil Google Sheets API v4. Data tidak pernah disimpan di repo — hanya diambil real-time dari Sheet lewat kredensial di environment variable.

## Cara Deploy

### 1. Isi Google Sheet
1. Buka Google Sheets, buat spreadsheet baru — bisa lewat **File → Import** file `NEXUS-OPS-database.xlsx` yang sudah dibuatkan (pilih "Insert new sheet(s)" saat import), atau isi manual mengikuti struktur tab & kolom yang sama.
2. Ganti baris kuning (contoh data) di tiap tab dengan data asli. Jangan ubah nama tab atau nama kolom.
3. Catat **Sheet ID** dari URL: `https://docs.google.com/spreadsheets/d/SHEET_ID_DI_SINI/edit`.

### 2. Buat Service Account (akses Sheets API)
1. Buka [Google Cloud Console](https://console.cloud.google.com) → buat/pilih project.
2. Aktifkan **Google Sheets API** (APIs & Services → Library).
3. Buat **Service Account** (IAM & Admin → Service Accounts → Create).
4. Buat key baru tipe **JSON**, download.
5. Dari file JSON, catat `client_email` dan `private_key`.
6. Buka Google Sheet Anda → **Share** → tambahkan `client_email` tadi sebagai **Editor**.

### 3. Buat Google Maps API Key
1. Di project Cloud Console yang sama, aktifkan **Maps JavaScript API**.
2. Buat API key (Credentials → Create Credentials → API key).
3. Batasi key ke **HTTP referrer** domain Cloudflare Pages Anda nanti (mis. `https://nexus-ops.pages.dev/*`).

### 4. Push ke GitHub
```bash
git init
git add .
git commit -m "Initial commit: NEXUS/OPS"
git remote add origin https://github.com/<username>/<repo>.git
git push -u origin main
```

### 5. Sambungkan ke Cloudflare Pages
1. Cloudflare dashboard → **Workers & Pages → Create → Pages → Connect to Git** → pilih repo ini.
2. Build settings: **kosongkan** build command, output directory `/` (root) — tidak ada proses build, ini file statis + Functions.
3. Deploy dulu (akan jalan dengan data contoh/PREVIEW).
4. Buka **Settings → Environment variables**, tambahkan untuk **Production** dan **Preview**:

| Variable | Isi |
|---|---|
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | `client_email` dari file JSON service account |
| `GOOGLE_PRIVATE_KEY` | `private_key` dari file JSON, paste apa adanya termasuk `-----BEGIN PRIVATE KEY-----` |
| `GOOGLE_SHEET_ID` | Sheet ID dari langkah 1 |
| `GOOGLE_MAPS_API_KEY` | API key dari langkah 3 |

5. Redeploy. Badge di kanan atas berubah dari "PREVIEW — data contoh" jadi "LIVE — Google Sheets", dan Live Map otomatis pakai Google Maps asli.

## Catatan
- Status/severity di Sheet bebas diisi bahasa apa saja — sistem mendeteksi kata kunci (`off`→merah, `warn`/`menipis`→oranye, `maint`→abu-abu, selain itu→hijau).
- `latitude`/`longitude` wajib angka desimal agar marker muncul di peta.
- Endpoint POST/PUT di backend sudah siap dipakai; tombol "+ Tambah Aset" dkk di UI saat ini masih placeholder dan belum terhubung — beri tahu saya kalau mau dilanjutkan.
- Untuk fase berikutnya sesuai blueprint (Preventive/Corrective Maintenance detail, Proof of Delivery upload, GPS tracking) bisa ditambahkan bertahap mengikuti roadmap Phase 2–5 di dokumen blueprint awal.
