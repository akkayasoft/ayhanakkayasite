# Ogrenci Takip Uygulamasi (Node.js + PostgreSQL)

Bu proje Hostinger Node.js ortaminda calisacak sekilde PostgreSQL ile gelistirildi.

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
- PostgreSQL (`pg`)
- Session tabanli kimlik dogrulama
- Temel guvenlik: `helmet`, `rate-limit`

## Kurulum
```bash
npm install
cp .env.example .env
npm start
```

## Ortam Degiskenleri
- `PORT`
- `SESSION_SECRET`
- `DEFAULT_ADMIN_USERNAME`
- `DEFAULT_ADMIN_PASSWORD`
- `NODE_ENV`
- `DATABASE_URL` (onerilen)
- `DATABASE_SSL`
- `DATABASE_SSL_REJECT_UNAUTHORIZED`

Uygulama acilisinda gerekli tablolari otomatik olusturur ve ilk admin kullanicisini seed eder.

## Varsayilan Admin
- Kullanici adi: `admin`
- Sifre: `admin123`

`.env` dosyasindan degistir.

## Canli Ortam ve Deploy
- Canli URL: https://takip.obs.akkayasoft.com/
- Sunucu: VPS, nginx (Ubuntu) reverse proxy arkasinda; systemd servisi `ayhanakkaya-site.service`
- Deploy OTOMATIK: `main`'e push et, sunucudaki systemd timer ~1 dakika icinde cekip
  yeniden baslatir. GitHub Actions kullanilmaz.
- Ayrintili akis, deploy script'i ve production env degiskenleri: `DEPLOY.md`
- Proje geneli ve gercek durum ozeti: `CLAUDE.md`

> Not: Repodaki eski `scripts/deploy-hostinger.sh`, `.env.deploy` ve
> `.github/workflows/deploy-hostinger.yml` kullanilmiyor; gecmisten kalmadir.

## GitHub Push
```bash
git remote add origin <REPO_URL>
git push -u origin main
```
