# Ogrenci Takip Uygulamasi (Node.js)

Bu proje, Hostinger'da Node.js olarak yayinlanabilecek ogrenci takip uygulamasidir.

## Ozellikler
- Admin ve ogrenci panelleri
- Ogrenci ekleme
- Manuel kategori tanimlama
- Gorev atama (tek seferlik, haftalik, aylik, ozel tarih)
- Gorevleri yapildi/yapilmadi olarak isaretleme
- Gunluk soru cozum adedi girisi
- Odul/ceza puan sistemi
- Admin gunluk durum panosu
- Ogrenci bazli tarih aralikli performans raporu
- Gorev arsivleme / yeniden aktif etme

## Teknoloji
- Node.js + Express + EJS
- Session tabanli kimlik dogrulama
- JSON dosya tabanli veri saklama (`src/data/db.json`)

## Kurulum
```bash
npm install
cp .env.example .env
npm start
```

Uygulama varsayilan olarak `http://localhost:3000` adresinde calisir.

## Varsayilan Admin
Ilk calistirmada otomatik olusur:
- Kullanici adi: `admin`
- Sifre: `admin123`

`.env` icinden degistirebilirsin.

## Ortam Degiskenleri
- `PORT=3000`
- `SESSION_SECRET=burayi-uzun-guclu-secret-yap`
- `DEFAULT_ADMIN_USERNAME=admin`
- `DEFAULT_ADMIN_PASSWORD=admin123`
- `NODE_ENV=production`

## Hostinger Node.js Deploy (GitHub baglantili)
1. Projeyi GitHub repository'sine push et.
2. Hostinger panelinde `Websites > Manage > Node.js` bolumune gir.
3. Node surumunu `18+` sec.
4. Repository baglantisini yap.
5. Start file olarak `src/app.js` belirle.
6. Environment Variables alanina yukaridaki degerleri gir.
7. Install command: `npm install`
8. Start command: `npm start`
9. Deploy sonrasi restart et.

## Notlar
- Bu surumde veri `src/data/db.json` dosyasinda saklanir.
- Uretim ortami icin bu dosyanin yedegini periyodik al.
- Buyuk olcek icin PostgreSQL/MySQL'e gecis tavsiye edilir.
