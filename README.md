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

## Hostinger Node.js + PostgreSQL Deploy
1. Projeyi GitHub'a push et.
2. Hostinger panelinde Node.js app olustur.
3. Start file: `src/app.js`
4. Install command: `npm install`
5. Start command: `npm start`
6. PostgreSQL veritabani olustur (Hostinger Managed PostgreSQL veya harici).
7. Environment Variables'a `DATABASE_URL` ve diger `.env` degerlerini gir.
8. SSL zorunluysa:
   - `DATABASE_SSL=true`
   - Gecici olarak gerekiyorsa `DATABASE_SSL_REJECT_UNAUTHORIZED=false`
9. Deploy ve restart et.

### Tek Komut Deploy (Kalici Ayar)
- Ayrintili dokuman: `DEPLOY.md`
- Bir kere ayarla:
  - `cp .env.production.example .env.deploy`
  - `.env.deploy` icinde Hostinger SSH/deploy alanlarini doldur
- Sonra deploy:
  - `npm run deploy:prod`
- Sadece kontrol:
  - `npm run deploy:prod:dry`

### Otomatik Deploy (main push)
- Workflow: `.github/workflows/deploy-hostinger.yml`
- `main` branch'ine her push sonrasi Hostinger deploy tetiklenir.
- Gerekli GitHub secrets listesi `DEPLOY.md` icinde.

## GitHub Push
```bash
git remote add origin <REPO_URL>
git push -u origin main
```
