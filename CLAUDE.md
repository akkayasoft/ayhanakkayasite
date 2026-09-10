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
form), `calendar`, `questions`, `wake` (Uyanma Rutini), `schedule` (Ders
Programı — **salt okunur**). Görev ekleme formu ile aktif görev listesi
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

## Yapay zekâ programı (yapayzeka.obs → takip.obs)

`akkayasoft/uretken-yz-platform` müfredatı (149 ders) 2026-2027 takvimine
yayılıp görev olarak aktarılır.

- **Program dosyası:** `src/data/yzProgram.json` — commit edilir.
- **Üretim:** `node scripts/yz-program-uret.js --platform /yol/uretken-yz-platform`
  Platform deposundaki `dersler.py`'yi okur, `academicCalendar`'dan ders
  günlerini alır; tatil/bayram günü atlanır. Hafta düzeni **otomatik**:
  müfredat sığıyorsa Pzt-Per (4 ders/hafta), sığmıyorsa Cuma da açılır
  (5 ders/hafta). `--gunler 1,2,3` ile elle zorlanabilir.
- **Aktarım:** admin panelinde **YZ Programı** sayfası → "Görevlere Aktar".
  Her ders `tasks.source_key` (`yz:<dersId>`) ile işaretlenir.
- **Tek kategori: `Yapay Zeka`.** Önce her kurs ayrı kategoriydi (24 tane) ve
  kategori listesi YZ kurslarıyla doluyordu. Kurs adı kaybolmaz — görev
  açıklamasının ilk parçası hâlâ kurs adıdır (`describeLesson`), YZ Programı
  sayfasındaki "Kurs Bazında Dağılım" tablosu da aynen durur.
- **Idempotent:** `(student_id, source_key)` üzerinde partial unique index var.
  Platforma yeni ders eklenince programı yeniden üret, commit'le, aynı düğmeye
  bas — yalnızca yeni dersler eklenir.
- Görevler `estimated_time` olmadan yazılır; otomatik kilit son saati gün sonu
  (23:59) kabul eder.

Aktarım tekrar çalıştırıldığında üç şey birden olur:

1. **Yeni dersler** görev olarak eklenir.
2. **Kategori adı değiştiyse** (platformda kurs adı düzeltilince) mevcut
   kategori *yeniden adlandırılır* — ikinci bir kategori açılmaz. Eşleşme
   kategori adına değil, o kursun daha önce aktarılmış derslerinin
   `source_key`'ine bakılarak yapılır.
3. **Ders tarihi kaydıysa** (ör. 4 ders/hafta → 5 ders/hafta) görev programa
   hizalanır — ama yalnızca **işaretlenmemiş ve günü gelmemiş** görevler
   taşınır. İşaretli veya geçmiş bir görev asla oynatılmaz; kaç görevin
   sabit kaldığı mesajda bildirilir.

> Not: 2. madde artık kategori **birleştirmesi** olarak çalışır. Kurs başına
> kategori döneminden kalan görevler tek kategoriye taşınır, boşalan eski
> kategoriler silinir. Hangi kategorilerin "YZ kategorisi" olduğu **ada göre
> tahmin edilmez** — hâlâ `yz:` görevi tutan kategorilerin kimliğine bakılır;
> elle açılmış bir kategori yanlışlıkla toplanmasın diye. Silme de koşulludur:
> kategoriye bağlı başka bir görev ya da **soru kaydı** varsa silinmez
> (`daily_questions.category_id` ON DELETE SET NULL — silmek o kaydın
> kategorisini kaybettirirdi), kaç tanesinin durduğu mesajda bildirilir.
> Doğrulandı: 24 kategori → 1; 23 silindi, soru kaydı bağlı olan 1 tanesi
> korundu, işaretli görev durumları bozulmadı, ikinci basışta hiçbir şey
> değişmedi.

## YDS / YÖKDİL takibi (yds.obs → takip.obs)

`akkayasoft/yds-yokdil-app` (Expo/React Native, `https://yds.obs.akkayasoft.com`)
ilerlemesi takip.obs'a **yansıtılır**. YZ programının tersi yön: orada takip.obs
planı üretip görev *iter*, burada uygulama kendi günlük paketini zaten üretir,
takip.obs sonucu *okur*.

- **Kaynak:** YDS uygulaması cihazlar arası senkron için VPS'te minik bir Node
  servisi çalıştırır (`server/yds-api`, `127.0.0.1:3210`) ve kullanıcı başına tek
  JSON tutar. **İki uygulama aynı sunucuda** olduğu için takip.obs dosyayı
  doğrudan okur — HTTP'ye de Basic Auth şifresini burada saklamaya da gerek yok.
- `YDS_STATE_FILE` (varsayılan `/var/www/yds-api/data/state-ayhan.json`)
- `YDS_STUDENT_USERNAME` (varsayılan `ayhan`) — verinin yazılacağı öğrenci.
- **Okuma:** `src/ydsSync.js`. Dosya biçimi YDS tarafındaki `app/src/sync.ts`
  `Blob` tipidir; uygulama tek yazıcıdır.
- **Yansıtma:** `syncYdsProgress()` — `runSealSafely` içinde (açılışta + 5
  dakikada bir) ve `/admin/yds` sayfasındaki "Şimdi Çek" düğmesiyle. Idempotent.
- `yds_days` — günlük kırılım (okuma/kelime/gramer/test sayıları, çözülen soru,
  hedef tuttu mu).
- `daily_questions` — çözülen sorular `source_key = 'yds:<tarih>'` ile yazılır
  (partial unique index; elle girilen satırlarda `source_key` NULL kalır).
  Böylece Soru Takibi ve **Haftalık Analiz** ek kod olmadan dolar.

> ⚠️ **Doğruluk yalnızca puanlı testlerden gelir.** YDS tarafında 9 dilbilgisi
> testi `scored: false`, yalnızca 2 preposition testi puanlı. Bu yüzden
> `correct + wrong = scoredQuestions ≤ questionsSolved`. Çözülen gerçek toplam
> `count` sütununda durur; puansız soruları "yanlış" saymak veriyi bozardı.
> Sonuç: puansız test çözülen bir gün Haftalık Analiz'de "0 soru" görünür.
> Kalıcı çözüm yukarı akışta — YDS deposunda dilbilgisi testlerine cevap
> anahtarı eşlenmesi (README'de bilinen iş olarak duruyor).

### Sıfırlama yayılımı

YDS uygulamasındaki **"İlerlemeyi sıfırla"** sunucu durumunu boşaltır ve bir
`resetAt` damgası bırakır; diğer cihazlar bu damgayı görüp kendilerini temizler.
takip.obs aynası da bir "cihaz" gibi davranır:

- `yds_sync.source_reset_at` en son uygulanan damgayı tutar. Dosyadaki `resetAt`
  bundan **büyükse** o öğrencinin `yds_days` satırları ve `source_key LIKE 'yds:%'`
  olan `daily_questions` satırları silinir, sonra yeni durum yazılır.
- Silme **yalnızca damga ilerlediğinde** olur, her senkronda değil (idempotent).
- **Dokunulmayanlar**: elle girilen soru kayıtları (`source_key` NULL), YDS
  çalışma programı görevleri (`ydsp:`) ve öğrencinin takip.obs'ta kendi
  işaretlediği görev durumları. Bunlar YDS ilerlemesi değil, bu uygulamanın
  kendi kaydıdır.
- Uygulanan sıfırlamanın zamanı `yds_sync.reset_applied_at`'e yazılır ve
  `/admin/yds` sayfasında gösterilir.

> Bu davranış bilinçli bir tercih değişikliğidir: başlangıçta veri "sıfırlama
> geçmişi silmesin" diye saklanıyordu. Ancak sıfırlama yayılmadığında ayna
> kalıcı olarak yanlış kalıyordu — kaynak boşalınca döngü hiçbir şey yazmaz,
> eski satırlar sonsuza kadar dururdu.

Hata durumları uygulamayı durdurmaz: dosya yoksa/bozuksa senkron sessizce geçer,
son hata `yds_sync.last_error`'a yazılır ve `/admin/yds` sayfasında gösterilir;
daha önce yansıtılmış veri korunur.

## YDS çalışma programı (yds.obs içeriği → görevler)

`scripts/yds-program-uret.js` — YDS içeriğini 2026-2027 **hafta sonlarına** yayıp
`src/data/ydsProgram.json` üretir. `/admin/yds` → "Görevlere Aktar".

**Gün düzeni:** YDS hafta sonuna (Cmt+Paz) alındı ki hafta içi çalışan YZ
programıyla çakışmasın. Günlük bütçe bu yüzden 60 değil **120 dk**
(`--dakika` ya da `YDS_GUNLUK_DAKIKA` ile değişir). Resmî/dinî bayramlar
çıkarılır; **ara tatil ve yarıyıl tatiline denk gelen hafta sonları dahildir**
(okul tatili YDS çalışmasını engellemez).

> `getDayInfo()` tatil dönemini hafta sonundan önce döndürdüğü için (ara
> tatildeki cumartesi `type='break'` gelir) gün seçimi takvim etiketine değil
> **gerçek hafta gününe** bakar.

**YZ programından farkı:** YZ müfredatı sabitti (149 ders ≈ 149 gün). YDS içeriği
Ankara Dil kaynaklarından gün gün üretiliyor: bugün **56 parça**, yıl ise
**78 hafta sonu günü**. Bu yüzden:

1. Her parça **en fazla 3 kez** planlanır (ilk görme + 3 gün + 10 gün sonra).
   Aralıklı tekrar mantığı; aynı okumayı 45 kez planlamak yerine dürüst olan bu.
2. Tekrarlar günlük bütçenin **1/3'ünü** aşamaz — yoksa vadesi gelen tekrarlar
   günü doldurup yeni içeriği kovuyor (ilk denemede 17-18 Eylül baştan sona
   tekrar çıkmıştı).
3. İçerik bitince kalan günler **"bekliyor"**: konu uydurulmaz, yalnızca
   `YDS · Serbest Çalışma` kategorisinde bir günlük çalışma görevi açılır.
4. Yeni içerik gelince programı yeniden üret + aynı düğmeye bas. Yeni parçalar
   boş günlere yerleşir; **geçmiş ve işaretli görevler oynamaz**.

Aktarım üç iş yapar: yeni görevleri ekler, başlığı/açıklaması değişen
**işaretlenmemiş ve günü gelmemiş** görevleri tazeler, programda artık olmayan
**bayat** görevleri (yine yalnızca işaretlenmemiş + gelecek) siler.

> Bir gün "bekliyor"dan "içerikli"ye dönerken o günün serbest görevi
> **işaretlenmişse silinmez** — kullanıcının tamamladığı iş yok edilmez. O gün
> hem serbest kayıt hem yeni içerik görevleri görünür.

Kategoriler: `YDS · Konu Anlatımı` / `Kelime` / `Okuma` / `Test` /
`Serbest Çalışma`. `source_key` = `ydsp:<tarih>:<parçaId>`.

Bugünkü durum: **25 içerikli gün** (19 Eyl → 12 Ara, ort 112 dk/gün),
**53 bekleyen hafta sonu günü**, toplam **221 görev**.

**İki program çakışmaz:** YZ hafta içi (Pzt-Cum, ~20-42 dk/gün), YDS hafta sonu
(Cmt+Paz, ~112 dk/gün). Doğrulandı: ortak gün 0.

> Gün düzeni değişince (ör. hafta içinden hafta sonuna geçiş) yeniden aktarım
> eski günlerdeki görevleri bayat sayıp siler — ama yalnızca işaretlenmemiş ve
> günü gelmemiş olanları. **İşaretli bir görev eski gününde kalır**; o gün iki
> programın çakıştığı tek yer olabilir.

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
- `class_schedule`: `term` (0 = yıl boyu, 1/2 = dönem), `day_of_week` (1-5),
  `period`, `subject`, `class_name`, `room`, `kind` (`lesson` | `duty`).
  `UNIQUE (term, day_of_week, period)` — aynı hücre iki kez dolamaz.

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
  saatleriyle, özet tablosunda "N ders / M boş" sütunu. Ders yalnızca gerçek
  okul gününde gösterilir — hafta sonu, ara tatil, yarıyıl ve bayramda
  `academicCalendar` devreye girer ve çizelge işlemez.

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
- Sunucu tarafı yalnızca **çizelgede dersi olan** ve o gün **okul günü olan**
  hücreleri yazar; formdan gelen beklenmedik anahtar kayıt açamaz.
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

### Defter görevleri (işlenen konular → görevler)

`/admin/schedule` → **Defter Görevleri** paneli → "Görevlere Aktar". Her okul
haftası için **tek** görev açılır: *"Ders defterini doldur"*. Haftanın
çizelgede dolu olan tüm hücrelerine konu yazılınca görev **otomatik `done`**
işaretlenir.

- `source_key` = `defter:<haftaBaşı>`; YZ/YDS aktarımlarıyla aynı desen —
  idempotent, tekrar basılabilir. Yeni haftalar eklenir, **işaretlenmemiş ve
  günü gelmemiş** görevlerin başlığı/tarihi tazelenir, programda kalmayan
  bayat görevler (yine yalnızca işaretlenmemiş + gelecek) silinir.
- Kategori: `Ders Defteri`. Görev yalnızca `yazilabilir > 0` olan haftalar
  için açılır (çizelgede o hafta hiç dolu hücre yoksa görev de yok).
- **Son tarih hafta sonu (Pazar)**, cuma değil: defteri cumartesi doldurmak
  hâlâ zamanında sayılsın diye. Cuma verilseydi otomatik kilit hafta biter
  bitmez `not_done` mühürlerdi.
- `completeLessonLogTasks()` `runSealSafely` içinde (açılışta + 5 dakikada
  bir) **`sealOverdueTaskStatuses`'tan önce** çalışır. Sıra önemli: aynı turda
  hem defter tamamlanıp hem süre dolmuşsa görev "yapıldı" olmalı, "yapılmadı"
  değil. (Doğrulandı: geçmiş tarihli görev + dolu defter → `done`; geçmiş
  tarihli görev + eksik defter → `not_done`.)
- Sayaç paydası, İşlenen Konular ekranıyla aynı: **tüm dolu hücreler** (nöbet
  dahil).
- **Öğrenci listesinde yalnızca içinde bulunulan haftanın defter görevi
  görünür.** Öğretim yılı boyunca 37 görev açılıyor; hepsi "Görevlerim"de
  dursaydı günlük görevleri (YZ, YDS, kişisel) boğardı — doğrulandı: liste
  42 görevin 37'si defterken 6'ya indi. Filtre yalnızca **liste görünümüne**
  aittir: görevler silinmez, haftalık takvimde kendi gününde, haftalık
  analizde ve raporlarda aynen sayılır. Admin "Görevler" sayfası da hepsini
  gösterir (yönetim görünümü).

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
- Uyanma ortalamaları yalnızca **basılan** günlerden hesaplanır (`missed`
  günler paydaya girmez); zamanında oranının paydası ise kayıt girilmiş tüm
  günlerdir.
- Veri olmayan yerde oran `null` döner ve arayüzde `-` gösterilir — `%0` ile
  karıştırılmamalı (veri yok ≠ başarısız).

Sorgular tek turda hem içinde bulunulan hem önceki haftayı çeker
(`BETWEEN prevWeekStart AND weekEnd`), trend için ikinci bir gidiş yok —
`wake_logs` de aynı desenle aynı turda çekilir.

## Çalışırken dikkat

- Canlı sistem; davranış değiştiren PR'larda önce lokalde doğrula.
- Test yok; `npm test` placeholder (hata döndürür).
- `app.js` tek dosya — değişiklik yaparken çevredeki idiom ve yardımcı fonksiyonları (`asyncHandler`, `makeId`, `normalizeText`, validasyonlar) kullan.
