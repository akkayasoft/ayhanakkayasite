# CLAUDE.md

Bu dosya, bu depoda çalışan Claude Code (ve geliştiriciler) için projenin gerçek durumunu özetler.

## Proje

**Öğrenci Takip Sistemi** — öğrencinin günlük çalışma disiplinini takip eder:
uyanma rutini, spor rutini ve okulda işlenen konuların deftere yazılması.
Ayrıca günlük soru çözüm/süre takibi ve tarih aralıklı performans raporu var.

### Görevler yalnızca üç kaynaktan gelir (19 Eylül 2026 revizyonu)

| Kaynak | Ne | Nerede |
|---|---|---|
| **Uyanma rutini** | günlük tek dokunuş, basılan saat | sahte satır (`tasks` kaydı değil) |
| **Spor rutini** | günlük tek dokunuş, basılan saat | sahte satır |
| **Ders programı** | her ders saati için bir görev (*"3. ders · Matematik"*), işlenen konu yazılınca "Yapıldı" | `tasks`, `source_key = ders:<tarih>:<saat>` |

Bunun dışında görev **üretilmez ve elle açılamaz**. Kaldırılanlar:

- **Yapay Zeka programı** (149 derslik müfredat aktarımı) — modül, veri, script,
  admin sayfası, `yz:` görevleri.
- **YDS çalışma programı** (`ydsp:` görevleri) ve **yds.obs ilerleme aynası**
  (senkron, `yds_days` / `yds_sync` / `yds_program_settings` tabloları,
  `yds:` kaynaklı soru kayıtları, YDS Takibi sayfası).
- **Elle görev açma**: admin "Görev Oluştur" / "Görev Güncelle" (toplu) /
  "Haftayı Kopyala" sayfaları ve öğrenci "Görev Ekle" sayfası; ilgili rotalar.
  Görev Yönetimi'nde **Tüm Görevler** ve **Durum Düzelt** sekmeleri kaldı.

> Temizlik `db.js` içinde **idempotent** bir migration olarak duruyor: her
> açılışta `yz:` / `ydsp:` görevlerini, `yds:` ayna soru kayıtlarını ve boşalan
> `Yapay Zeka` / `Doktora` kategorilerini siler; kalıntı yoksa hiçbir şey
> yapmaz. Kategori silme koşulludur — başka görev ya da soru kaydı bağlıysa
> dokunulmaz. Doğrulandı: canlıya benzer bir veritabanında 455 program görevi
> ve 2 kategori silindi, ikinci açılışta hiçbir şey olmadı.

> Ödül/ceza puan sistemi daha önce kaldırılmıştı: ilgili sayfalar, rotalar,
> `point_logs` / `weekly_category_rules` / `weekly_category_evaluations`
> tabloları ve `users.points` sütunu tamamen silindi.

## Teknoloji

- Node.js + Express 5 + EJS (server-side render)
- PostgreSQL (`pg`)
- Oturum: `express-session` + `connect-pg-simple` (production'da PG store)
- Güvenlik: `helmet`, `express-rate-limit`, `bcryptjs`
- Excel export: `exceljs`

## Yapı

```
src/
  app.js            ~5700 satır — TÜM route'lar, iş mantığı, view-model'ler (monolitik)
  db.js             şema + idempotent migration (açılışta otomatik) + admin seed
  academicCalendar.js  2026-2027 MEB çalışma takvimi
  schedule.js       ders çizelgesi / zil saatleri
  menuIcons.js      kenar çubuğu ve kart ikonları (SVG)
  views/            admin.ejs, student.ejs, login.ejs
  public/           styles.css, dist/ (React island'ları)
scripts/            deploy-hostinger.sh  (ARTIK KULLANILMIYOR — bkz. Deploy)
```

Roller: `admin`, `student`. Auth middleware `requireAuth` / `requireRole(role)`.

Öğrenci sayfaları: `dashboard` (Görevlerim — liste), `calendar`,
`program` (Yıllık Plan — hafta hafta), `questions`, `wake` (Uyanma Rutini),
`sport` (Spor Rutini), `schedule` (Ders Programı — **salt okunur**),
`goals` (Aylık Hedefler). Yeni bir öğrenci sayfası eklerken `/student/:page`
içindeki `allowedPages` ve `studentRedirect`'teki `next` beyaz listesi
birlikte güncellenmelidir.

## Lokal Çalıştırma

```bash
brew services start postgresql@16        # port 5432
npm start                                 # http://localhost:3000
```

- `.env` mevcut (gitignore'lu): `DATABASE_URL=postgres://ayhanakkaya@localhost:5432/ogrenci_takip`, `NODE_ENV=development`, `PORT=3000`.
- Açılışta tablolar otomatik kurulur ve admin seed edilir.
- Varsayılan admin: `admin` / `admin123` (production'da değiştirilmeli).

## Deploy (GERÇEK durum)

> `/healthz` çalışan **commit'i** döner (`version`, açılışta
> `git rev-parse --short HEAD`) ve uygulamanın başlama zamanını (`startedAt`).
> "Değişiklik canlıda mı?" sorusu artık tahminle değil bununla yanıtlanır —
> önceden yalnızca public bir dosyanın içeriğine bakarak tahmin edilebiliyordu.


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

## Tema (gapdekont tasarım dili)

Arayüz, kullanıcının kendi projesi **gapdekont.akkayasoft.com** ile aynı
tasarım diline getirildi. O uygulama React + Tailwind/shadcn; bizimki EJS +
elle yazılmış CSS, o yüzden **kod değil tasarım dili** taşındı. Değerler
oradaki HSL token'larından çevrildi:

| | değer |
|---|---|
| Ana renk | lacivert `#0d1e45` (hover `#12295e`) |
| Zemin / yüzey | `#f8fafc` / `#ffffff` |
| Kenar çubuğu | koyu lacivert `#0c1731`, metin `#cdd9ea`, vurgu `#77b5f8` |
| Köşe | girdi/düğme 4px, panel 6-10px |
| Tipografi | Inter (arayüz) · **Playfair Display** (h1/h2) · **IBM Plex Mono** (büyük harf, harf aralı etiketler) |

- Bileşen sınıfları ve markup **değişmedi**; tema tamamen `:root` token'ları
  üzerinden döndü (dosyanın başındaki "tek kaynak" ilkesi bunun için vardı).
- Kenar çubuğu artık ana paletten değil **kendi token'larından** beslenir
  (`--sidebar-*`): koyu zeminde açık metin gerektiği için ana paletin
  karşılıkları yoktu.
- Aktif menü satırı sol kenarda parlak mavi şeritle işaretlenir
  (`box-shadow: inset`; border ile çizilseydi satırın iç boşluğu kayardı).
  Mobilde menü yatay şeride döndüğü için şerit **alt çizgiye** iner.
- Serif yalnızca **başlıklarda**: KPI sayıları denendi ve geri alındı —
  Playfair'in "0"ı "o"ya benziyor ve tabular rakamı yok, veri okunurluğu
  süslemeden önce gelir.
- Giriş ekranı kart değil **tam ekran ikiye bölünmüş** düzen (solda koyu
  lacivert marka paneli, sağda form); 768px altında alt alta yığılır ve
  `min-height` sıfırlanır, yoksa telefonda sayfa iki ekran boyu olurdu.
- Tablo başlıkları mono/büyük harf: harf aralığı eklenince 0.75rem satırı
  taşırdığı için 0.7rem.

### Menü yapısı

Referans uygulamanın giriş arkasındaki düzeni görüldükten sonra menü de aynı
yapıya getirildi:

- **Marka bloğu:** kare işaret (ikon) + ad + mono alt başlık, altında ayıraç.
- **İkonlu satırlar:** her menü satırında 16px çizgi ikon (`src/menuIcons.js`).
  İkonlar bir paketten gelmiyor — derleme adımı olmayan bir EJS uygulamasına
  bağımlılık eklememek için SVG'ler tek dosyada duruyor ve `stroke:
  currentColor` ile metinle aynı rengi alıyor. Görünüm modeline `menuIcons`
  olarak geçilir, şablonda `<%- menuIcons.ad %>` ile basılır.
- **Aktif satır** dolgulu (`--sidebar-hover` + açık mavi metin); referansta sol
  şerit yok, o yüzden bizdeki şerit de kaldırıldı. Mobilde şerit alt çizgi
  olarak kalır (yatay menüde dolgu yeterince ayırt edici değil).
- **Kimlik bloğu en altta:** ad + mono rol etiketi + Çıkış, üstte ayıraçla.
  Önce menünün başındaydı ve listenin ilk 60px'ini kaplıyordu. Mobilde üst
  barda sağa yaslanır (dikeydeki `margin-top:auto` orada anlamsız).
- **Özet sayıları serif** (Playfair 600 / 30px) — referansta ölçüldü. Bir ara
  Inter'e çevrilmişti; ölçüm bunu düzeltti.

### Özet kartları ve bölüm etiketleri

- **Kart köşe ikonu:** her `.kpi` kartının sağ üstünde 16px soluk çizgi ikon
  (`.kpi-icon`). Etiketler `padding-right: 26px` alır ki uzun başlık ikonun
  altına girmesin. 59 kart var; ikonlar **etiket metnindeki anahtar kelimeye
  göre** eşlendi (öğrenci→students, oran/doğruluk→percent, süre→duration,
  saat/gecikme→clock, seri→streak …), eşleşmeyen kart `analysis` alır.
- **Bölüm etiketi** (`.section-label`): mono büyük harf + sağa uzayan ince
  çizgi; kart grubunun *grubunu* adlandırdığı için panelin dışında durur
  (referanstaki "GENEL DURUM ————" satırı). 13 izgaranın üstüne eklendi.
  > Negatif `margin-bottom` ile kapsayıcının boşluğunu kısmak denendi ve
  > **geri alındı**: sayfaların bir kısmı `.container` flex'ini kullanmıyor,
  > orada gap yok ve etiket ilk kartın altına giriyordu (ölçüldü: 8px
  > çakışma). Artık sabit 10px alt boşluk var.
- **Panel başlıkları** da aynı dile geçti: mono, büyük harf, 0.12em aralık;
  alttaki ince çizgi referanstaki "sağa uzayan çizgi"nin işini görüyor.

Doğrulandı: 1440 / 390px'te 14 admin + 9 öğrenci sayfası 200, sayfa taşması 0,
menü ikonları her iki panelde de basılıyor; kart ikonu ve bölüm etiketi
çakışması yok.

> Giriş ekranındaki tanıtım metni kaldırılmış puan sistemine atıf yapıyordu
> ("Ödül-ceza puanlama"); güncellendi.

## Tablolar ve sığma

Tablolar **kapsayıcılarına sığar**; yatay kaydırma yalnızca gerçekten iki
boyutlu olan iki ızgarada kalır.

- `table` üzerindeki genel `min-width: 640px` **kaldırıldı**. 390px'lik bir
  telefonda bu kural, sığabilecek tabloları bile 318px taşırıyordu. Geniş
  olması gereken tablolar kendi `min-width`'ini tanımlar.
- **İstisna — haftalık analiz tabloları.** Karşılaştırma 13, gün kırılımı 14
  sütun; 1084px'lik içerik alanına sığdırmaya çalışmak metni dikey dilimlere
  böler ("Ayhan Akkay a", "202 6-09-07"). Bu ikisi `.analysis-table` (1180px)
  ve `.analysis-day-table` (1280px) ile kapsayıcı içinde **yatay kaydırılır**;
  masaüstünde 96-196px kaydırma çıkar, telefonda `.stack-mobile` ile karta
  döndükleri için kaydırma olmaz.
- `td` metni sarar (`overflow-wrap: anywhere`). `.single-line-cell` de artık
  sarar; `nowrap` yalnızca kısa/sabit biçimli alanlarda (saat, kategori).
- `.student-task-table` masaüstünde `table-layout: fixed`. Önce başlık ve
  açıklama sütunları içeriğe göre büyüyüp tabloyu **1440px ekranda bile 505px**
  dışarı itiyordu. Sütun sırası: **Tarih · Kategori · Konu · Saat · Açıklama ·
  Durum · İşlem**; genişlikler CSS'te `nth-child` ile verildiği için sütun
  sırası değişirse o kurallar da (hem masaüstü hem mobil sıfırlama bloğu)
  birlikte güncellenmelidir. Satır içi düzenleme `data-field` seçicileriyle
  çalışır, sütun konumuna bağlı değildir.
- **Mobil (≤640px): `.stack-mobile` taşıyan tablolar karta döner.** Her satır
  "etiket: değer" çiftlerinden oluşan bir blok olur. Etiketler her `<td>`'ye
  elle yazılmaz — sayfa sonundaki küçük betik `thead th` metinlerinden
  `data-label` üretir. Betik çalışmazsa tablo eskisi gibi kaydırılır, içerik
  kaybolmaz.
- Kart hücresi `grid` değil **`flex`**: bir hücrede birden fazla öğe olabiliyor
  (rozet + trend gibi). Grid'de ikinci öğe bir sonraki satırın *etiket*
  sütununa düşüyordu.
- **Ders çizelgesi ve defter ızgarası** ayrı bir mekanizma kullanır: `.board`
  (aşağıya bakın). Onlar da telefonda sığar.

### Çizelge/defter panosu (`.board`)

Ders çizelgesi ve işlenen konular artık `<table>` değil, **tek bir CSS grid**.
Hücreler DOM'a **gün sırasıyla** yazılır (önce pazartesinin tüm saatleri):

- **Masaüstünde** grid her hücreyi satır içi `--g` (sütun = gün) ve `--s`
  (satır = ders saati) ile kendi yerine koyar. DOM sırası önemsiz; ekranda
  eskisiyle birebir aynı ızgara çıkar, satırlar günler arasında hizalı kalır
  (flex sütunlarla hizalanmazdı).
- **Telefonda** grid kapanır, akış DOM sırası olur: **gün gün liste**. Zil
  saati her hücrenin içinde yazılıdır (`.board-cell-time`), soldaki saat
  sütunu gizlenir. Boş saatler gizlenir — 4 dersi olan gün 10 değil 4 satır.

> **Neden ikinci bir mobil blok değil:** işlenen konular ekranı bir formdur.
> Aynı `name`'li textarea'ları iki kez göndermek (biri gizli olsa bile)
> `konu[gün-saat]` alanını diziye çevirir ve kaydı bozardı. Tek işaretleme
> şart. Doğrulandı: sayfada `konu[1-1]` **bir kez** geçiyor, admin ve öğrenci
> panellerinden kayıt doğru satırlara yazıyor.

`--g` / `--s` / `--gun-sayisi` HTML'de satır içi tanımlanır; CSS token
denetleyicisi onları "tanımsız" görür, bu beklenen durumdur.

> Ölçüm notu: sayfa taşmasını Playwright ile ölçerken `waitUntil` **`load`**
> olmalı. `domcontentloaded` ile CSS henüz uygulanmadan ölçülüyor ve uydurma
> taşma değerleri çıkıyor. Ayrıca `styles.css` bir Google Fonts `@import`'u
> içerdiği için `load` bu ortamda proxy'de takılır; ölçüm betiğinde dış
> istekleri `page.route` ile kesmek gerekir.

## Yıllık plan (öğrenci) — hafta hafta içerik

`/student/program` → **Yıllık Plan**. Haftalık takvim tek haftayı gösterir ve
ileri/geri **tek tek** gidilir; 2026-2027 planını baştan sona görmek 40 tık
demekti. Bu sayfa öğretim yılının **bütün haftalarını** listeler, seçilen
haftanın içeriğini gün gün açar.

- `buildStudentProgramView(studentId, allTasks, categories, today, hafta)`:
  öğretim yılının ilk haftasından son haftasına (41 hafta) döner; her hafta
  için görev sayısı, tamamlanan ve **kategori kırılımı** (*"Ders Defteri 1"*)
  üretir. **İçerik (başlık + açıklama) yalnızca seçili hafta
  için** üretilir — 41 haftanın tüm görevlerini görüntüye taşımak gereksiz.
- Yılın **tüm durumları tek sorguda** çekilir (`BETWEEN` ilk hafta - son
  hafta); hafta hafta gitmek 41 gidiş olurdu.
- Seçili hafta `?hafta=YYYY-MM-DD` ile gelir, öğretim yılına **kırpılır**;
  parametre yoksa içinde bulunulan hafta. Sayfada hafta seçici (41 haftalık
  açılır liste), önceki/sonraki/bu hafta ve *"Takvimde Aç"* bağlantısı var.
- Görev listesinden farkı: **defter görevleri kendi haftasında görünür**
  (listede yalnızca içinde bulunulan haftanınki kalır — orada günlük görevleri
  boğmasın diye). Arşivli görevler elenir.
- Sayfa yalnızca **öğretim yılı içindeki** haftaları gösterir; yıl dışına
  düşen görevler (varsa) Haftalık Takvim ve Görevlerim'de durur.

Doğrulandı (revizyon sonrası, 7 ders saatlik çizelgeyle): **287 ders görevi**,
205 güne yayılmış, ilki 14 Eylül. Gün kartlarında tatil etiketleri
(*"1. Ara Tatil"*) duruyor. Admin → `/student/program` **403**,
oturumsuz **302**.

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

Bir görev örneği (görev + gün) **iki sebepten** kilitlenir; ikisi de kalıcıdır:

1. **İşaretlendi** — `done` ya da `not_done` yazıldığı anda görev **pasif**
   olur. Uyanma ve spor rutinindeki *"ilk basış geçerli"* kuralının görev
   tarafındaki karşılığı.
2. **Süresi doldu** — kendi son saatini geçti (aşağıdaki bölüm).

Kilitlenince öğrenci o görevin **durumunu değiştiremez, alanlarını
düzenleyemez ve silemez**. Arayüz sebebi ayırt eder: rozette *"İşaretlendi"*
ya da *"Süresi doldu"* yazar, hata mesajları da (`kilitMesaji`) buna göre
gelir.

### İşaretleme kalıcıdır

- Öğrenci durum rotası artık `ON CONFLICT ... DO NOTHING` kullanır (eskiden
  `DO UPDATE` ile üzerine yazıyordu). Yazma öncesi kontrol var; yarış
  durumunda ikinci istek `rowCount === 0`'a düşer ve yine ilk işaret korunur.
- `isTaskInstanceMarked(taskId, studentId, repeatType, gün)` — **tek seferlik**
  görevde *herhangi* bir durum satırı sayılır (o görevin tek örneği vardır;
  tarihi sonradan değiştiyse satır başka güne yazılmış olabilir). **Tekrarlı**
  görevde yalnızca **ilgili günün** satırı sayılır — dünkü işaret bugünkü
  örneği kilitlemez.
- Sistem yazıcıları (`sealOverdueTaskStatuses`, `completeLessonLogTasks`)
  zaten `DO NOTHING` kullanıyordu; artık üç yazıcı da aynı kuralda.

> ⚠️ **Öğrenci için geri dönüşü yok — düzeltme yalnızca adminde.** Kazara
> basılan bir düğmeyi ya da unutulmuş bir işareti öğrenci düzeltemez; admin
> **Durum Düzelt** sayfasından düzeltir (aşağıya bakın). Uzun süre bu kapı da
> yoktu ve veritabanına elle müdahale gerekiyordu.

#### Durum Düzelt (admin) — işaretlemenin tek geri dönüşü

`/admin/tasks/status` → **Durum Düzelt**. Öğrenci işaretlemeyi unutunca
mühürleyici `not_done` yazıyor; yapılmış bir iş kalıcı olarak "yapılmadı"
görünüyordu. Kural esnetilmedi — **öğrenci tarafı aynen kilitli**; yalnızca
admin'e bir kapı açıldı.

- Düzeltilen şey görev değil **görev örneğidir** (görev + gün), çünkü durum da
  o seviyede tutulur. Panel bu yüzden **gün bazlıdır**: öğrenci + gün seçilir,
  o gün vadesi gelen görevler durumlarıyla listelenir, her satırda
  *Yapıldı* / *Yapılmadı* / *İşareti Kaldır* düğmeleri vardır.
- Rota `POST /admin/tasks/:taskId/status-fix` (`requireRole('admin')`;
  doğrulandı: öğrenci **403**, oturumsuz **302**).
- **Kapı sessiz değil.** Her düzeltme satırın içine yazılır:
  `task_statuses.corrected_by` / `corrected_at` / `previous_status` /
  `correction_note`. Panel bunu satırda gösterir:
  *"Düzeltildi · Sistem Yöneticisi (Yapılmadı → Yapıldı) · gerekçe"*.
  Gerekçe **opsiyoneldir**: kim, ne zaman ve neyin üzerine yazdığı zaten
  otomatik kaydedildiği için kayıt gerekçesiz de eksik değil. (Aylık
  hedeflerdeki zorunlu "kanıt" ile arasındaki fark bilinçli: orada kanıt
  iddianın tek dayanağı, burada değil.)
- **Yalnızca gerçekten vadesi gelen güne yazılır** (`isTaskDueOnDate`);
  formdan gelen beklenmedik bir gün kayıt açamaz. Arşivlenmiş görevin geçmiş
  örneği de düzeltilebilir — arşiv "yeni örnek açılmasın" demektir, geçmişi
  yok saymaz.
- **Sistem taban tarihinden önceye yazılamaz** — `purgeBeforeSystemStart` o
  kayıtları her açılışta silerdi. Panelde o günlerde düğme yerine *"Yazılamaz"*
  yazar; ölü bir kontrol bırakılmadı.
- **"İşareti Kaldır" yalnızca kalıcı olduğunda açıktır.** Süresi dolmuş bir
  örneğin işareti silinse `sealOverdueTaskStatuses` 5 dakika içinde yeniden
  `not_done` yazardı; "temizlendi" demek yalan olurdu. Rota bu durumu
  reddediyor ve *"bunun yerine Yapıldı olarak düzeltin"* diyor, panel de
  düğmeyi göstermiyor.

> Mühürleyici `ON CONFLICT DO NOTHING` kullandığı için admin'in yazdığı `done`
> **ezilmez**. Doğrulandı: düzeltmeden sonra uygulama yeniden başlatıldı,
> satır `done` + düzeltme izi olduğu gibi kaldı.

##### Günün tamamını onayla (toplu)

`POST /admin/tasks/status-fix-bulk` — panelde *"Günün tamamı: Tümü Yapıldı /
Tümü Yapılmadı"*. Program görevleri 14 Eylül'den itibaren günde 1 saat olarak
yazıldığı için geçmiş bir günde 3-5 görev birden mühürleniyor; o gün gerçekten
çalışıldıysa hepsini tek tek düzeltmek gerekiyordu.

- Tek görev rotasıyla **aynı kurallar**: yalnızca o gün vadesi gelen görevlere
  yazar (`isTaskDueOnDateIgnoringArchive`), taban tarihten öncesine yazmaz ve
  her satır kendi düzeltme izini taşır (`corrected_by` / `previous_status` /
  gerekçe).
- Zaten istenen durumda olan görevler **atlanır** ve mesajda kaç tanesinin
  atlandığı söylenir (`ON CONFLICT ... DO UPDATE ... WHERE status IS DISTINCT
  FROM`), yani ikinci basış izleri tazelemez.
- Öğrenci **403**, oturumsuz **302**.

Doğrulandı: 15 Eylül'de mühürlenmiş 2 görev tek hamlede `done` oldu
(`previous_status='not_done'`, gerekçe ve düzelten kaydedildi); ikinci basış
*"0 görev … 2 görev zaten Yapıldı durumundaydı"* dedi; *Tümü Yapılmadı* ile
geri alındı; taban öncesi gün, geçersiz işlem, görevi olmayan gün ve olmayan
öğrenci **reddedildi**; aynı gündeki **başka öğrencinin** görevine
dokunulmadı. 390px'te form sarıyor, taşma 0.

Doğrulandı (temiz veritabanı, 2026-09-17 13:00 sahte saatiyle; 12:00 son
saatli görev mühürleyici tarafından `not_done` yazılmış): düzeltme
`not_done → done` yazdı ve `previous_status='not_done'`, `corrected_by=admin`,
`corrected_at`, gerekçe kaydedildi; aynı durumu tekrar göndermek **reddedildi**;
süresi dolmuş örnekte *İşareti Kaldır* **reddedildi** ve satır değişmedi;
süresi dolmamış örnekte kaldırma **çalıştı** ve yeniden açılışta geri gelmedi;
görevin tanımlı olmadığı gün, taban öncesi gün, geçersiz işlem/gün ve olmayan
görev **reddedildi**. Öğrenci tarafında görev *"İşaretlendi"* rozetiyle
**Yapıldı** görünüyor; öğrencinin durum değiştirmesi, açıklama yazması (**403**)
ve silmesi hâlâ reddediliyor. Düzeltme günlük panoya (3 görevin 1'i yapıldı) ve
raporlara normal bir durum satırı olarak işliyor. Üç genişlikte (1440 / 1180 /
390px) taşma **0**.

Doğrulandı: `done` işaretlendikten sonra `not_done`'a çevirme **reddedildi**
ve satır değişmedi; aynı durumu tekrar göndermek de reddedildi; işaretli
görevde açıklama ve saat **403**, silme reddedildi (görev duruyor);
öğrencinin **kendi açtığı** işaretli görev de silinemedi; işaretsiz görevde
aynı alanlar **200**. Panoda işaretli görev *"İşaretlendi"*, süresi dolmuş
görev *"Süresi doldu"* rozeti taşıyor.

### Son saat ve otomatik mühürleme

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

> ⚠️ **"Saat" alanı tahmini süre değil SON TESLİM saatidir.** Alan adı bir
> dönem "Tahmini Saat"ti; bu yanıltıcıydı, çünkü girilen saat geçtiğinde görev
> kilitlenir ve işaretlenmemişse kalıcı olarak `not_done` olur. Etiket her iki
> formda da **"Son Saat"** olarak düzeltildi ve kilit uyarısı forma yazıldı.
> Doğrulandı: 07:30 son saatli bir görev, saat 08:00'de açılan uygulamada
> `not_done` mühürlendi. Defter görevlerinde son saat girilmez; son teslim
> haftanın pazarı, gün sonudur (23:59).

### Saat ve açıklama sonradan girilebilir

Defter görevleri `estimated_time` olmadan yazılır; son saatleri gün sonudur.
**Saat ve açıklama** öğrenci tarafından düzenlenebilir; tek koşul görevin
**kilitli olmaması**:

- **Saat** — girmek son teslimi öne çeker, erteleyemez; üst sınır zaten gün
  sonudur (23:59). Yani gevşetme değil sıkılaştırma.
- **Açıklama** — öğrencinin kendi notu için: *"3. soruda takıldım"*,
  *"yarım kaldı"*. Görevin **kimliğini** değiştirmez.
- **Başlık, kategori, tarih** hâlâ yalnızca öğrencinin kendi açtığı tek
  seferlik görevlerde açık (`canManage`). Görünüm modelinde `canEditTime` ve
  `canEditDescription`, `canManage`'den ayrıdır.

> ⚠️ **Elle yazılan açıklama aktarımda ezilmez.** Defter aktarımı
> işaretlenmemiş + günü gelmemiş görevlerin başlık/açıklamasını tazeliyor;
> önlem olmasa öğrencinin yazdığı not "Görevlere Aktar"a basınca silinirdi.
> `tasks.description_edited` bayrağı öğrenci açıklamayı değiştirince kalkar ve
> aktarım o satırda `description = CASE WHEN description_edited THEN
> description ELSE $yeni END` ile açıklamaya dokunmaz. **Başlık yine tazelenir**
> — program görevin kimliğinin kaynağıdır, not öğrencinin.
> Doğrulandı: not yazıldıktan sonra ders başlığı değiştirilip yeniden
> aktarıldı; başlık güncellendi, **not olduğu gibi kaldı**, dokunulmamış
> görevin açıklaması da değişmedi.

Doğrulandı: aktarılan görevde açıklama 200 ve bayrak kalkıyor; aynı görevde
başlık ve kategori hâlâ **404**; kilitli (geçmiş) görevde açıklama **403** ve
bayrak kalkmıyor; başka öğrencinin görevinde **404**; admin → öğrenci rotası
**403**. Listede açıklama tam olarak saatle aynı davranıyor: bugün ve sonrası
düzenlenebilir, geçmiş kilitli, konu her durumda kapalı.

> Not: `task_detail_notes` tablosu şemada var ama **kodda hiç kullanılmıyor** —
> eski bir tasarımdan kalma. Gün bazlı not gerekirse yeri orasıdır; şu an
> öğrenci notu `tasks.description` alanında tutuluyor.

## Okul ders programı

`/admin/schedule` — uygulama sahibinin (öğretmen) haftalık ders çizelgesi.
Öğrenci başına değil, **uygulama genelinde tek programdır**; bu kurulumda tek
öğretmen var. Çoklu öğretmen gerekirse tabloya sahip alanı eklenmeli.

**Öğrenci tarafı** (`/student/schedule`) aynı iki görünümü gösterir: çizelge
ızgarası + gün özeti, ve hafta gezinmeli işlenen konular. **Çizelge her zaman
salt okunurdur**; düzenleme/aktarma rotalarının tamamı `requireRole('admin')`
arkasında (doğrulandı: öğrenci rolüyle beş POST rotası ve `/admin/schedule`
403 döndü). Defterin tek istisnası aşağıdaki öğretmen işaretidir.

- `school_settings` (tek satır, id `default`): başlangıç saati, ders/teneffüs
  süresi, günlük ders saati sayısı, öğle arası (hangi dersten sonra, kaç dk).
- `class_schedule`: `term` (0 = yıl boyu, 1/2 = dönem), `day_of_week` (**1-7**,
  ISO: 1 = Pazartesi … 7 = Pazar), `period`, `subject`, `class_name`, `room`,
  `kind` (`lesson` | `duty`). `UNIQUE (term, day_of_week, period)` — aynı hücre
  iki kez dolamaz.

### Çizelge 7 günlük (hafta sonu dahil)

Program önce **Pzt-Cum** idi; hafta sonuna ders koyan bir düzen (DYK, ek ders,
hafta sonu kursu) programa hiç girilemiyordu. Artık çizelge **7 gündür**.

- Gün numaraları **ISO**: 1 = Pazartesi … **6 = Cumartesi, 7 = Pazar**.
  `schedule.GUNLER` tek kaynaktır; izgara, gün özeti ve görünümler onu kullanır.
- `schedule.dayOfWeek(tarih)` artık hafta sonunda **0 değil 6/7** döner. Eskiden
  0 dönüyordu ve çağıranlar bunu "ders yok" diye okuyordu; "ders işlenir mi"
  sorusunu artık **takvim** yanıtlar, gün numarası değil.
- İki tablonun `day_of_week` kontrolü 1-5'ten **1-7**'ye genişletildi.
  `CREATE TABLE IF NOT EXISTS` var olan tabloyu değiştirmediği için kısıt
  `DROP CONSTRAINT IF EXISTS` + `ADD CONSTRAINT` ile elle genişletilir
  (daraltma değil genişletme olduğundan mevcut satırların hepsi geçerli kalır).
  Doğrulandı: 1-5 kısıtlı eski bir veritabanı açılışta 1-7'ye geçti, eski
  çizelge ve defter satırları korundu, ardından cumartesi kaydı kabul edildi.
- Toplu yapıştırma `Cumartesi` / `Cmt` / `Pazar` / `Paz` kısaltmalarını da tanır.

> ⚠️ **Asıl mesele kısıt değil, "ders işlenir mi" kuralıydı.** Defter yazımı,
> haftalık takvim ve defter görevi `getDayInfo().isSchoolDay`'e bakıyordu.
> Kural değişmeseydi cumartesiye konan ders ekranda görünür ama **deftere
> yazılamaz, takvimde çıkmaz, defter görevine sayılmazdı** — yarım bir özellik.

### Takvim artık hiçbir şeyi engellemez

İlk adımda hafta sonu açılmış, tatil günleri kapalı bırakılmıştı. Kullanıcı
**tatil günlerinde de ders yapabildiğini** söyledi (telafi, kurs, bayram
sonrası ek ders). Bu yüzden takvim kapısı **tamamen kaldırıldı**:

- `academicCalendar` artık yalnızca **etiket** üretir. `isUnusualCalendarDay()`
  (bayram / ara tatil / yarıyıl / öğretim yılı dışı) sadece defter ızgarasında
  bilgi rozeti göstermek için kullanılır — *"takvimde tatil, yine de
  yazabilirsin"*. Hiçbir hücreyi kapatmaz.
- Haftalık takvim, defter yazımı, defter sayacı ve defter görevi artık
  **hiçbir gün türünü elemez**.
- Haftalık takvimdeki *"Hafta sonu"* / *"Cumhuriyet Bayramı"* rozetleri duruyor;
  o günün dersi ve "N ders / M boş" sayacı da artık görünüyor.

> **"Bu hafta ders yok" demenin doğru yeri artık takvim değil, HAFTAYA ÖZEL
> ÇİZELGE'dir** (aşağıya bakın): o haftanın ızgarası boşaltılır. Böyle bir
> haftada ders görünmez ve defter görevi de açılmaz.

### Haftaya özel çizelge

Çizelge tek bir haftalık şablondu ve her hafta aynı kabul ediliyordu; oysa
hafta hafta değişebiliyor (seminer, sınav haftası, telafi dersi, DYK düzeni).

- `class_schedule.week_start`: **`1900-01-01` = varsayılan şablon**, başka bir
  tarih o haftanın kendi çizelgesi. `UNIQUE (week_start, term, day_of_week,
  period)`. NULL yerine **sabit tarih** kullanıldı — Postgres'te NULL'lar
  birbirinden farklı sayıldığı için NULL'lu bir UNIQUE aynı hücrenin iki kez
  girilmesini engellemezdi (`term`'de de aynı sebeple 0 seçilmişti).
- Çözümleme **birleştirme değil tam değiştirme**: hafta özelleştirilmişse o
  hafta için şablon hiç kullanılmaz. Birleştirme *"bu hafta bu ders yok"*u
  ifade edemezdi (silinen hücre için mezar taşı satırı gerekirdi).
  Özelleştirme bu yüzden **şablonu o haftaya kopyalayarak** başlar.
- `/admin/schedule?hafta=YYYY-MM-DD` → o haftanın ızgarası. Parametre yoksa
  **varsayılan şablon** düzenlenir (eski davranış). Panelde hafta gezinmesi,
  *"Bu haftayı özelleştir"* ve *"Varsayılan çizelgeye döndür"* düğmeleri var.
  Öğrenci tarafında da hafta gezinmesi var; varsayılan **bu haftadır**.
- Ders ekleme ve toplu yapıştırma bir haftaya yazarken **önce şablonu o haftaya
  kopyalar** (`ensureWeekCustomized`). Önlem olmasa özelleştirilmemiş bir
  haftaya tek ders eklemek o haftayı tek derslik bir çizelgeye çevirir ve
  haftanın geri kalanı sessizce kaybolurdu.
- *"Bu Haftayı Boşalt"* yalnızca o haftayı siler; varsayılan şablona dokunmaz.

> ⚠️ **"Özel" işareti ders satırlarından AYRI tutulur** (`schedule_week_overrides`).
> Özelliği satır varlığından türetmek denendi ve tutmadı: bir haftayı
> özelleştirip **boşaltmak** ("bu hafta hiç ders yok") satırları sildiği için
> hafta yeniden şablona dönüyordu — tam da anlatılmak isteneni silen bir
> davranış. Ölçüldü: boşaltılan hafta şablonun 6 dersini geri gösteriyordu.
> İşaret ayrı durunca *"özel ama boş"* ifade edilebilir hale geldi.

- `buildLessonLogWeeks` her haftayı **kendi çizelgesiyle** hesaplar; boş özel
  haftalar `getCustomScheduleWeeks()` haritasına **boş dizi** olarak girer,
  yoksa şablona düşerlerdi.
- `lesson_topics` zaten ders/sınıf adını kaydın içine kopyaladığı için
  **geçmiş defter bozulmaz**: haftayı varsayılana döndürmek işlenen konuları
  silmez.

Doğrulandı (temiz veritabanı, 26 Ekim 2026 saatiyle): varsayılan şablona 6 ders
yapıştırıldı; 2 Kasım haftasına **doğrudan** cumartesi dersi eklendi ve hafta
kendiliğinden özelleşti (şablondan 6 ders kopyalandı, toplam 7); o haftadan bir
ders silindi ve **varsayılan şablon değişmedi**. 9 Kasım haftası özelleştirilip
boşaltıldı: işaret kaldı, 0 hücre yazılabilir, sayaç *0 / 0*, o hafta için
**defter görevi açılmadı** (40 haftanın hiçbirinde yok) ve öğrenci tarafında
*"Bu hafta ders yok"* yazıyor (hafta gezinmesi duruyor). *Varsayılana döndür*
sonrası hafta yine 6 derslik şablonu kullandı, ikinci kez döndürme
**reddedildi**. Tatil günü (29 Ekim, Cumhuriyet Bayramı) **yazılabilir** ve
defter görevi o hücreyle birlikte 6/6 olunca `done` işaretlendi; 2 Kasım haftası
cumartesi dersiyle birlikte 7/7 olunca `done` oldu. 1-5 kısıtlı **eski** bir
veritabanı açılışta göç etti: eski kısıt düştü, satırlar `1900-01-01` şablonuna
yerleşti, defter kaydı ve ders satırları korundu. Yetki: öğrenci beş admin
rotasında **403**, oturumsuz **302**; öğretmen bayraklı öğrenci özel haftaya
defter yazabildi, bayrak kalkınca **403** ve satır değişmedi. Üç genişlikte
(1440 / 1180 / 390px) 13 sayfada **taşma 0**, JS hatası 0.

Doğrulandı (temiz veritabanı, 21 Eylül 2026 saatiyle; Pzt-Cum + Cmt 2 ders +
Paz 1 ders yapıştırıldı): çizelge 7 sütun, gün özeti 7 satır; defter ızgarasında
21 Eylül haftasında **9 hücrenin 9'u** yazılabilir (6-1, 6-2, 7-1 dahil);
29 Ekim haftasında perşembe *Cumhuriyet Bayramı* ile kapalı (8 hücre),
16 Kasım haftasında Pzt-Cum *1. Ara Tatil* ile kapalı, **yalnız hafta sonu**
yazılabilir (3 hücre). Öğrenci takviminde cumartesi *"Hafta sonu"* rozetiyle
**2 ders**, pazar **1 ders** görünüyor. Defter görevi hafta içi 6 hücre dolunca
**tamamlanmadı**, hafta sonu da dolunca `done` oldu — hafta sonu gerçekten
sayılıyor. Rota `dayOfWeek` 6 ve 7'yi kabul, 0 ve 8'i **reddediyor**. Excel
çıktısında 26-27 Eylül satırları doğru tarih ve gün adıyla var. Üç genişlikte
(1440 / 1180 / 390px) **sayfa taşması 0**; `.board` 1440'ta ve telefonda tam
sığıyor, 1180'de kapsayıcı içinde 160px yatay kaydırma kalıyor (analiz
tablolarındaki kabul edilen desenin aynısı). Telefonda ızgara gün gün listeye
dönüyor ve Cumartesi/Pazar blokları da çıkıyor.

> `term` NULL değil **0** varsayılanlı: Postgres'te NULL'lar birbirinden farklı
> sayıldığı için NULL'lu bir UNIQUE kısıtı aynı hücrenin iki kez girilmesini
> engellemezdi.

**Zil saatleri saklanmaz, hesaplanır** (`src/schedule.js`): ayardan her ders
saatinin başlangıç-bitişi türetilir. Böylece "8. ders kaçta" sorusunun tek doğru
cevabı olur ve saatler elle girilirken kaymaz. Sayfada günün bitiş saati
gösterilir; kullanıcı süreleri tutturana kadar ayarlar (08:00 + 10 ders × 40 dk
+ 10 dk teneffüs + 6. dersten sonra 40 dk öğle = 16:40).

- Dolu bir hücreye tekrar kayıt **üstüne yazar** (`ON CONFLICT DO UPDATE`);
  düzeltmek için önce silmek gerekmez.
- **Toplu yapıştırma** (`/admin/schedule/paste`, ayrıştırıcı
  `schedule.parseScheduleText`): `gün · ders saati · ders adı · sınıf · derslik`
  satırları. Bilerek toleranslı — ayraç sekme/noktalı virgül/virgül/2+ boşluk,
  gün adı kısaltmaları ve Türkçe karakter varyantları, `3. ders` yazımı,
  `1-2` / `2/4` blok ders aralıkları (her saate ayrı satır açılır), `Nöbet`
  ders adı `kind='duty'` olur, `#` satırları atlanır.
  - Anlaşılmayan satır **sessizce atılmaz**: kaç tane olduğu ve ilki hatasıyla
    birlikte mesajda bildirilir.
  - "Önce mevcut programı temizle" kutusu işaretlenirse tüm çizelge silinip
    yeniden yazılır; işaretsizse üstüne eklenir/yazılır.
  - **Bilinen sınır:** tek boşlukla ayrılmış satırda sınıf/derslik ayrılamaz
    (`Pazartesi 9 Ek Ders 11-C` → ders adı "Ek Ders 11-C"). Sınıf yazılacaksa
    sekme, virgül ya da iki boşluk kullanılmalı; arayüzde de uyarılıyor.
- Günlük ders saati sayısı küçültülürse kapsam dışı kalan kayıtlar silinir ve
  kaç tanesi silindiği mesajda bildirilir — yoksa öksüz satır kalırdı.
- Çizelge **Haftalık Takvim'e** de işlenir: gün kartlarında o günün dersleri
  saatleriyle, özet tablosunda "N ders / M boş" sütunu. **Her gün** işlenir —
  hafta sonu da tatil de; o haftanın çizelgesi neyse o gösterilir.

### İşlenen konular (ders defteri)

Aynı sayfada ikinci görünüm: `/admin/schedule?gorunum=konular&hafta=YYYY-MM-DD`.
Çizelgeyle **aynı ızgara**, ama seçili haftada dersi olan her saate o hafta
işlenen konu yazılır. Tüm hafta tek formda gönderilir (`konu[gün-saat]`).

- `lesson_topics`: `UNIQUE (week_start, day_of_week, period)`.
- Kayıt `class_schedule` satırına **bağlanmaz**; `(hafta, gün, saat)` üçlüsüne
  bağlanır ve o andaki ders/sınıf adı kaydın içine **kopyalanır**. Böylece
  çizelge sonradan değişse bile geçmiş defter okunabilir kalır — doğrulandı:
  bir ders silinip diğeri başka derse çevrildikten sonra defter satırları
  olduğu gibi durdu.
- Sunucu tarafı yalnızca **o haftanın çizelgesinde dersi olan** hücreleri
  yazar; formdan gelen beklenmedik anahtar kayıt açamaz. Gün türü (hafta sonu,
  tatil) artık hiçbir hücreyi kapatmaz.
- Boş bırakılan alanın kaydı silinir (boş satır birikmez).
- Dolu olmayan hücrede geçen haftanın konusu ipucu olarak gösterilir.
- Sayaç paydası **tüm dolu hücreleri** sayar (nöbet dahil); yalnızca dersleri
  saysaydı hepsi dolduğunda "15 / 14" gibi bir sayaç çıkardı.
- **Excel çıktısı**: `sendLessonTopicsExcel()` iki rotaya bağlıdır —
  `/admin/schedule/topics/export` ve `/student/schedule/topics/export`. Dosya
  ikisinde de aynı; öğrenci veriyi zaten ekranda gördüğü için indirmesini
  engellemek yapay sürtünme olurdu. Hata dönüşü çağırana göre değişir
  (`adminRedirect` / `studentRedirect`), formlar `next` ile programa döner.
  Rol ayrımı korunur: her rota kendi rolüne kapalıdır (çapraz erişim 403).
  Parametreler `?from=&to=`. İki sayfa —
  *İşlenen Konular* (tarih · gün · dönem · ders saati · saat · ders · sınıf ·
  konu; dondurulmuş başlık + otofiltre) ve *Sınıf Özeti* (sınıf/ders bazında
  işlenen ders saati, ilk/son kayıt).
  - Gerçek tarih `week_start + (day_of_week - 1)` ile hesaplanır, zil saati
    ayardan; dönem etiketi `academicCalendar`'dan gelir.
  - Varsayılan aralık **içinde bulunulan dönem**; dönem dışındaysak (yarıyıl
    tatili ya da öğretim yılı başlamadan) tüm öğretim yılı.

### Ders görevleri (her ders saati = bir görev)

`/admin/schedule` → **Ders Görevleri** paneli → "Ders Görevlerini Oluştur".
Çizelgedeki **her ders saati kendi görevidir** ve kendi gününe düşer:
*"3. ders · Matematik"*, açıklama *"10:20-11:00 · 9-A · işlenen konuyu yaz"*.
O dersin **işlenen konusu yazılınca görev anında "Yapıldı"** işaretlenir.

> ⚠️ **Önce haftada TEK görev vardı** (*"Ders defterini doldur"*) ve ancak
> haftanın bütün hücreleri dolunca tamamlanıyordu. Kullanıcı bir dersi işleyip
> haftayı kaydettiğinde "Görevlerim"de hiçbir şey değişmiyordu — liste yapılan
> işi göstermiyordu. Model ders başına göreve çevrildi; eski `defter:%`
> görevleri açılıştaki temizlikte siliniyor.

- `source_key` = `ders:<tarih>:<saat>`; idempotent, tekrar basılabilir. Yeni
  dersler eklenir, **işaretlenmemiş ve günü gelmemiş** görevlerin
  başlığı/açıklaması tazelenir, çizelgeden kalkan derslerin (yine yalnızca
  işaretlenmemiş + gelecek) görevleri silinir.
- Kategori: `Ders Programı`. Her hafta **kendi çizelgesiyle** hesaplanır
  (özelleştirilmiş hafta kendi satırlarını kullanır); takvim hiçbir günü
  elemez — "bu hafta ders yok" demenin yolu o haftanın çizelgesini boşaltmak.
- **Son saat yazılmaz**: son teslim gün sonudur (23:59). Dersin bitiş saatine
  bağlansaydı akşam deftere yazan öğretmenin görevi öğleden sonra "yapılmadı"
  mühürlenmiş olurdu.
- `completeLessonTasks()` iki yerden çağrılır: **konular kaydedildiği anda**
  (`saveLessonTopicsAndComplete`; hem admin hem öğretmen işaretli öğrenci
  rotası) ve `runSealSafely` içinde (açılışta + 5 dakikada bir)
  **`sealOverdueTaskStatuses`'tan önce**. Sıra önemli: aynı turda hem konu
  yazılıp hem gün bitmişse görev "yapıldı" olmalı.

> **Konu yazmak, mühürleyicinin yazdığı "Yapılmadı"yı da düzeltir.** Defterin
> doğru kaydı `lesson_topics`tir ve oraya yalnızca admin (ya da öğretmen
> işaretli hesap) yazabilir — yani bu, *Durum Düzelt* ile aynı yetkidir. Aksi
> hâlde geçmiş derslerin görevi akşam mühürlenir ve ertesi gün konuyu yazan
> öğretmen görevi bir türlü "Yapıldı" yapamazdı. **Adminin elle verdiği karar
> (`corrected_by` dolu) ezilmez**; yalnızca otomatik mührün üzerine yazılır ve
> `previous_status` ile izi kalır.

- **Satırda yazılan konu görünür:** ders görevinin başlığının altında
  *"İşlenen: Türev tanımı ve kurallar"* satırı çıkar (o haftanın
  `lesson_topics` kaydından okunur, göreve kopyalanmaz — konu düzeltilirse
  satır da düzelir).
- **Liste boşsa nedeni yazılır:** hesapta hiç ders görevi yoksa *"öğretmenin
  ... bu öğrenciyi seçip oluşturması gerekir"*, görev var ama bu haftaya
  düşmüyorsa *"N ders görevi var (tarih aralığı), hiçbiri bu haftaya
  düşmüyor"*. "Oluşturdum ama görünmüyor" vakasını sayfanın kendisi yanıtlar.
- **Öğrenci listesinde içinde bulunulan HAFTA'nın dersleri görünür.**
  Diğerleri silinmez: Haftalık Takvim, Yıllık Plan, haftalık analiz ve
  raporlarda kendi gününde görünür. (Öğretim yılı boyunca yüzlerce ders görevi
  açılır; hepsi listede dursaydı sayfa kullanılamazdı.)

  > ⚠️ Önce **"yalnızca bugün"** idi ve hafta sonu liste bomboş kalıyordu:
  > cumartesi bakan kullanıcı görevleri oluşturduğu hâlde hiçbir şey göremedi
  > (hafta içi çizelgede cumartesi ders yok). Hafta penceresi hem o boşluğu
  > kapatır hem de *"bu hafta hangi dersin konusunu yazmadım"* sorusunu
  > yanıtlar. Doğrulandı: cumartesi açılan liste haftanın 7 dersini
  > durumlarıyla gösterdi (1 ✓, 6 ✕); mühürlenmiş bir dersin konusu yazılınca
  > satır ✓'ya döndü ve sayaç 2 → 3 oldu.

> ⚠️ **Panel, çizelge boşken de görünmeli.** Önce "Ders Görevleri",
> "Defteri Kim Yazabilir" ve "Excel Çıktısı" panellerinin üçü de
> *"çizelge dolu"* dalının içindeydi: o haftada hiç ders yoksa şablon
> `<% } else { %>` dalına girmiyor ve paneller **tamamen kayboluyordu** — tam
> da durumu anlamak gereken anda. Kullanıcı "görev yok falan da yazmıyor"
> dedi. Paneller koşulun dışına alındı; ayrıca panel artık *"Bu haftanın
> çizelgesinde N ders saati var"* satırını yazıyor ve N=0 ise nedenini
> açıklıyor.

> ⚠️ **Açılır liste + tek düğme, görevlerin yanlış öğrenciye yazılmasına yol
> açtı.** Kullanıcı listeyi değiştirmeden düğmeye bastığı için görevler ilk
> öğrenciye gitti; kendi hesabında "Bu hesapta hiç ders görevi yok" gördü ve
> özellik çalışmıyor sanıldı. Panel artık **her öğrencinin kendi satırında
> kendi düğmesini** taşıyor (*"Görevleri Oluştur"* / *"Güncelle"*) — seçim
> hatası yapısal olarak kalktı.
>
> Aktarım biter bitmez `completeLessonTasks()` de çalışır: konusu **zaten
> yazılı** dersler anında "Yapıldı" olur, mühürleyici turu beklenmez.
> Doğrulandı: aktarım mesajı *"287 ders görevi eklendi … 2 görev, konusu
> yazılı olduğu için Yapıldı işaretlendi"* dedi ve öğrenci listesi
> *Tamamlanan 2 / Bekleyen 5* gösterdi.

**Panel her öğrencinin o haftaki durumunu ayrı satırda gösterir**
(*"Ayhan Test · Görev yok"* / *"Muhammed Gök · 7 ders · 2 konusu yazıldı"*).
Görevler yalnızca aktarım yapılan öğrenciye yazıldığı için "oluşturdum ama
görünmüyor" vakalarının en olası sebebi **yanlış öğrenci**; panel bunu artık
söylüyor. Öğrenci tarafındaki boş liste de neden boş olduğunu yazar.

Doğrulandı (7 ders saatlik çizelge, 14 Eylül'den itibaren): **287 ders görevi**,
205 güne yayıldı; başlıklar *"1. ders · Matematik"*, açıklamada zil saati +
sınıf. Açılışta geçmiş 7 ders görevi `not_done` mühürlendi; sonra **tek bir
dersin** konusu yazıldı ve o görev anında `done` oldu (`previous_status =
not_done`, not: *"İşlenen konu yazıldığı için otomatik işaretlendi."*). Bugüne
ders eklenip aktarım tekrarlandığında liste **40 yeni görev** ekledi; öğrenci
panelinde o günün dersi satır olarak çıktı ve konusu yazılınca ✓ oldu
(*Toplam 3 · Tamamlanan 2 · Bekleyen 1*).

### Öğretmen işareti (`users.is_teacher`)

Ders defteri **uygulama genelinde tek kayıttır** ve öğretmenin defteridir; bu
yüzden yazma varsayılan olarak admine kapalıdır. Ama uygulama sahibi aynı
zamanda kendi öğrenci hesabıyla giriyor — defteri doldurmak için hesap
değiştirmek zorunda kalmasın diye bir yetki bayrağı var.

- `users.is_teacher BOOLEAN NOT NULL DEFAULT FALSE`. **Rol değil bayrak**:
  hesap `student` olarak kalır, diğer bütün kısıtlar aynen sürer.
- Yönetimi: `/admin/schedule?gorunum=konular` → **Defteri Kim Yazabilir**
  paneli (`POST /admin/schedule/teacher`).
- İşaretli öğrencinin `/student/schedule?gorunum=konular` sayfası düzenlenebilir
  ızgaraya döner ve `POST /student/schedule/topics` açılır; işaretsiz öğrenci
  için ızgara salt okunur ve aynı rota **403**.
- Yazma gövdesi `saveLessonTopics(body)` yardımcısında; admin ve öğrenci
  rotaları **aynı** kodu çağırır, yetki kontrolü çağırana ait. Böylece
  "yalnızca çizelgede dersi olan + okul günü olan hücre yazılır" kuralı iki
  yolda da tek yerden gelir.
- Bayrak her istekte veritabanından okunur (`getCurrentUserById`), oturumda
  önbelleklenmez — yetki kaldırıldığı anda **açık oturumda da** kapanır
  (doğrulandı: kaldırma sonrası aynı çerezle POST 403, ızgara salt okunur).
- Çizelgeyi (ders/saat/sınıf) bu bayrak **açmaz**; o hâlâ yalnızca adminde.

### "Tamamlanan" sayacı ekranda görüneni sayar

`/student/dashboard` üstündeki üç sayaç (Toplam / Tamamlanan / Bekleyen)
listedeki **satırların** durumundan hesaplanır (`displayStatus === 'done'`).

> Önce yalnızca görev satırlarının **bugünkü** durumuna bakıyordu. Sonuç:
> rutin satırları hiç sayılmıyordu ve defter görevinin durumu kendi son
> tarihine (haftanın pazarı) yazıldığı için, satır ✓ görünürken sayaç
> "0 tamamlandı" diyordu. Doğrulandı: uyanma ✓ + defter ✓ + spor ○ →
> *Toplam 3 · Tamamlanan 2 · Bekleyen 1*.

## Uyanma rutini

Öğrenci her sabah **tek dokunuşla** işaretler; basılan saat kaydedilir.

- `wake_routines` (öğrenci başına tek satır): `target_time`, `tolerance_minutes`
  (0-240), `is_active`. Admin `/admin/wake` sayfasından ayarlar.
- `wake_logs` (gün başına tek satır, `UNIQUE (student_id, day)`): hedef saat ve
  tolerans **kaydın içine kopyalanır**, böylece rutin sonradan değişirse geçmiş
  değerlendirmeler bozulmaz.
- Durum: `on_time` (hedef + tolerans içinde), `late`, `missed`.
- **Gecikme toleransa göre değil hedefe göre ölçülür.** Tolerans "affedilen"
  süredir; 06:08'de kalkmak `on_time` sayılır ama `delay_minutes = 8` yazılır —
  ortalama uyanma saati bu veriden hesaplandığı için gizlenmemeli.
- **Geç basma da kaydedilir** (saatiyle). Uyanma denetiminde 06:01 ile 10:00
  arasındaki fark asıl veridir; ikisini de "yapılmadı" saymak bunu yok eder.
- Günde tek kayıt, **ilk basış geçerli** (`ON CONFLICT DO NOTHING`). İkinci basış
  reddedilir; aksi halde geç basıp erken basmış gibi görünmek mümkün olurdu.
- Hiç basılmayan günler `sealMissedWakeLogs` ile `missed` mühürlenir
  (`runSealSafely` içinde, açılışta + 5 dakikada bir, idempotent). Yalnızca
  **geçmiş** günlere dokunur — bugün hâlâ geç de olsa basılabilir. Rutin
  kurulmadan önceki günler geriye dönük mühürlenmez.
- Seri (`streak`): bugünden (bugün henüz `on_time` değilse dünden) geriye
  kesintisiz `on_time` gün sayısı.
- Rutin kaldırılınca `wake_logs` **silinmez** — geçmiş denetim verisi durur.
- Kart hem `/student/wake` sayfasında hem panonun tepesinde (`.wake-strip`)
  görünür: sabah uygulamayı açınca ilk iş ona basmak olmalı.

## Günlük spor rutini

Uyanma rutininin **kardeşi**: aynı "tek dokunuşla işaretle, basılan saati
kaydet" mantığı. Tek fark hedefin tek saat değil bir **aralık** olması
(varsayılan **06:15 - 06:30**).

- `sport_routines` (öğrenci başına tek satır): `start_time`, `end_time`,
  `is_active`. Admin `/admin/sport` sayfasından ayarlar; bitiş başlangıçtan
  sonra olmalı (rota kontrol eder).
- `sport_logs` (gün başına tek satır, `UNIQUE (student_id, day)`): aralık
  **kaydın içine kopyalanır**, rutin sonradan değişirse geçmiş bozulmaz.
- Durum: `on_time` (bitişe kadar), `late`, `missed`.
- **Gecikme bitişe değil başlangıca göre ölçülür.** Aralık "affedilen"
  süredir; 06:22'de basmak `on_time` sayılır ama `delay_minutes = 7` yazılır.
  Uyanmadaki hedef/tolerans kararının aynısı.
- **Erken yapmak geç kalmak değildir**: 05:40'ta basmak `on_time`, gecikme 0.
  Doğrulandı: 05:40→on_time/0, 06:15→on_time/0, 06:22→on_time/7,
  06:30→on_time/15, 06:31→**late**/16, 08:00→late/105.
- Günde tek kayıt, **ilk basış geçerli** (`ON CONFLICT DO NOTHING`).
- Basılmayan geçmiş günler `sealMissedSportLogs` ile `missed` mühürlenir
  (`runSealSafely` içinde, açılışta + 5 dakikada bir). Yalnızca **geçmiş**
  günlere ve **rutin kurulduktan sonrasına** dokunur.
- Rutin kaldırılınca `sport_logs` **silinmez** — geçmiş denetim verisi durur.
- Kart hem `/student/sport` sayfasında hem panonun tepesinde (uyanma
  şeridinin altında) görünür.
- Aylık hedeflerdeki "ayın kaydı" panosuna **Zamanında Spor** eklendi.
- **Haftalık analizde** de var: öğrenci karşılaştırmasında *Spor*
  (zamanında/toplam + oran, önceki haftaya göre puan farkı) ve *Ort. Spor*
  sütunları; gün kırılımında *Spor Saati* ve *Spor* durumu. Uyanma ile aynı
  turda çekilir (`BETWEEN prevWeekStart AND weekEnd`), trend için ikinci bir
  gidiş yok.

> Yapı olarak uyanma rutinine paralel yazıldı (ayrı tablolar, ayrı
> fonksiyonlar) — ortak bir "rutin" soyutlamasına çıkarmak canlı `wake_*`
> verisini taşımayı gerektirirdi. Bir üçüncü rutin gerekirse önce o soyutlama
> yapılmalı; iki kopya sınırdır.

### Elle kayıt (admin) — rutinlerin tek geri dönüşü

Öğrenci tarafında kural **değişmedi**: günde tek kayıt, ilk basış geçerli,
basılmayan geçmiş gün mühürlenir. Ama basmayı unutulan (ya da telefonun
yanında olmadığı) bir günün telafisi yoktu. Görevlerdeki **Durum Düzelt**
kapısının rutin karşılığı: `/admin/wake` ve `/admin/sport` sayfalarındaki
**Günlük Kayıtlar** tablosunda admin, her günün satırında saati elle yazar.

- Rota: `POST /admin/routines/:tur/log` (`tur` = `wake` | `sport`,
  `requireRole('admin')`; doğrulandı: öğrenci **403**, oturumsuz **302**).
  İşlemler: `set` (saat yaz), `missed` (kaçırıldı/yapılmadı), `clear` (sil).
- Gövde ortaktır; iki rutinin **farkları** `ROUTINE_KINDS` tablosunda durur
  (tablo adı, saat sütunu, ayar sütunları, değerlendirme fonksiyonu). Tablolar
  hâlâ ayrı — paylaşılan tek şey rota gövdesi.
- **Kapı sessiz değil.** Her yazma satırın içine işlenir: `corrected_by` /
  `corrected_at` / `previous_status` / `previous_time` / `correction_note`.
  Tabloda *"Elle yazıldı · Sistem Yöneticisi (Kaçırıldı → Zamanında 06:05) ·
  gerekçe"* olarak görünür. Gerekçe **opsiyonel** (görevlerdeki kararın aynısı:
  kim/ne zaman/ne üzerine zaten otomatik kaydediliyor).
- **Değerlendirme kaydın kendi kopyasına göre yapılır.** Satır zaten varsa
  (ör. mühürleyicinin yazdığı `missed`) hedef/tolerans ya da aralık o satırdan
  okunur; yoksa rutinin bugünkü ayarı kopyalanır. Rutin sonradan değişse de
  geçmiş bozulmaz. Rutin hiç yoksa yazılamaz (sütunlar NOT NULL) — rota
  *"rutin tanımlı değil"* der.
- **Gelecek güne yazılamaz**; **taban tarihten önceye de** (`SYSTEM_START_DATE`
  — açılıştaki temizlik o kayıtları zaten siler).
- **"Temizle" yalnızca kalıcı olduğunda açıktır.** Mühürleyici penceresine
  düşen geçmiş bir günün kaydı silinse 5 dakika içinde yeniden `missed`
  yazılırdı; panel düğmeyi göstermez, rota da reddeder ve *"bunun yerine saat
  girin"* der. Bugünün kaydı silinebilir (mühürleyici bugüne dokunmaz).
- Mühürleyiciler `ON CONFLICT DO NOTHING` kullandığı için admin'in yazdığı
  kayıt **ezilmez**; öğrencinin aynı güne basması da reddedilir (ilk kayıt
  geçerli).

Doğrulandı (16-19 Eylül, temiz rutinle): 06:20 → `late`/20, üzerine 05:55 →
`on_time`/0 ve `previous_status='late'`, `previous_time='06:20'`, gerekçe
kaydedildi; aynı değeri tekrar göndermek **reddedildi**; mühürlenmiş
*Kaçırıldı* günü 06:05 ile düzeltildi (`previous_status='missed'`) ve
**uygulama yeniden başlatıldıktan sonra mühürleyici onu ezmedi**; boş günü
temizlemek, gelecek gün, taban öncesi gün, geçersiz saat/işlem/tür ve olmayan
öğrenci **reddedildi**; mühürleyici penceresindeki geçmiş günün *Temizle*'si
**reddedildi**, bugünün kaydı silinebildi. Spor tarafında 06:22 → zamanında/7,
06:31 → geç/16, 05:40 → zamanında/0 (erken yapmak geç değildir). Admin bugüne
yazdıktan sonra öğrencinin basışı *"zaten kaydedilmiş"* dedi ve satır
değişmedi. Dört genişlikte (1440 / 1180 / 1024 / 390px) **sayfa taşması 0**.

> ⚠️ **Bu iş sırasında bulunan hata: `toDateOnly()` tarihleri bir gün geriye
> kaydırıyordu.** pg, `DATE` sütunlarını *yerel* gece yarısı olan bir `Date`
> nesnesi döndürür; `toISOString()` bunu UTC'ye çevirdiği için saat dilimi
> UTC'nin **ilerisinde** olan bir makinede (TZ=Europe/Istanbul) 17 Eylül kaydı
> ekranda 16 Eylül satırında çıkıyordu. Fonksiyon artık yerel parçalardan
> okuyor. Sunucu UTC iken davranış aynıdır — bu yüzden canlıda görünmüyordu,
> ama sunucunun TZ'si Istanbul yapılsaydı bütün tarihler kayardı.

> Tablo 7 sütuna çıktığı için `.routine-log-table` sınıfı geldi:
> `min-width: 820px` ve ilk beş sütunda `white-space: nowrap`. 1440 ve
> 1180'de kapsayıcıya sığar, daha dar masaüstünde kapsayıcı içinde yatay
> kaydırır (analiz tablolarındaki kabul edilen desen), telefonda `.stack-mobile`
> ile karta döner.

> Not: `adminRedirect`'in `next` beyaz listesinde `sport` ve `goals` yoktu;
> o sayfalardaki formlar `next="/admin/sport"` göndermesine rağmen kayıttan
> sonra panoya dönüyordu. Liste tamamlandı.

### Rutinler görev listesinde de görünür

Uyanma ve spor, panonun tepesindeki şeride **ek olarak** "Görevlerim"
tablosunda da birer satır olur — aynı sütunlar, aynı satır içi düzenleme.

- Satırlar `tasks` kaydı **değildir**; görünüm modelinde üretilen sahte
  satırlardır (`isRoutine: true`, id `routine-wake` / `routine-sport`).
  Yalnızca **bugün** gösterilir: rutin günlüktür, geçmiş günleri listeye
  doldurmak günlük görevleri boğardı.
- İki sütun farklı davranır: **Durum** rutinin kendi rozetini gösterir
  (Zamanında / Geç / Kaçırıldı + basılan saat + gecikme), **İşlem** ise tek
  bir "İşaretle" düğmesidir — görevlerdeki iki düğme değil.
- **Açıklama** `wake_logs.note` / `sport_logs.note` sütunlarında tutulur ve
  satır içi düzenlenir. Yazma rotası `POST /student/routines/:tur/note`;
  satır kendi uç noktasını `data-cell-endpoint` ile taşır, düzenleme betiği
  o varsa onu kullanır (yoksa görev rotası).

> Görevlerden ayrılan bir kural: **not işaretlemeyle kilitlenmez.** Rutin
> sabah basılır, not ise çoğu zaman sonra yazılır ("3 km koştum"). İşaretle
> kilitlemek alanı kullanılamaz hale getirirdi. Buna karşılık **basılmadan
> not yazılamaz** — yazılacak günlük kayıt henüz yoktur; rota 409 ile
> "Önce rutini işaretle" der. Yalnızca **bugünün** satırı yazılabilir.

#### Rutin satırları iki sütunu taşırıyordu

Rutin satırı eklenince tablo **taştı**; ölçüldü (1440px): *Son Saat* +36px,
*Durum* +55px. Sebep, görev satırı için doğru olan iki kuralın rutinde
geçerli olmaması:

- `.single-line-cell` ve `.status-cell` `white-space: nowrap` taşıyor. Görevde
  oraya `07:30` gibi **kısa ve sabit biçimli** bir değer giriyor; rutinde ise
  hedef + tolerans (`06:00 (+10 dk)`), aralık (`06:15 - 06:30`) ya da rozetin
  yanında basılan saat + gecikme (`07:00 · 60 dk gecikme`) var.
- *Son Saat* sütunu 72px sabit; yatay dolgu düşülünce içeriye **39px** kalıyor.

Çözüm yalnızca **rutin satırlarına** (`.student-task-row.routine-row`)
kapsandı — normal görev satırlarının `nowrap`'ine dokunulmadı:

1. İki hücrede `white-space: normal`, ayrıntı (`<small>`) alt satıra.
2. *Son Saat* değeri **anlamlı yerden** ikiye bölünür: üst satır asıl saat
   (`routineSaatAna` → `06:00` / `06:15`), alt satır ayrıntı
   (`routineSaatAlt` → `+10 dk` / `→ 06:30`). Tek parça bırakılınca tarayıcı
   `(+10` / `dk)` gibi anlamsız yerlerden kırıyordu.
3. O hücrenin **sağ dolgusu** 4px'e iner (içerik 39px → 52px) ve ayrıntı
   satırı 12px'e küçülür; böylece `→ 06:30` (49px) tek satırda durur. Sol
   dolgu korunur — saat, görev satırlarındaki saatle aynı hizada başlar.

Doğrulandı (1440 / 1180 / 390px, işaretli ve işaretsiz durumda, görev
satırlarıyla birlikte): hücre taşması **0**, sayfa taşması **0**; görev
satırında `07:30` ve `-` eskisi gibi tek satır; telefonda kart hücresi `flex`
olduğu için saat ve ayrıntı yan yana kalıyor.

Doğrulandı: işaretlemeden önce satırlar listede "İşaretle" düğmesiyle çıkıyor
ve açıklama kapalı; işaretledikten sonra rozet *"Geç · değiştirilemez"*,
basılan saat ve gecikme görünüyor, açıklama **açılıyor** ve yazılan not
kaydediliyor. İşaretlemeden not 409; admin → rota **403**; oturumsuz 302;
geçersiz tür 404; rutini olmayan başka öğrenci kendi kaydı olmadığı için
yazamıyor ve mevcut not değişmiyor.


## Aylık hedefler

`/admin/goals` — öğrenci başına aylık hedefler. Hedefler **serbest metindir**;
uygulama onları kendi ölçmez. Bu bilinçli bir seçimdi (ölçülebilir metrik
hedefler yerine), o yüzden "kanıt" iki şekilde sağlanır:

1. **"Başarıldı" işaretlemek için kanıt metni zorunludur** — rota boş kanıtı
   reddeder. Yoksa kayıt kuru bir "yaptım" beyanı olurdu.
   *"Başarılamadı"* için kanıt istenmez: orada kanıtlanacak bir iddia yok.
2. Hedeflerin üstünde **o ayın gerçek kaydı** durur (`buildMonthFacts`):
   tamamlanan görev / toplam, tamamlama oranı, çözülen soru, doğruluk,
   çalışma süresi, zamanında uyanma. Elle yazılan kanıt bu sayılarla
   karşılaştırılabilir olsun diye.

- `monthly_goals`: `student_id`, `month_start` (ayın 1'i, `DATE`), `title`,
  `description`, `status` (`pending` | `achieved` | `missed`), `evidence`,
  `evaluated_at`, `evaluated_by`. `UNIQUE (student_id, month_start, title)` —
  aynı ay aynı başlıkta ikinci hedef açılmaz.
- **Hedefi yalnızca admin koyar ve değerlendirir.** Öğrenci `/student/goals`
  sayfasında yalnızca **görür**: hedef, durum rozeti, kanıt metni ve ayın
  kaydı. Öğrenci görünümü `buildMonthlyGoalsView`'a **yalnızca kendisini**
  içeren bir öğrenci listesi geçer; bu yüzden `?goalStudentId=` ile başka
  öğrencinin hedefine bakılamaz (doğrulandı: başkasının hedefi 0 kez geçiyor,
  beş admin rotası 403).
- Ay gezinme `?ay=YYYY-MM` ile; `normalizeMonthStart` hem `YYYY-MM` hem
  `YYYY-MM-DD` kabul edip ayın 1'ine indirger.
- Veri olmayan yerde oran `null` döner ve `-` gösterilir — `%0` ile
  karıştırılmamalı.

> Not: "Başarılamadı" işaretlerken kanıt alanı boş gönderilirse daha önce
> yazılmış kanıt silinir. Arayüzde alan mevcut kanıtla dolu geldiği için bu
> kazara olmaz; bilerek temizlenebilsin diye de böyle bırakıldı.

## Haftalık analiz

`/admin/analysis` — "Haftalık Analiz" sayfası. `buildWeeklyAnalysis(weekStart,
studentId)` bir haftanın metriklerini üretir:

- **Öğrenci karşılaştırması**: kişi başına görev tamamlama oranı, çözülen
  soru, doğruluk (%), çalışma süresi, **uyanma** (zamanında/toplam + oran) ve
  ortalama kalkış saati; tamamlama ve uyanma oranında **önceki haftaya göre
  puan farkı**.
- **Seçili öğrenci için kırılım**: kategori bazında ve gün bazında aynı
  metrikler. Gün satırları `academicCalendar` etiketini, ayrıca o günün
  kalkış saatini ve uyanma durumunu taşır. Uyanma kategoriye bağlı olmadığı
  için kategori tablosunda yer almaz.
- Uyanma ve spor ortalamaları yalnızca **basılan** günlerden hesaplanır
  (`missed` günler paydaya girmez); zamanında oranının paydası ise kayıt
  girilmiş tüm günlerdir.
- Veri olmayan yerde oran `null` döner ve arayüzde `-` gösterilir — `%0` ile
  karıştırılmamalı (veri yok ≠ başarısız).

Sorgular tek turda hem içinde bulunulan hem önceki haftayı çeker
(`BETWEEN prevWeekStart AND weekEnd`), trend için ikinci bir gidiş yok —
`wake_logs` de aynı desenle aynı turda çekilir.

## Açılış öncesi doğrulama (2026-09-14)

Öğretim yılının başladığı pazartesiye karşı tüm zincir, sahte saatle
(`FAKE_NOW`) ileri sarılmış **temiz bir veritabanında** uçtan uca çalıştırıldı.
Doğrulananlar:

- **Takvim:** 11-13 Eylül `outside`, **14 Eylül `school`**, 1. Dönem 2026-09-14
  → 2027-01-22. İlk altı haftada tatil/bayram yok.
> Not: Bu doğrulama YZ ve YDS programları hâlâ varken yapıldı; o iki madde
> 19 Eylül revizyonunda geçersizleşti (bkz. Proje). Kalanlar geçerli.

- **Uyanma / Spor:** tek dokunuş kaydediyor; erken basış `on_time` + gecikme 0;
  basılmayan geçmiş günler mühürleniyor.
- **Ders defteri:** çizelge girilince 37 haftalık görev açıldı, 1. hafta son
  tarihi **20 Eylül Pazar**. Haftanın tüm hücreleri dolunca görev `done`
  işaretlendi — süresi geçmiş olmasına rağmen `not_done` olmadı (sıralama
  doğru). Öğrenci listesinde yalnızca içinde bulunulan haftanınki görünüyor.
- **Öğretmen bayrağı:** işaretli öğrenci haftanın konularını yazabildi; yalnızca
  çizelgede dersi olan ve okul günü olan hücreler kaydedildi.
- **Yetki sınırları:** öğrenci → admin Excel çıktısı 403, admin → öğrenci
  çıktısı 403. Tüm öğrenci ve admin sayfaları 200.
- **Dağıtım:** `devDependencies` yok; `npm ci --omit=dev` tüm çalışma zamanı
  bağımlılıklarını kuruyor. Production'da oturum PG store'a yazılıyor
  (`createTableIfMissing`), `trust proxy` açık. Tarih/saat **`Europe/Istanbul`**
  varsayılanından geliyor; sunucunun TZ ayarına bağlı değil.

### Sistem taban tarihi (`SYSTEM_START_DATE`)

Sistem öğretim yılından önce kurulup denendi; öncesinde kalan görevler,
durumlar, rutin kayıtları ve defter satırları gerçek bir geçmiş değil **kurulum
artığı**. `SYSTEM_START_DATE` (ortam değişkeni, varsayılan **`2026-09-14`**)
uygulamanın kaydının başladığı gündür ve iki iş yapar:

1. **Mühürleme bu tarihten öncesine hiç inmez.** Uyanma/spor mühürleme tabanı
   `max(rutinin kurulduğu gün, SYSTEM_START_DATE)`; görev mühürleme penceresi
   `max(geriye bakış, AUTO_LOCK_START_DATE, SYSTEM_START_DATE)`. Rutin
   görünümleri de gün listesini burada keser.
2. **Açılışta öncesi silinir** (`purgeBeforeSystemStart`, `runSealSafely`
   içinde, mühürlemeden **önce**). Tek işlemde çalışır, idempotenttir.

Silinenler: `wake_logs`, `sport_logs`, `task_statuses`, `task_detail_notes`,
`lesson_topics` (`week_start <`), tek seferlik `tasks` (`single_date <`;
durum ve notları CASCADE ile gider), `monthly_goals` (yalnızca taban ayından
**önceki** aylar — içinde bulunulan ay durur) ve `daily_questions`.

**Dokunulmayanlar (bilinçli):**

- **Tekrarlı görevler** (`repeat_type <> 'once'`) — `start_date`'i eski olan
  aktif bir görev silinmemeli. Taban öncesi örnekleri zaten `task_statuses`
  ile gidiyor.
- `users`, `categories`, `class_schedule`, ayar tabloları — tarihe bağlı değil.

`SYSTEM_PURGE=off` ile temizlik kapatılabilir.

> ⚠️ **Silme ile mühürleme birbiriyle savaşabilir.** İlk sürümde temizlik
> çalışıyor, hemen ardından `sealOverdueTaskStatuses` silinen günlere yeniden
> satır yazıyordu — ölçüldü: 06-13 Eylül için **9 satır geri geldi**. Çünkü
> mühürleme penceresi yalnızca `AUTO_LOCK_START_DATE`'e (2026-09-06) bakıyordu.
> Bu yüzden pencere artık `SYSTEM_START_DATE`'i de hesaba katıyor. Yeni bir
> otomatik yazıcı eklenirse aynı tabanı uygulamalı, yoksa temizlik boşa gider.

> ⚠️ **Tek pg bağlantısında eşzamanlı sorgu çalıştırılmaz.** Silmeler önce
> `Promise.all` ile yazılmıştı; `client.query()` kuyruğa alıyor ama pg 9'da
> kaldırılacak ve uyarı basıyor. Silmeler **sıralı** çalışır.

Doğrulandı (cutoff'un iki yanına serpiştirilmiş veriyle): 14 Eylül öncesi
`tasks`, `task_statuses`, `wake_logs`, `sport_logs`, elle girilen soru
kayıtları, `lesson_topics` ve Ağustos hedefi **tamamen silindi (hepsi 0)**;
YDS ayna soru kaydı, `yds_days`, tekrarlı görev, 14 Eylül sonrası görev ve
Eylül hedefi **korundu**. İkinci açılışta hiçbir şey silinmedi, mesaj çıkmadı,
deprecation uyarısı yok. Tüm öğrenci ve admin sayfaları 200.

## Güncellemeler ve veri korunumu

Kurallar süreç içinde değişebilir; **değişiklik geçmişi silmez.** Uygulama
genelinde tek bir desen var: *karar kaydın içine kopyalanır, geçmiş mühürlüdür,
yalnızca gelecek yeniden düzenlenir.*

| Ne değişiyor | Ne olur | Doğrulandı |
|---|---|---|
| Uyanma hedefi (06:00 → 06:30, tolerans) | Geçmiş `wake_logs` satırları kendi hedef/tolerans kopyasını taşıdığı için **hiç değişmez** | ✅ eski kayıt 06:00/10 olarak kaldı |
| Spor aralığı (06:15-06:30 → 07:00-07:45) | Geçmiş `sport_logs` satırları kendi aralığını taşır | ✅ eski kayıt 06:15-06:30 kaldı |
| Rutin tamamen kaldırılır | `wake_logs` / `sport_logs` **silinmez** | ✅ 39 satır yerinde kaldı |
| Defter görevleri yeniden aktarılır | Yeni hafta eklenir, **işaretlenmemiş ve günü gelmemiş** görevler tazelenir/silinir | ✅ geçmiş ve işaretli hiç oynamıyor |
| Ders çizelgesi değişir | `lesson_topics` kaydın içine ders/sınıf adını kopyaladığı için geçmiş defter okunabilir kalır | ✅ ders silinip değiştirildikten sonra defter durdu |
| Admin bir görev durumunu düzeltir | Satır değişir ama **izi kalır** (`corrected_by` / `corrected_at` / `previous_status` / gerekçe); öğrenci tarafı hâlâ kilitli | ✅ yeniden açılışta mühürleyici ezmedi |
| Admin bir rutin kaydını elle yazar | Satır değişir ama **izi kalır** (+ `previous_time`); değerlendirme kaydın kendi hedef/aralık kopyasına göre yapılır | ✅ mühürleyici ezmedi, öğrencinin basışı reddedildi |
| Bir hafta özelleştirilir / varsayılana döndürülür | Yalnızca o haftanın `class_schedule` satırları değişir; **işlenen konular silinmez** (ders/sınıf adı kaydın içinde) | ✅ döndürme sonrası defter satırları durdu |

> Tek istisna bilinçli: aylık hedefte "Başarılamadı" işaretlerken kanıt alanı
> boş gönderilirse eski kanıt silinir (bkz. Aylık hedefler).

Yeni bir "program" ya da "rutin" eklerken aynı desen izlenmeli: değerlendirmeyi
belirleyen ayar **kaydın içine kopyalanmalı**, silme/taşıma **yalnızca
işaretlenmemiş ve günü gelmemiş** satırlara dokunmalı.

> ⚠️ **19 Eylül revizyonu bu desenin bilinçli istisnasıdır.** YZ/YDS görevleri
> ve yds.obs aynası, işaretli olsalar bile **silindi** — kullanıcı programların
> tamamen iptalini istedi ("içerikleri silebilirsin"). Silinen şey geçmişin
> kaydı değil, artık izlenmeyen iki programın kendisiydi. Uyanma/spor kayıtları
> ve defter geçmişi bu silmeden **etkilenmedi**.

## Çalışırken dikkat

- Canlı sistem; davranış değiştiren PR'larda önce lokalde doğrula.
- Test yok; `npm test` placeholder (hata döndürür).
- `app.js` tek dosya — değişiklik yaparken çevredeki idiom ve yardımcı fonksiyonları (`asyncHandler`, `makeId`, `normalizeText`, validasyonlar) kullan.
