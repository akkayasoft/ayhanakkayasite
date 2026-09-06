# CLAUDE.md

Bu dosya, bu depoda çalışan Claude Code (ve geliştiriciler) için projenin gerçek durumunu özetler.

## Proje

**Öğrenci Takip Sistemi** — admin (öğretmen/veli) öğrencilere görev atar, öğrenci tamamladığını işaretler; günlük soru çözüm/süre takibi ve tarih aralıklı performans raporu vardır.

> Ödül/ceza puan sistemi kaldırıldı: ilgili sayfalar, rotalar, `point_logs` /
> `weekly_category_rules` / `weekly_category_evaluations` tabloları ve
> `users.points` sütunu tamamen silindi.

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

Öğrenci sayfaları: `dashboard` (Görevlerim — liste), `new-task` (Görev Ekle —
form), `calendar`, `questions`. Görev ekleme formu ile aktif görev listesi
**ayrı sayfalardadır**; form gönderimi `next=/student/dashboard` ile listeye
döner. Yeni bir öğrenci sayfası eklerken `/student/:page` içindeki
`allowedPages` ve `studentRedirect`'teki `next` beyaz listesi birlikte
güncellenmelidir.

## Lokal Çalıştırma

```bash
brew services start postgresql@16        # port 5432
npm start                                 # http://localhost:3000
```

- `.env` mevcut (gitignore'lu): `DATABASE_URL=postgres://ayhanakkaya@localhost:5432/ogrenci_takip`, `NODE_ENV=development`, `PORT=3000`.
- Açılışta tablolar otomatik kurulur ve admin seed edilir.
- Varsayılan admin: `admin` / `admin123` (production'da değiştirilmeli).

## Deploy (GERÇEK durum)

> ⚠️ Repo içindeki eski "Hostinger" dokümanları (`scripts/deploy-hostinger.sh`, `.env.deploy`, `.github/workflows/deploy-hostinger.yml`) gerçeği yansıtmaz; geçmişten kalmadır.

- **Canlı URL:** https://takip.obs.akkayasoft.com/
- **Ortam:** VPS `obs-vps` (187.127.68.167), **nginx (Ubuntu)** reverse proxy arkasında.
- **Uygulama:** systemd servisi `ayhanakkaya-site.service` (User=www-data, `node /var/www/ayhanakkayasite/src/app.js`, NODE_ENV=production, port 3000).
- **Otomatik deploy:** `ayhanakkayasite-deploy.timer` her **1 dakikada** `/usr/local/bin/deploy-ayhanakkayasite.sh`'yi çalıştırır. Script `origin/main`'i kontrol eder; yeni commit varsa `git pull --ff-only` + `npm ci --omit=dev` + `chown www-data` + `systemctl restart ayhanakkaya-site.service` yapar.
- **Sonuç:** `main`'e push etmek yeterli — değişiklik ~1 dakika içinde otomatik canlıya çıkar. GitHub Actions kullanılmaz.

Deploy log'u: `journalctl -t deploy-ayhanakkayasite` (sunucuda). Canlı durumu doğrularken repoya değil, doğrudan URL'e (`/healthz`) istek at.

## Frontend (kademeli React geçişi)

Uygulama hâlâ EJS ile server-render edilir; etkileşimli parçalar adım adım
**React "island"**larına taşınıyor. Her island gerçek bir `/api/...` JSON
endpoint'inden beslenir (ileride mobil için de kullanılabilir).

- React kaynak kodu: `frontend/` (Vite + React, ayrı `package.json`).
- Island'lar `frontend/src/islands/*.jsx` → derlenince `src/public/dist/*.js` üretir.
- EJS sayfası island'ı `<div id="island-...">` + `<script type="module" src="/dist/...js">` ile gömer.
- **Derleme:** kökten `npm run build:frontend` (veya `cd frontend && npm run build`).
- **Önemli:** derlenen `src/public/dist/*.js` dosyaları repoya **commit edilir**; çünkü
  sunucudaki otomatik deploy yalnızca `npm ci --omit=dev` + restart yapar, build adımı yok.
  Bir island'ı değiştirdiğinde tekrar build edip dist'i commit'le.
- Mevcut island'lar: `daily-board` (admin panosu "Bugünlük Öğrenci Durumu", `/api/admin/daily-board`).

## Eğitim öğretim yılı takvimi

`src/academicCalendar.js` — **2026-2027 MEB çalışma takvimi** tek bir
`ACADEMIC_YEAR` nesnesinde tutulur; dönemler, ara tatiller, yarıyıl tatili ve
öğretim yılına düşen resmî/dinî bayramlar. Yeni öğretim yılında **yalnızca bu
nesneyi güncellemek** yeterlidir, gerisi tarihlerden türetilir.

- `getDayInfo(date)` → `{ type, label, isSchoolDay, term }`;
  type: `school` | `weekend` | `holiday` | `break` | `outside`
- `describeWeek(weekStart, weekEnd)` → başlık için `{ yearLabel, termLabel,
  weekNo, schoolDays, note }` (hafta numarası **dönem içi**)
- Haftalık takvim sayfası ve Excel export'u bu bilgiyi gösterir; ders olmayan
  günler kırmızı "eksik" yerine nötr işaretlenir.

> Not: Otomatik kilit (aşağıda) şu an **tatil günlerini ayırt etmez** — tatile
> denk gelen bir görev de süresi dolunca "yapılmadı" işaretlenir.

## Görev süresi ve otomatik kilit

Bir görev örneği (görev + gün) kendi son saatini geçtiğinde **kilitlenir**:

- Son saat = görevin `estimated_time`'ı; girilmemişse **gün sonu (23:59)**.
- Süre dolduğunda hâlâ işaretlenmemişse otomatik **`not_done`** yazılır
  (`sealOverdueTaskStatuses`, açılışta + 5 dakikada bir çalışır, idempotent).
- Kilitlendikten sonra öğrenci o görevin **durumunu değiştiremez, görevi
  güncelleyemez ve silemez** (`status`, `update`, `cell-update`, `delete`
  rotalarında `findStudentTaskIfEditable` ile engellenir). Admin'in durum
  değiştirme rotası zaten yok — yani kilit kalıcıdır.
- `AUTO_LOCK_START_DATE` (ortam değişkeni, varsayılan `2026-09-06`) bu
  tarihten **önceki** günlere hiç dokunulmamasını sağlar; özellik devreye
  girmeden önceki geçmiş geriye dönük mühürlenmez.
- Otomatik yazılan `not_done` kayıtları raporlarda durumu
  `İşaretlenmedi` yerine `Yapılmadı` olarak netleştirir.

## Çalışırken dikkat

- Canlı sistem; davranış değiştiren PR'larda önce lokalde doğrula.
- Test yok; `npm test` placeholder (hata döndürür).
- `app.js` tek dosya — değişiklik yaparken çevredeki idiom ve yardımcı fonksiyonları (`asyncHandler`, `makeId`, `normalizeText`, validasyonlar) kullan.
