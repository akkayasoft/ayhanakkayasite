# CLAUDE.md

Bu dosya, bu depoda çalışan Claude Code (ve geliştiriciler) için projenin gerçek durumunu özetler.

## Proje

**Öğrenci Takip Sistemi** — admin (öğretmen/veli) öğrencilere görev atar, öğrenci tamamladığını işaretler; günlük soru çözüm/süre takibi, ödül/ceza puanı ve haftalık performans raporu vardır.

## Teknoloji

- Node.js + Express 5 + EJS (server-side render)
- PostgreSQL (`pg`)
- Oturum: `express-session` + `connect-pg-simple` (production'da PG store)
- Güvenlik: `helmet`, `express-rate-limit`, `bcryptjs`
- Excel export: `exceljs`

## Yapı

```
src/
  app.js      ~3550 satır — TÜM route'lar, iş mantığı, validasyon, view-model'ler (monolitik)
  db.js       şema + idempotent migration (açılışta otomatik) + admin seed
  views/      admin.ejs, student.ejs, login.ejs
  public/     styles.css
scripts/      deploy-hostinger.sh  (ARTIK KULLANILMIYOR — bkz. Deploy)
```

Roller: `admin`, `student`. Auth middleware `requireAuth` / `requireRole(role)`.

## Lokal Çalıştırma

```bash
brew services start postgresql@16        # port 5432
npm start                                 # http://localhost:3000
```

- `.env` mevcut (gitignore'lu): `DATABASE_URL=postgres://ayhanakkaya@localhost:5432/ogrenci_takip`, `NODE_ENV=development`, `PORT=3000`.
- Açılışta tablolar otomatik kurulur ve admin seed edilir.
- Varsayılan admin: `admin` / `admin123` (production'da değiştirilmeli).

## Deploy (GERÇEK durum)

> ⚠️ Repo içindeki eski "Hostinger" dokümanları (`scripts/deploy-hostinger.sh`, eski README/DEPLOY metinleri) gerçeği yansıtmaz.

- **Canlı URL:** https://takip.obs.akkayasoft.com/
- **Ortam:** kendi VPS'i, **nginx/1.24 (Ubuntu)** reverse proxy arkasında.
- **Deploy yöntemi:** manuel (SSH üzerinden; muhtemelen `git pull` + pm2/systemd restart). GitHub Actions ile otomatik deploy YOKTUR — `.github/workflows/deploy-hostinger.yml` no-op'tur.
- **Repodaki değişiklikler**, biri sunucuda manuel deploy yapana kadar canlıya gitmez.

Canlı durumu doğrularken repoya değil, doğrudan URL'e istek at.

## Çalışırken dikkat

- Canlı sistem; davranış değiştiren PR'larda önce lokalde doğrula.
- Test yok; `npm test` placeholder (hata döndürür).
- `app.js` tek dosya — değişiklik yaparken çevredeki idiom ve yardımcı fonksiyonları (`asyncHandler`, `makeId`, `normalizeText`, validasyonlar) kullan.
