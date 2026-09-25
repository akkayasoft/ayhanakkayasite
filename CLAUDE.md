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

> **Rutinler (uyanma, spor, namaz, yapay zeka, YDS) görev ÜRETMEZ —
> bilinçli.** `tasks` kaydı açmazlar; işaretleme kendi sayfalarında olur.
> (19 Eylül'de kaldırılan **YZ programı** görev üreten bir müfredat
> aktarımıydı; bu onun yerine geçmez, bir rutindir.)
>
> **Ama Görevlerim tablosunda GÖRÜNÜRLER:** görünüm modeli, rutinlerin günlük
> kayıtlarından **sahte satırlar** üretir (hafta hafta; bkz. *Rutinler görev
> listesinde de görünür*). Namaz günde 5 vakit olduğu için **günde tek özet
> satır** olur (*"2/5 vaktinde · 1 kaza · …"*); işaretleme yine kendi
> sayfasında. Namaz "Tamamlandı" sayacına yalnızca **beş vaktin de vaktinde
> kılındığı** günde girer.

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
  menu.js           menü satırları + her sayfanın ALANLARI (tek kaynak)
  menuIcons.js      kenar çubuğu ve kart ikonları (SVG)
  views/            admin.ejs, student.ejs, login.ejs
  public/           styles.css, dist/ (React island'ları)
scripts/            deploy-hostinger.sh  (ARTIK KULLANILMIYOR — bkz. Deploy)
```

Roller: `admin`, `student`. Auth middleware `requireAuth` / `requireRole(role)`.

## Sayfa alanları ve açılır menü

**Her sayfa TEK ALAN gösterir.** Önce her sayfa bütün panellerini alt alta
basıyordu: Ders Programı tek ekranda 6, Uyanma Rutini 4 panel gösteriyordu ve
sayfa okunmaz haldeydi (kullanıcı: *"sayfalar çok karışık … ben bir sayfada bir
alan görmek istiyorum"*). Sayfanın diğer alanları iki yerden açılır:

1. **Kenar çubuğunda uçan liste** — menü satırının üzerine gelince (ya da
   klavyeyle odaklanınca) o sayfanın alanları sağda açılır.
2. **İçeriğin tepesindeki alan sekmeleri** — aynı listeyi her genişlikte
   gösterir. Telefonda hover olmadığı için tek yol budur; masaüstünde de
   *"hangi alandayım"* sorusunu sayfanın kendi içinde yanıtlar.

- **Tek kaynak `src/menu.js`**: menü satırları, ikonları ve her sayfanın alan
  listesi orada. Şablon karar vermez — görünüm modeline `menuTree` (aktiflik ve
  bağlantılar hesaplanmış), `currentSection` ve `currentSectionLabel` geçer.
- Alan seçimi **`?bolum=<anahtar>`** ile gelir. Tanımsız ya da geçersiz değer
  **ilk alana düşer**; yani bölümsüz eski bağlantılar (`/admin/wake`) kırılmaz.
- `sections` tanımlanmamış sayfa (Genel Durum, Raporlar, Görevlerim, Haftalık
  Takvim) tek alanlıdır ve menü satırı düz bir bağlantıdır.
- **Görevler** sayfasının iki alanı zaten ayrı rotada (`/admin/tasks/active`,
  `/admin/tasks/status`); bölüm tanımı `href` taşır ve `?bolum=` kullanılmaz.
- **Ders Programı'nda `gorunum` parametresi kalktı**: defter alanları
  (`konular` / `gorevler` / `defter` / `excel`) konular ızgarasını, diğerleri
  çizelgeyi hesaplar (`scheduleGorunum`). Eski `?gorunum=konular` bağlantıları
  hâlâ çalışır.
- **Bağlantılar ve form dönüşleri alanı korur.** Hafta/ay gezinmesi
  `?bolum=<%= currentSection %>` taşır; form `next`'leri kullanıcıyı doğru alana
  götürür (ekleme formları sonucun göründüğü **listeye**, düzenleme işlemleri
  bulundukları alana). Aksi halde her kayıttan sonra ilk alana fırlatılırdı.
  Çizelge ızgarasındaki boş hücre **Ders Ekle**'ye, karşılaştırma tablosundaki
  öğrenci adı **Kategori Kırılımı**'na, rutin listesindeki öğrenci **Günlük
  Kayıtlar**'a gider — alanı değiştirmeselerdi tıklama görünür bir şey
  değiştirmezdi.

> ⚠️ **Sayfa bağlamı alan değildir.** Sayfa başlığı, KPI özet şeridi, öğrenci/ay
> seçicisi ve boş durum kartları **her alanda görünür**; bölünen şey içerik
> panelleridir. Ders Programı'nda "Haftanın Ders Özeti" şeridi bu yüzden duruyor.

> ⚠️ **Uçan liste menüyü aşağı itmez, ÜSTÜNE açılır** (`position: absolute`).
> İtseydi imlecin altındaki satırlar kayar ve yanlış satıra tıklanırdı. Menünün
> alt ucundaki satırlarda (`:nth-last-child(-n+4)`) liste **yukarı** açılır;
> yoksa 11 alanlı Ders Programı listesi ekranın altından taşar ve imleç listeye
> ulaşamadan kaybolurdu. `:focus-within` de açar: klavyeyle gezenler alt
> alanlara ulaşamazdı.

> ⚠️ **Alan bölünce boş ekran çıkabilir.** Rutini olmayan öğrencide *Günlük
> Kayıtlar* alanı bomboş kalıyordu (eskiden uzun sayfanın dibinde fark
> edilmiyordu); artık nedenini ve nereye gideceğini yazan bir kart çıkıyor.

Telefonda uçan liste hiç açılmaz; menü şeridi ve alan sekmeleri **yatay
kaydırır** (11 alanlı sayfada sarma 5 satır tutup ekranın yarısını içerikten
önce harcıyordu).

Doğrulandı: admin 34 + öğrenci 18 adres **200**; her alan tek panel gösteriyor
ve doğru sekme aktif; geçersiz `?bolum=` ve bölümsüz eski bağlantı ilk alana
düşüyor; zil saatleri / ders ekleme / zil çizelgesi kayıtları kendi alanlarına
dönüyor; uçan liste 11 alanı ekran içinde açıyor (y 106-514, taşma yok);
1440 ve 390px'te sayfa taşması **0**, konsol hatası yok.

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

  > ⚠️ **Bir menüde iki satır aynı ikonu taşımamalı** — menünün okunurluğunun
  > büyük kısmı ikonlardan geliyor. YDS Rutini eklenince öğrenci menüsünde
  > *Ders Programı* ile *YDS Rutini* ikisi de `yds`'yi (açık kitap)
  > kullanıyordu. Ders Programı iki panelde de yeni `timetable` ikonuna
  > geçti; YDS'de açık kitap kaldı.
  >
  > `timetable` ilk denemede "yuvarlatılmış dikdörtgen + başlık çizgisi" idi
  > ve 16px'te `schedule` (Haftalık Takvim) ile `program` (Yıllık Plan)
  > ikonlarından **ayırt edilemiyordu** — üçü de aynı kutuya benziyordu.
  > Çerçeve ve başlık atıldı, çizgilerden örülmüş sade bir ızgara kaldı.
  >
  > Ölü ikonlar da silindi: `newTask` (kaldırılan "Görev Ekle" sayfası) ve
  > `money` (kaldırılan puan sistemi). Kontrol: her ikon ya bir menü
  > satırında ya da `menuIcons.<ad>` olarak şablonda geçmeli.
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

### Çizelge Pzt-Cum (hafta sonu çizelgeden çıkarıldı)

> ⚠️ **Sonradan geri alındı: ders programı yeniden Pzt-Cum.** Bir dönem hafta
> sonu da eklenmişti (aşağıdaki geçmiş bunu anlatır); kullanıcı hafta sonunu
> **ders programından çıkarttı**. `schedule.GUNLER = [1,2,3,4,5]` — Ders
> Programı ızgarası, **Gün Özeti**, **İşlenen Konular** panosu ve **ders
> görevleri** artık yalnızca Pzt-Cum. Gün seçicileri (Ders Ekle, Gün Gün Zil
> Saatleri) ve toplu yapıştırma da Pzt-Cum; **yapıştırmada Cumartesi/Pazar
> satırları reddedilir**.
>
> Kapsam **bilinçli olarak dar**: hafta sonu yalnızca *çizelge/defter*ten
> çıktı. **Haftalık Takvim yine 7 gün** gösterir (gerçek tarihleri gezer,
> `GUNLER`'i kullanmaz) ama hafta sonu günlerine **ders düşmez** — bu yüzden
> `dayOfWeek()`, `GUN_ADLARI` ve DB'nin 1-7 kısıtı 6/7'yi hâlâ tanır
> (aşağıdaki 7-günlük altyapı bu yüzden duruyor).
>
> **Veri silinmedi:** DB'de kalmış eski Cumartesi/Pazar (`day_of_week` 6-7)
> ders kayıtları ve o günlere yazılmış işlenen konular **durur** ama `GUNLER`
> dışında oldukları için ızgarada, sayaçlarda, defterde, ders görevlerinde ve
> takvim ders listesinde **görünmez** (view'lerde `GUNLER.includes` ile
> elenir). Hafta sonu yeniden istenirse `GUNLER`'e 6,7 eklemek yeterli.

Aşağısı hafta sonunun **eklendiği** dönemin geçmişidir; 7-günlük altyapının
(dayOfWeek 6/7, DB 1-7 kısıtı) neden hâlâ durduğunu açıklar.

Program önce **Pzt-Cum** idi; hafta sonuna ders koyan bir düzen (DYK, ek ders,
hafta sonu kursu) programa hiç girilemiyordu. O dönem çizelge **7 güne**
çıkarılmıştı.

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

**Zil saatleri hesaplanır; güne özel saat elle girilebilir**
(`src/schedule.js`). Varsayılan düzen ayardan türetilir: her ders saatinin
başlangıç-bitişi başlangıç saati + ders/teneffüs/öğle sürelerinden gelir.
Böylece "8. ders kaçta" sorusunun tek doğru cevabı olur ve saatler tek tek
girilirken kaymaz. Sayfada günün bitiş saati gösterilir; kullanıcı süreleri
tutturana kadar ayarlar (08:00 + 10 ders × 40 dk + 10 dk teneffüs + 6. dersten
sonra 40 dk öğle = 16:40).

### Gün gün zil saatleri (elle giriş)

Bu düzen **bütün günler için** geçerliydi; oysa her gün aynı değil (ikili
öğretim, DYK, kısa cuma, telafi). `/admin/schedule` → **Gün Gün Zil Saatleri**
panelinde bir gün seçilip o günün ders saatleri **elle** yazılır.

- `period_times` (`PRIMARY KEY (day_of_week, period)`): `start_time`,
  `end_time`. Satır **yalnızca istisnadır** — tablo boşken davranış eskisiyle
  birebir aynıdır, her gün hesaplanan çizelgeyi kullanır.
- **Elle giriş satır bazındadır: sonraki saatleri KAYDIRMAZ.** Kaydırsaydı tek
  bir düzeltme günün geri kalanını sessizce değiştirirdi; oysa elle giriş tam
  da *"bu saat diğerlerine uymuyor"* demek.
- **Boş satır = varsayılana dön** (kayıt silinir). Varsayılanla **birebir aynı**
  saat de saklanmaz: saklansaydı süreler sonradan değiştiğinde o hücre eski
  saatte donar ve kimse nedenini bilemezdi. *"Bu Günü Varsayılana Döndür"*
  düğmesi günün tüm istisnalarını tek hamlede siler.
- Bir alanı doldurup diğerini boş bırakmak **reddedilir** — girilen saatin
  kaydedilmediğini fark etmemek en kötü sonuç olurdu. Bitiş başlangıçtan sonra
  olmalı (veritabanı `CHECK`'i de aynı kuralı tutar).
- Günlük ders saati sayısı küçültülürse kapsam dışı kalan `period_times`
  satırları da silinir (`class_schedule` ile aynı kapsam).

> ⚠️ **Saat artık satırın değil HÜCRENİN özelliği.** Izgarada soldaki saat
> sütunu **varsayılan** düzeni gösterir; bir hücrenin saati elle
> değiştirilmişse hücre **kendi saatini** yazar (`.board-cell-time.ozel-saat`).
> Hücre içi saat masaüstünde normalde gizlidir (soldaki sütun zaten gösteriyor);
> istisna için açılmasaydı masaüstünde **yanlış saat** okunurdu.

Zil saatini kullanan her yol güne duyarlı hale geldi: haftalık takvimdeki gün
kartları, çizelge ızgarası, defter ızgarası, **ders görevi açıklaması**
(*"09:00-09:45 · 11-A"*) ve İşlenen Konular **Excel çıktısı**. Gün Özeti'ne
günün gerçek penceresini veren **Saat Aralığı** sütunu eklendi — elle girilen
saatler düzeni bozabildiği için ilk/son dersin saati değil **en erken başlangıç
- en geç bitiş** olarak hesaplanır.

> Ders görevi açıklaması aktarım anında yazılır: saatler değiştikten sonra
> görevlerin güncellenmesi için o öğrencinin **"Güncelle"** düğmesine basmak
> gerekir (işaretlenmemiş + günü gelmemiş görevler tazelenir).

Doğrulandı (lokal, 20 Eylül): Cuma 1-2. ders 09:00-09:45 / 09:55-10:40 elle
girildi → çizelge ızgarası, öğrenci çizelgesi, defter ızgarası ve haftalık
takvim o saatleri gösterdi, diğer günler **değişmedi**; Gün Özeti *Cuma
09:00 - 16:40 · 2 saat elle* yazdı. Aktarım tekrarlanınca Cuma görevinin
açıklaması `08:00-08:40` → `09:00-09:45` oldu, Pazartesi görevleri aynı kaldı;
aktarım yapılmayan **diğer öğrencinin** görevi de dokunulmadan kaldı. Cumartesi
1. ders 13:00-13:45 girildi ve Excel çıktısındaki o satır 13:00 - 13:45 geldi
(Pzt/Sal satırları 08:00 - 08:40). Tek alan dolu, ters saat ve geçersiz gün
**reddedildi**; varsayılanla aynı saat **kayıt açmadı** (*"0 saat elle
girildi"*); *Varsayılana Döndür* günü temizledi, ikinci basış **reddedildi** ve
sayfa *"hiçbir gün için elle saat girilmemiş"* dedi. Öğrenci **403**, oturumsuz
**302**, öğrenci → `/admin/schedule` **403**. 1440 / 390px'te sayfa taşması
**0**, hücre taşması 0, konsol hatası yok; telefonda panel kart etiketleri
(*Ders Saati / Başlangıç / Bitiş / Varsayılan*) doğru.

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

- **Liste GÜN GÜN okunur:** satırlar tarihe göre sıralanır ve her yeni günün
  başına bir başlık bandı girer — *"PAZARTESİ · 2026-09-14 · 2 görev ·
  1 tamamlandı"*, bugünse "Bugün" rozetiyle. Aynı gün içinde önce rutinler
  (sabah), sonra ders saatleri gelir; ders sırası başlık metninden değil
  `source_key`'deki sayıdan okunur ("10. ders" metinsel sıralamada "2. ders"in
  önüne düşerdi).
  - Başlık satırı tablo satırıdır (`colspan`), böylece mobil kart dönüşümü ve
    filtreler bozulmaz. Filtre çalışınca **tüm satırları gizlenen günün başlığı
    da gizlenir**.
  - `display:flex` doğrudan `td`'ye verilince hücre table-cell olmaktan çıkıp
    `colspan`'i yok sayıyor ve başlık ilk sütuna sıkışıyordu; flex artık
    içerideki `.day-group-inner`'da.
  - Mobil etiket betiği (`thead`'den `data-label` üretir) **colspan'li
    hücreleri atlar**; yoksa başlığın üstüne "Tarih" etiketi yapışıyordu.
- **Satırda yazılan konu, kendi sütununda:** *İşlenen Konu / Not* sütununda
  o ders saatine yazılan konu görünür (yazılmadıysa *"Konu yazılmadı"*).
  Görevin künyesi (zil saati, sınıf) başlığın altındaki küçük satıra indi;
  üretilen açıklamadaki *"işlenen konuyu yaz"* kalıbı kaldırıldı.
  - Konu `lesson_topics`ten okunur, göreve **kopyalanmaz** — konu
    düzeltilirse satır da düzelir.
  - Ders görevinde bu sütun **elle düzenlenemez** (`canEditDescription`
    kapalı): kaynağı İşlenen Konular ekranıdır. Rutin satırlarında aynı sütun
    öğrencinin kendi notudur, düzenlenebilir.
  - **Admin "Görevler" tablosu da aynı düzendedir**: *Konu* sütunu *İşlenen
    Konu* oldu, künye başlığın altına indi. Konular her satır için ayrı ayrı
    sorgulanmaz — `lesson_topics` **tek sorguda** okunup
    `hafta:gün:saat` anahtarlı bir haritaya konur (`konuHaritasi`), satırlar
    `source_key`'den türetilen anahtarla eşlenir.
    > Admin görev sorgusu `source_key` **seçmiyordu**; bu yüzden ilk denemede
    > başlıklar değişti ama satırlar eski açıklamayı gösterdi. Görünüm modeli
    > bir alanı kullanacaksa sorguya da eklenmeli.
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
> verisini taşımayı gerektirirdi. İkisinin **ortak tek parçası** rota
> gövdesidir (`ROUTINE_KINDS`, elle kayıt); gerisi ayrı durur.
>
> ⚠️ Eski not "bir üçüncü rutin gerekirse önce soyutlama yapılmalı" diyordu.
> Gelen üçüncü istek (namaz) **aynı şeklin üçüncüsü değil**, başka bir şekil
> çıktı: günde beş kayıt, saatten hesaplanmayan durum, üç durum. Soyutlamaya
> zorlamak `ROUTINE_KINDS`'ı ("gün başına tek satır + saat sütunu + ayardan
> hesaplanan durum") tanınmaz hale getirirdi. Bu yüzden namaz kendi modelini
> kullanıyor. Kural şöyle okunmalı: **aynı şeklin üçüncüsü gelirse** önce
> soyutlama.
>
> ⚠️ Nitekim öyle oldu: **yapay zeka rutini** namazla aynı şeklin ikincisi
> çıktı ve ortak çekirdek (`canAdvanceDeclaredStatus` + `.state-*` sınıfları)
> o noktada çıkarıldı — ama yalnızca gerçekten ortak olan kadarı. Ardından
> **YDS rutini** yapay zekanın *birebir* aynısı çıkınca motor `STUDY_KINDS`
> ile parametrelendi ve yapay zeka da ona taşındı. Bkz. *Üç durumlu beyan
> rutinleri* ve *Planlı günlük çalışma rutinleri*.

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

### Rutinler görev listesinde de görünür (hafta hafta)

Uyanma, spor, **yapay zeka, YDS ve namaz**, panonun tepesindeki şeride
**ek olarak** "Görevlerim" tablosunda da satır olur.

- Satırlar `tasks` kaydı **değildir**; görünüm modelinde üretilen sahte
  satırlardır (`isRoutine: true`, id `routine-<tür>-<gün>`). Tümü
  `buildRoutineWeekRows` yardımcısından gelir.
- **İçinde bulunulan haftanın (Pzt-Paz) her günü** için bir satır; rutinin
  kurulduğu günden (`createdDay`) ve `SYSTEM_START_DATE`'ten öncesine inmez.
  > Önce yalnızca **bugün** ve yalnızca uyanma/spor gösteriliyordu ("geçmiş
  > günleri doldurmak listeyi boğar" kaygısıyla). Kullanıcı önce tüm rutinleri
  > tarihe göre istedi (hafta penceresi, ders görevleriyle aynı, gün gün
  > başlıklarla); namaz ilk turda dışarıda tutuldu, sonra **günde tek özet
  > satır** olarak eklendi.
- **Gün durumuna göre davranır:**
  - **Geçmiş gün:** kilitli, kendi durumuyla (uyanma/spor: Zamanında/Geç/
    Kaçırıldı; YZ/YDS: Yapıldı/Yapılmadı/Telafi). YZ/YDS'de *yapılmadı* günde
    **İşlem = "Telafi →"** (kendi sayfasına gider).
  - **Bugün:** uyanma/spor **satır içi tek dokunuş** ("İşaretle" düğmesi, ilk
    basış geçerli); YZ/YDS üç durumlu olduğu için **"İşaretle →"** bağlantısı.
  - **Gelecek gün:** **"Bekliyor"**, işlem yok.
- **Namaz `tip: 'prayer'`** ile özel: günde 5 vakit tuttuğu için **tek özet
  satır**. Durum hücresinde gün kırılımı yazar (*"2/5 vaktinde · 1 kaza ·
  2 kılınmadı"*, `buildPrayerView` gün özetinden). Satır içi işaretlenmez;
  **bugün bekleyen vakit varsa "İşaretle →"**, **geçmişte kılınmayan varsa
  "Kaza →"** kendi sayfasına gider. "Son Saat" sütununda saat yerine
  *"5 vakit"* (namazın hedef saati yok). **"Tamamlandı" sayılması yalnızca
  beş vaktin de vaktinde kılındığı günde** olur (seri ölçüsüyle aynı); aksi
  hâlde nötr (kırmızı yapılmaz).
- **"Bugünün Özeti" KPI'si (Toplam/Tamamlanan/Bekleyen) yalnızca BUGÜNÜ sayar**
  (`bugunOzet`). Liste artık tüm haftayı gösterdiği için tüm listeyi saymak
  "bugün" etiketiyle çelişirdi; gün bazlı sayaç zaten her gün başlığında.
- **Açıklama (not)** yalnızca **uyanma/spor'da ve yalnızca bugün** (kayıt varsa)
  satır içi düzenlenir; `wake_logs.note` / `sport_logs.note`, rota
  `POST /student/routines/:tur/note`. YZ/YDS satırında not düzenlenmez.

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


## Üç durumlu beyan rutinleri (ortak çekirdek)

Namaz ve yapay zeka rutinleri **aynı şekli** paylaşır:

- durum saatten **hesaplanmaz**, kullanıcı **beyan eder**;
- üç durum vardır: yapıldı / yapılmadı / sonradan telafi edildi;
- *"yapılmadı"* kapanmış bir son **değildir**: tek bir ileri geçişe izin
  verilir (`canAdvanceDeclaredStatus`).

| Mevcut | İzin verilen |
|---|---|
| kayıt yok | üçü de |
| yapılmadı | **telafi** |
| yapıldı | — (kapandı) |
| telafi edildi | — (kapandı) |

`yapılmadı → yapıldı` **yasak**: geçmişe dönük *"aslında yapmıştım"* beyanı;
kaydın değeri dürüstlüğünden geliyor, düzeltmesi adminde.

> ⚠️ **Ortak olan yalnızca bu kural ve kelime dağarcığıdır** — `sozluk`
> parametresiyle her rutin kendi anahtarlarını verir (namaz:
> `missed → qada`, yapay zeka: `not_done → makeup`). Tablolar ve görünüm
> kurucular **ayrı** durur: namaz günde beş kayıt tutar, yapay zeka bir;
> namazın ayarı yok, yapay zekanın günlük planı var. İkisini tek motora
> sokmak o farkları bayrak enflasyonuna çevirirdi.
>
> CSS'te durum düğmeleri ve rozetleri de ortaktır (`.state-button`,
> `.state-pill`, `.state-actions`, `.state-fix`); iki sözlüğün sınıf adları
> aynı renklere eşlenir. Beş vakitlik kart ızgarası (`.prayer-*`) yalnızca
> namaza aittir.

## Planlı günlük çalışma rutinleri (yapay zeka · YDS)

Yukarıdaki şeklin ikinci ve üçüncü örneği. **Birbirinin aynısıdırlar** —
farkları yalnızca tablo adları, etiketler ve varsayılan saat:

| | Yapay Zeka | YDS |
|---|---|---|
| Varsayılan pencere | **06:30 - 07:30** | **20:00 - 21:00** |
| Tablolar | `ai_routines` / `ai_logs` | `yds_routines` / `yds_logs` |
| Yollar | `/admin/ai`, `/student/ai` | `/admin/yds`, `/student/yds` |

Namazdan iki farkları var: günde **bir** kayıt tutarlar ve bir **planları**
vardır.

### Tek motor: `STUDY_KINDS`

YDS geldiğinde üçüncü bir kopya yazmak yerine motor `kind` ile
parametrelendi — CLAUDE.md'nin *"aynı şeklin üçüncüsü gelirse önce
soyutlama"* kuralının tam olarak işaret ettiği durum. Tek bir tanım
(`STUDY_KINDS`) sürer:

- **Model:** `getStudyRoutine` · `sealMissedStudyLogs` · `buildStudyView` ·
  `studyEffectiveMinutes` · `wouldStudySealerRewrite`.
- **Rotalar** tür üzerinde bir **döngüde** kurulur (admin ayar/sil/elle
  kayıt, öğrenci işaretle/süre) — beş rota × iki tür.
- **Şablonlar tek**: öğrenci sayfası `studyView`, admin sayfası `studyAdmin`
  alır ve hangi türde olduğunu bilmek zorunda değildir; etiket, yollar ve
  plan görünüm modelinden gelir. Pano şeridi `studyStrips` üzerinde döner.
- **Analiz** de tür başına döngüdür: metrikler `metrik.study[tür]` altında,
  sütunlar `studyKinds.forEach`.

> ⚠️ **Tablo adları SQL'e doğrudan gömülür** (tablo adı `$1` ile verilemez).
> Güvenli, çünkü değerler **yalnızca** bu sabit haritadan gelir: rota yolları
> döngüde bağlanır, tür adı **istekten gelmez**. Yeni bir tür eklenirse aynı
> kural korunmalı.

> ⚠️ **Namaz bu motora girmez.** Günde beş kayıt tutar ve planı yoktur;
> sokmak motoru bayrak enflasyonuna çevirirdi. Ortak olan yalnızca üç durumlu
> beyan çekirdeğidir (`canAdvanceDeclaredStatus`, `.state-*`).

> ⚠️ **Tablolar ayrı tutuldu** (tek tabloda `tur` sütunu yerine): iki rutin
> birbirinden bağımsız açılıp kapanır ve birleştirmek her sorguya bir filtre
> borcu yüklerdi.

- `<tür>_routines`: `start_time`, `minutes` (varsayılan **60**), `is_active`. **Bitiş saati saklanmaz, hesaplanır**
  (`aiWindowEnd`) — "kaçta biter" sorusunun tek doğru cevabı olsun diye
  (zil saatlerindeki kararın aynısı).
- `<tür>_logs`: `UNIQUE (student_id, day)`; `status` ∈ *done, not_done,
  makeup*. `done_at` basılan saat, `makeup_day` / `makeup_at` **telafinin
  hangi gün ve saatte yapıldığı** — telafi başka bir gün yapıldığı için ayrı
  tutulur.
- **Plan kaydın içine kopyalanır** (`start_time`, `minutes`): plan sonradan
  değişse de geçmiş okunabilir kalır (uyanma/spordaki desenin aynısı).

> ⚠️ **Planlı saat geçince gün KAPANMAZ.** Mühürleyici yalnızca **geçmiş**
> günlere iner; bugün gün sonuna kadar açık kalır. 22:00'de yapılan çalışma
> da o günün çalışmasıdır — gün içinde mühürlemek onu yazılamaz hale
> getirirdi. Plan değerlendirmeyi belirlemez, yalnızca *"bugün ne
> yapacağım"ı* söyler.

**Gün kuralı** namazla aynı: bugün üç seçenek, geçmişte yalnızca **telafi**,
geleceğe ve **rutin kurulmadan öncesine** hiçbiri. Geçmiş listesi de rutinin
kurulduğu günde biter.

**Elle kayıt (admin):** `/admin/<tür>` → *Günlük Kayıtlar*; her günün satırında
durum seçici + gerekçe. `POST /admin/ai/log`; gelecek güne ve taban tarihten
öncesine yazılamaz, *"Kaydı sil"* yalnızca mühürleme penceresi dışında açık,
her yazma `corrected_by` / `corrected_at` / `previous_status` /
`correction_note` ile saklanır.

**Arayüz:** öğrenci `/student/<tür>` → *Bugün* (tek kart, üç düğme, planı
yazar) ve *Son Günler* (gün · plan · durum · telafi düğmesi). Panodaki şerit
namazdan farklı olarak **doğrudan işaretler** — günde tek kayıt olduğu için
tek düğme yeter.

**Haftalık analizde:** karşılaştırmada her tür için bir sütun
(`yapıldı/kayıtlı gün` + oran + trend, altında çalışılan saat, telafi sayısı
ve kaç günde gerçek süre girildiği), gün kırılımında durum rozeti + dakika,
özet kartlarında *Yapay Zeka (yapıldı)* ve *YZ Çalışma Süresi*. Çalışılan
süre gerçek girdilerden toplanır, girilmemiş günlerde plana düşer (bkz.
*Gerçek çalışılan dakika*).

### Gerçek çalışılan dakika

`<tür>_logs.actual_minutes` (**NULL olabilir**) gerçekte kaç dakika çalışıldığını
tutar. Plandan ayrı durur: plan *"bugün ne yapacağım"*, bu sütun *"gerçekte ne
kadar yaptım"*.

- **Girmek opsiyoneldir ve boş bırakmak geçerli bir cevaptır** (NULL — sıfır
  değil). Öğrenci *"Yapıldı"*ya bastığında uygulamanın bildiği tek şey işin
  yapıldığıdır, kaç dakika sürdüğü değil. Bu yüzden alan **varsayılan olarak
  boştur**; plan değerini otomatik yazmak, girilmemiş bir sayıyı ölçülmüş gibi
  gösterirdi.
- **Raporlar plana düşer ve bunu söyler.** `aiEffectiveMinutes(log)` gerçek
  girildiyse onu, girilmediyse planı sayar; her yerde ayrıca **kaç günde
  gerçek süre girildiği** yazar (öğrenci özeti, admin özeti, karşılaştırma
  sütunu, özet kartı). Gün kırılımında plandan sayılan değerin yanında
  *(plan)* etiketi durur. Sayının nereden geldiği görünür kalmalı.
- **Süre DURUM gibi kilitlenmez.** İş sabah işaretlenir, kaç dakika sürdüğü
  çoğu zaman sonra yazılır — uyanma/spor notundaki kararın aynısı. Rota
  `POST /student/<tür>/minutes`; yalnızca `done` / `makeup` günlerine yazılır
  (*"yapılmadı"* günde yazılacak süre yoktur), boş göndermek temizler.
  İşaretleme formunda da opsiyonel bir alan olarak duruyor.
- Admin `/admin/<tür>/log` formundan da süre yazabilir. Durum aynı kalıp yalnızca
  süre değiştirilmek istenirse bu **geçerli bir istektir** — yoksa *"gün zaten
  o durumda"* deyip süreyi yutardık. Bir gün `not_done`'a çevrilirse süre
  **temizlenir** (yazılacak süre kalmadı).
- Sınır **1-1440 dakika** (veritabanı `CHECK`'i de aynı kuralı tutar).

> ⚠️ **Bu iş sırasında bulunan tutarsızlık: bayat düzeltme izi.** Düzeltme
> alanları (`corrected_by` / `previous_status` / …) *"bu satır şu anki
> durumunu nasıl aldı"*yı anlatır ve **yalnızca admin** yazar. Admin bir günü
> *"Yapılmadı"* yapıp öğrenci sonradan telafi işaretleyince iz yerinde
> kalıyor ve ekranda *"Telafi edildi → Telafi edildi"* gibi kendisiyle çelişen
> bir satır çıkıyordu. Öğrencinin izinli geçişi artık izi **temizler**; aynı
> düzeltme namazdaki `missed → qada` geçişine de uygulandı.

Doğrulandı: süre yazma / değiştirme / temizleme çalışıyor; yapılmamış güne
süre, 0, 2000, metin ve gelecek gün **reddedildi**; işaretlerken girilen süre
kaydediliyor (*"Telafi edildi · 50 dk"*); admin süresi yazıyor ve `not_done`'a
çevirince süre temizleniyor; analiz 260 dk'yı **4.3 saat** ve *"3 gün gerçek
süre"* olarak gösteriyor. Admin → `/student/ai/minutes` **403**, oturumsuz
**302**; yazma `student_id`'ye kapalı (başka öğrencinin satırı değişmiyor).
19 adres **200**; 1440 / 390px'te taşma **0**, telefonda kart etiketleri
(*Gün / Plan / Durum / Çalışılan Süre / İşlem*) doğru.

Doğrulandı (YDS eklendikten sonra): **yapay zeka rutini bozulmadı** —
5 kayıt ve 3 gerçek süre girdisi yerinde, sayfa aynı çalışıyor. YDS rutini
20:00-21:00 / 60 dk açıldı; `Yapıldı · 70 dk` yazıldı, kapanmış güne yazma ve
geçmişe "yapıldı" **reddedildi**; mühürleyici YDS için 3 gün yazdı ve yapay
zeka kayıtlarına **dokunmadı** (iki tür bağımsız). Menüde iki rutin ayrı
satır, panoda iki ayrı şerit. Analizde iki ayrı sütun (*YZ 1/4 · %25 · 4.5
saat*, *YDS 1/4 · %25 · 1.2 saat*), gün kırılımında ikisi ayrı ayrı, dört
özet kartı. Öğrenci → admin YDS rotaları **403**, admin → öğrenci **403**,
oturumsuz **302**. 35 adres **200**; 1440 / 390px'te sayfa taşması **0**,
telefonda kart etiketleri doğru.

> ⚠️ İki hata bu refaktörde yakalandı. (1) Rota döngüsü modül yüklenirken
> çalışıyor ama `STUDY_KINDS` daha aşağıda tanımlıydı — *temporal dead zone*;
> blok motorun arkasına alındı. (2) Gün kırılımı satırında `study: gunStudy`
> (kayıt haritası) `...ozetle(gun)`'un döndürdüğü `study` **metrik**
> nesnesiyle çakışıyordu ve hücreler boş kalıyordu; kayıt haritası
> `studyLogs` olarak ayrıldı.

Doğrulandı (yapay zeka, 24 Eylül): rutin 06:30-07:30 / 60 dk açıldı. Geçişler:
`not_done → done` **reddedildi** (*"yalnızca telafisi işaretlenebilir"*),
`not_done → makeup` **kabul**, ikinci telafi reddedildi, kapanmış kayda
yazma reddedildi. Gün kuralları: gelecek, geçmişe "yapıldı", rutin öncesi ve
geçersiz durum **reddedildi**; mühürlenmiş geçmiş günün telafisi **kabul**
ve `makeup_day` bugünü yazdı. Mühürleyici 4 gün yazdı, bugüne dokunmadı,
ikinci açılışta **0**. Adminin `not_done → done` düzeltmesi izini bıraktı ve
yeniden açılışta **ezilmedi**; aynı durumu tekrar yazmak, mühürleme
penceresindeki günü silmek, gelecek gün ve geçersiz işlem **reddedildi**.
Öğrenci → admin rotaları **403**, admin → `/student/ai` **403**, oturumsuz
**302**. Rutini olmayan öğrencide *"Kayıt yok"* kartı. Analizde 4 kayıtlı
günün 1'i yapıldı → *1/4 · %25*, *"3 saat · 2 telafi"*, trend **▲25**.
26 adres **200**; 1440 / 390px'te sayfa taşması **0**.

> ⚠️ Admin kayıt tablosunda önce `.routine-log-table` kullanılmıştı; o sınıf
> uyanma/sporun **7 sütunlu** tablosu için yazılmış (820px min-width, ilk
> **beş** sütunda `nowrap`) ve 4 sütunlu bu tabloda "Durum" ile "Elle Yaz"
> hücrelerini de sarmasız yapıp telefonda **145px taşırıyordu**. Düz
> `.stack-mobile` yeterli.

## Günlük 5 vakit namaz rutini

Yukarıdaki şeklin ilk örneği; uyanma/spor rutinlerinin **üçüncüsü değil,
başka bir şekli**. Üç temel fark:

| | Uyanma / Spor | Namaz |
|---|---|---|
| Gün başına kayıt | 1 | **5** (her vakit ayrı) |
| Durum nereden gelir | saatten **hesaplanır** | kullanıcı **beyan eder** |
| Durumlar | zamanında / geç / kaçırıldı | **vaktinde kılındı / kılınmadı / kazası kılındı** |

- `prayer_routines` (öğrenci başına tek satır): yalnızca `is_active`.
  **Hedef saat yok** — vakit saatleri güne ve konuma göre kayar; uygulama
  onları bilmiyor ve uydurmamalı. Uydurulmuş bir hedefe göre "geç kaldın"
  demek kaydı bozardı. Bu yüzden kayda kopyalanacak bir ayar da yok.
- `prayer_logs`: `UNIQUE (student_id, day, prayer)`; `prayer` ∈ *sabah, öğle,
  ikindi, akşam, yatsı*. `marked_at` basılan saat (yalnızca bilgi),
  `qada_day` / `qada_at` **kazanın hangi gün ve saatte kılındığı** — kaza
  başka bir gün kılındığı için ayrı tutulur, yoksa *"dünün ikindisini bugün
  kıldım"* kaydı kaybolurdu.

### Tek izinli geçiş: kılınmadı → kazası kılındı

Uyanma/spordaki *"ilk basış kalıcıdır"* kuralı burada **tek** bir geçişe izin
verir. Kazanın anlamı zaten budur; yasaklansaydı üçüncü durum sussuz kalırdı.

| Mevcut | İzin verilen |
|---|---|
| kayıt yok | vaktinde · kılınmadı · kaza |
| kılınmadı | **kaza** |
| vaktinde | — (kapandı) |
| kazası kılındı | — (kapandı) |

- `missed → on_time` **yasak**: geçmişe dönük *"aslında vaktinde kılmıştım"*
  beyanı. Kaydın değeri dürüstlüğünden geliyor; düzeltmesi adminde.
- Arayüz bunu ayırt eder: "kılınmadı" için *"yalnızca kazası işaretlenebilir"*
  der, kapanmış vakit için *"değiştirilemez"*. Aynı mesajı vermek kullanıcıya
  vakti kapalı sandırırdı.

### Gün kuralı

- **Bugün:** üç seçenek de açık.
- **Geçmiş:** yalnızca **kaza**. Geçmişe "vaktinde kıldım" yazmak yukarıdaki
  yasağın aynısı.
- **Gelecek:** hiçbiri.
- **Rutin kurulmadan öncesi:** hiçbiri. O günler hiç takip edilmedi;
  mühürleyici de oraya inmiyor. Tek başına bir kaza satırı, diğer dört vaktin
  hiç kaydı olmadığı bir günde yanıltıcı olurdu. Geçmiş listesi de aynı yerde
  biter — yoksa takip edilmemiş günler *"Bekliyor"* görünüp olmayan bir borç
  gibi okunuyordu (ölçüldü: rutin 4 günlükken liste 11 gün gösteriyordu).

### Mühürleme

`sealMissedPrayerLogs` (`runSealSafely` içinde, açılışta + 5 dakikada bir,
idempotent) geçmiş günlerin işaretlenmemiş vakitlerine **kılınmadı** yazar —
gün başına 5 satır. Yalnızca **geçmiş** günlere ve **rutin kurulduktan
sonrasına** dokunur; taban tarihten (`SYSTEM_START_DATE`) öncesine inmez.

> Mühürlenen kayıt **kapanmış değildir**: kazası sonradan işaretlenebilir.
> Uyanma/spordaki mühürden farkı bu.

### Elle kayıt (admin) — namaz rutininin tek geri dönüşü

`/admin/prayer` → **Günlük Kayıtlar**: her (gün, vakit) hücresinde durum
seçici + gerekçe alanı. `POST /admin/prayer/log`; öğrenci **403**, oturumsuz
**302**.

- Her yazma satırın içine işlenir: `corrected_by` / `corrected_at` /
  `previous_status` / `correction_note`. Hücrede *"Elle yazıldı · Sistem
  Yöneticisi (Kılınmadı → Vaktinde kılındı) · gerekçe"* görünür.
- **Gelecek güne** ve **taban tarihten öncesine** yazılamaz.
- *"Kaydı sil"* yalnızca kalıcı olduğunda açıktır: mühürleyici penceresine
  düşen geçmiş bir günün kaydı silinse 5 dakika içinde yeniden yazılırdı
  (rutinlerdeki `wouldRoutineSealerRewrite` ile aynı karar).
- Mühürleyici `ON CONFLICT DO NOTHING` kullandığı için adminin yazdığı durum
  **ezilmez**.

### Haftalık analizde

Uyanma ve spor gibi namaz da haftalık analize girer, ama **paydası gün değil
VAKİT sayısıdır** (günde beş).

- **Öğrenci karşılaştırması** → *Namaz* sütunu: `vaktinde/kayıtlı vakit` +
  oran ve önceki haftaya göre puan farkı; kaza varsa altında
  *"N kaza · kılınan %M"*.
- **Gün kırılımı** → *Namaz* sütunu: o günün `N/5 vaktinde` rozeti, altında
  kaza ve kılınmadı sayısı. Tek rozet yetmezdi — gün beş vakitten oluşuyor.
- **Özet kartları**: *Namaz (vaktinde)* ve *Namaz (kaza dahil)*.

> **İki ayrı oran bilinçli.** `prayerOnTimeRate` asıl ölçü;
> `prayerDoneRate` kazayla birlikte kılınanları gösterir. Tek orana indirmek
> kazayı ya görünmez yapardı ya da vaktinde kılmışla eşitlerdi.

> **Payda "kaydı olan vakit"tir, 5 değil.** Bugünün henüz işaretlenmemiş
> vakitleri paydaya girmez (gün içinde *1/3* görünür); gün bitince
> mühürleyici kalanları yazar ve payda 5'e tamamlanır. Sabit 5 alınsaydı
> yaşanmakta olan gün hep başarısız görünürdü.

- Namaz günde beş satır tuttuğu için sorgu satırları taşımaz, **gün bazında
  saydırır** (`count(*) FILTER (WHERE status = …)`), ve uyanma/sporla **aynı
  turda** çekilir — trend için ikinci bir gidiş yok.

> ⚠️ **Bu iş sırasında bulunan hata: toplam satırında spor hiç birikmiyordu.**
> `totals` indirgemesi yalnızca görev/soru/uyanma alanlarını topluyordu;
> spor alanları her zaman 0 kalıyordu. Ekranda spor toplamı gösterilmediği
> için görünmüyordu — namaz KPI'si eklenirken aynı hatayı tekrarlamamak için
> ikisi birlikte tamamlandı ve *Spor (zamanında)* kartı da eklendi.

Doğrulandı (21-27 Eylül haftası): 18 kayıtlı vakitte 2 vaktinde / 3 kaza /
13 kılınmadı → *2/18 · %11.1*, kaza satırı *"3 kaza · kılınan %27.8"*, trend
önceki haftaya göre **▲11.1** (o hafta 5 vaktin tamamı kılınmamıştı). Gün
kırılımı 21-24 Eylül'ü doğru kırdı (*0/5 · 5 kılınmadı*, *0/5 · 1 kaza ·
4 kılınmadı*, *1/5 · 4 kılınmadı*, *1/3 · 2 kaza*), kayıt olmayan günler
*"-"*. Rutini olmayan öğrenci **"-"** gösteriyor. Öğrenci → `/admin/analysis`
**403**. 1440 / 390px'te sayfa taşması **0**; iki analiz tablosu kapsayıcı
içinde yatay kaydırıyor (gün kırılımı 1440'ta 316px — kabul edilen desen),
telefonda kart etiketi *Namaz* doğru.

### Arayüz

- **Öğrenci** `/student/prayer`: *Bugün* alanında beş vakit beş kart, her kart
  kendi düğmelerini taşır (`.prayer-grid` / `.prayer-card`); *Son Günler*
  alanında gün × vakit tablosu ve kılınmayan her vakitte **Kazasını Kıldım**
  düğmesi.
- **Seri** = beş vaktin de **vaktinde** kılındığı kesintisiz gün sayısı. Kaza
  seriyi kurtarmaz; kurtarsaydı "vaktinde" ölçüsü anlamını yitirirdi.
- Panodaki şerit **özet** gösterir, işaretleme yapmaz: 5 vakit × 3 durum = 15
  düğme şeride sığmazdı.
- Durum rengi kartın **sol kenarında**; arka planı boyamak içindeki
  düğmelerin kontrastını bozuyordu. Gün sütununda `.single-line-cell`
  yetmedi (bu tabloda gün adı *"Perşe mbe"* diye kırılıyordu), sütuna açık
  genişlik + `nowrap` verildi.

Doğrulandı (lokal, 24 Eylül): rutin açıldı; bugünün vakitleri vaktinde /
kılınmadı / kaza olarak işaretlendi. Geçiş kuralları: `on_time` ve `qada`
üzerine her yazma **reddedildi**, `missed → on_time` **reddedildi**,
`missed → qada` **kabul edildi**, ikinci kaza basışı reddedildi. Gün
kuralları: gelecek gün, geçmişe "vaktinde", taban öncesi ve rutin öncesi gün
**reddedildi**; geçmiş güne kaza **kabul edildi** ve `qada_day` bugünü yazdı.
Mühürleyici rutin başlangıcından bugüne 4 gün × 5 vakit = **20 satır**
"kılınmadı" yazdı, bugüne dokunmadı; ikinci açılışta **0** satır yazdı.
Adminin `missed → on_time` düzeltmesi izini bıraktı (`previous_status`,
düzelten, gerekçe) ve **yeniden açılışta mühürleyici ezmedi**; aynı durumu
tekrar yazmak, mühürleme penceresindeki günü silmek, gelecek gün, taban
öncesi, geçersiz vakit ve geçersiz işlem **reddedildi**. Öğrenci → admin
rotaları **403**, admin → `/student/prayer` **403**, oturumsuz **302**.
Rutini olmayan öğrencide *"Kayıt yok"* kartı çıkıyor. 43 adres **200**;
1440 / 390px'te sayfa taşması **0**, tablo kaydırması 0, telefonda kart
etiketleri (*Gün / Sabah / Öğle / İkindi / Akşam / Yatsı*) doğru.

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
  soru, doğruluk (%), çalışma süresi, **uyanma** (zamanında/toplam + oran),
  ortalama kalkış saati, **spor**, **namaz** (vaktinde/kayıtlı vakit + oran)
  ve **planlı çalışma rutinlerinin her biri** (yapay zeka, YDS —
  yapıldı/kayıtlı gün + oran, çalışılan saat); tamamlama, uyanma, spor, namaz
  ve her çalışma rutininin oranında **önceki haftaya göre puan farkı**. Namazın paydası gün değil vakittir — bkz. *Günlük 5 vakit
  namaz rutini → Haftalık analizde*.
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
`wake_logs`, `sport_logs`, `prayer_logs` ve planlı çalışma rutinlerinin
tabloları da aynı desenle aynı turda çekilir. `prayer_logs` günde beş satır tuttuğu için satırları taşımak yerine
**gün bazında saydırılır**.

Tablolar namaz + iki çalışma rutini sütunuyla 16 ve 17 sütuna çıktı;
`min-width` değerleri 1560 / 1660px'e yükseltildi (kapsayıcı içinde yatay kaydırma,
telefonda `.stack-mobile` ile karta dönüş aynen duruyor).

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
| Bir günün zil saatleri elle girilir | Yalnızca o günün o ders saatleri değişir; diğer günler ve sonraki saatler yerinde kalır. Görev açıklamaları bir sonraki aktarımda tazelenir | ✅ Cuma değişti, Pazartesi aynı kaldı |
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
