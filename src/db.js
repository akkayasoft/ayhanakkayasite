const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

function buildPoolConfig() {
  const useConnectionString = Boolean(process.env.DATABASE_URL);

  const config = useConnectionString
    ? { connectionString: process.env.DATABASE_URL }
    : {
        host: process.env.PGHOST,
        port: process.env.PGPORT ? Number(process.env.PGPORT) : undefined,
        user: process.env.PGUSER,
        password: process.env.PGPASSWORD,
        database: process.env.PGDATABASE
      };

  if (process.env.DATABASE_SSL === 'true') {
    config.ssl = {
      rejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false'
    };
  }

  return config;
}

const pool = new Pool(buildPoolConfig());

async function query(text, params = []) {
  return pool.query(text, params);
}

async function initDb() {
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin', 'student')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  // Ogretmen isareti: uygulama sahibi ayni zamanda ogrenci hesabiyla
  // giriyorsa ders defterini kendi panelinden yazabilsin. Rol degil bir
  // yetki bayragi; ogrenci rolu ve tum diger kisitlar aynen durur.
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_teacher BOOLEAN NOT NULL DEFAULT FALSE`);

  // Aylik hedefler: serbest metin hedef + elle kanit. Hedefi admin koyar.
  // "Basarildi" isaretlemek icin KANIT zorunludur (rota kontrol eder); yoksa
  // kayit "yaptim" beyanindan ibaret kalirdi.
  await query(`
    CREATE TABLE IF NOT EXISTS monthly_goals (
      id TEXT PRIMARY KEY,
      student_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      month_start DATE NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'achieved', 'missed')),
      evidence TEXT NOT NULL DEFAULT '',
      evaluated_at TIMESTAMPTZ,
      evaluated_by TEXT,
      created_by TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (student_id, month_start, title)
    )
  `);
  await query(`
    CREATE INDEX IF NOT EXISTS monthly_goals_student_month_idx
    ON monthly_goals (student_id, month_start)
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS categories (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      category_id TEXT NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
      student_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      repeat_type TEXT NOT NULL CHECK (repeat_type IN ('once', 'daily', 'weekly', 'monthly', 'custom')),
      single_date DATE NULL,
      weekly_day INTEGER NULL,
      monthly_day INTEGER NULL,
      custom_dates TEXT[] NOT NULL DEFAULT '{}',
      start_date DATE NULL,
      end_date DATE NULL,
      estimated_time TIME NULL,
      is_archived BOOLEAN NOT NULL DEFAULT FALSE,
      created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS estimated_time TIME`);
  // Dis kaynakli (ornegin yapayzeka platformu mufredati) gorevleri tekrar
  // tekrar eklemeden tanimak icin kaynak anahtari. Ayni ogrenciye ayni
  // source_key ikinci kez yazilamaz; boylece iceri aktarma idempotent olur.
  await query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS source_key TEXT`);

  // Ogrenci aciklamayi elle degistirdiyse isaretlenir. Aktarimlar (YDS, defter)
  // isaretlenmemis + gunu gelmemis gorevlerin aciklamasini tazeliyor; bayrak
  // olmasa ogrencinin yazdigi not "Gorevlere Aktar"a basinca silinirdi.
  await query(
    `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS description_edited BOOLEAN NOT NULL DEFAULT FALSE`
  );
  await query(`
    CREATE UNIQUE INDEX IF NOT EXISTS tasks_student_source_key_idx
    ON tasks (student_id, source_key)
    WHERE source_key IS NOT NULL
  `);
  await query(`ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_repeat_type_check`);
  await query(`
    ALTER TABLE tasks
    ADD CONSTRAINT tasks_repeat_type_check
    CHECK (repeat_type IN ('once', 'daily', 'weekly', 'monthly', 'custom'))
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS task_statuses (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      student_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      day DATE NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('done', 'not_done')),
      note TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (task_id, student_id, day)
    )
  `);

  // ADMIN DUZELTMESININ IZI. Isaretleme kalicidir ("ilk isaret gecerli"), ama
  // ogrenci isaretlemeyi unuttugunda muhurleyici 'not_done' yaziyor ve geri
  // donusu yoktu. Admin duzeltme rotasi bu kurala acilan TEK kapi; kapi
  // sessiz olmasin diye her duzeltme kimin, ne zaman ve NEYIN uzerine
  // yazdigiyla birlikte satirin icinde durur.
  await query(
    `ALTER TABLE task_statuses ADD COLUMN IF NOT EXISTS corrected_by TEXT REFERENCES users(id) ON DELETE SET NULL`
  );
  await query(`ALTER TABLE task_statuses ADD COLUMN IF NOT EXISTS corrected_at TIMESTAMPTZ`);
  await query(`ALTER TABLE task_statuses ADD COLUMN IF NOT EXISTS previous_status TEXT`);
  await query(
    `ALTER TABLE task_statuses ADD COLUMN IF NOT EXISTS correction_note TEXT NOT NULL DEFAULT ''`
  );

  await query(`
    CREATE TABLE IF NOT EXISTS task_detail_notes (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      student_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      day DATE NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (task_id, student_id, day)
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS daily_questions (
      id TEXT PRIMARY KEY,
      student_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      day DATE NOT NULL,
      category_id TEXT REFERENCES categories(id) ON DELETE SET NULL,
      lesson_name TEXT NOT NULL DEFAULT '',
      correct_count INTEGER NOT NULL DEFAULT 0 CHECK (correct_count >= 0),
      wrong_count INTEGER NOT NULL DEFAULT 0 CHECK (wrong_count >= 0),
      duration_minutes INTEGER NOT NULL DEFAULT 0 CHECK (duration_minutes >= 0),
      count INTEGER NOT NULL CHECK (count >= 0),
      note TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await query(`ALTER TABLE daily_questions DROP CONSTRAINT IF EXISTS daily_questions_student_id_day_key`);
  await query(`ALTER TABLE daily_questions DROP CONSTRAINT IF EXISTS daily_questions_student_day_category_lesson_key`);

  await query(`ALTER TABLE daily_questions ADD COLUMN IF NOT EXISTS category_id TEXT`);
  await query(`ALTER TABLE daily_questions ADD COLUMN IF NOT EXISTS lesson_name TEXT NOT NULL DEFAULT ''`);
  await query(`ALTER TABLE daily_questions ADD COLUMN IF NOT EXISTS correct_count INTEGER NOT NULL DEFAULT 0`);
  await query(`ALTER TABLE daily_questions ADD COLUMN IF NOT EXISTS wrong_count INTEGER NOT NULL DEFAULT 0`);
  await query(`ALTER TABLE daily_questions ADD COLUMN IF NOT EXISTS duration_minutes INTEGER NOT NULL DEFAULT 0`);

  // Dis kaynaktan (orn. yds.obs) aktarilan satirlar source_key ile isaretlenir;
  // elle girilen kayitlarda NULL kalir. Partial unique index sayesinde ayni
  // gun ikinci kez aktarilmaz, elle girilen satirlar kisitlanmaz.
  await query(`ALTER TABLE daily_questions ADD COLUMN IF NOT EXISTS source_key TEXT`);
  await query(`
    CREATE UNIQUE INDEX IF NOT EXISTS daily_questions_student_source_key_idx
    ON daily_questions (student_id, source_key)
    WHERE source_key IS NOT NULL
  `);

  // --- Okul ders programi -------------------------------------------------
  //
  // Uygulama sahibinin (ogretmen) haftalik ders cizelgesi. Ogrenci basina
  // degil uygulama genelinde tek programdir — bu kurulumda tek ogretmen var.
  //
  // Zil saatleri hesaplanir, elle girilmez: baslangic + ders/teneffus/ogle
  // sureleri verilir, her ders saatinin baslangic-bitisi bunlardan turetilir.
  // Boylece "8. ders kacta" sorusunun tek bir dogru cevabi olur.
  await query(`
    CREATE TABLE IF NOT EXISTS school_settings (
      id TEXT PRIMARY KEY,
      start_time TIME NOT NULL DEFAULT '08:00',
      lesson_minutes INTEGER NOT NULL DEFAULT 40 CHECK (lesson_minutes BETWEEN 10 AND 120),
      break_minutes INTEGER NOT NULL DEFAULT 10 CHECK (break_minutes BETWEEN 0 AND 60),
      period_count INTEGER NOT NULL DEFAULT 10 CHECK (period_count BETWEEN 1 AND 16),
      lunch_after_period INTEGER NULL CHECK (lunch_after_period IS NULL OR lunch_after_period >= 1),
      lunch_minutes INTEGER NOT NULL DEFAULT 40 CHECK (lunch_minutes BETWEEN 0 AND 180),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // GUNE OZEL ZIL SAATLERI.
  //
  // Varsayilan duzen hala school_settings'ten HESAPLANIR; burasi yalnizca
  // ISTISNADIR: (gun, ders saati) ciftine elle saat girilir ve o gunun o
  // dersi icin hesaplanan saatin yerine gecer. Butun gunler ayni duzende
  // olmadigi icin gerekli (ikili ogretim, DYK, kisa cuma, telafi).
  //
  // Satir YOKSA o hucre hesaplanan saati kullanir — yani tablo bos oldugunda
  // davranis eskisiyle birebir aynidir. Satir silmek "varsayilana don"
  // demektir; bu yuzden "varsayilana esit" bir satir tutulmaz.
  await query(`
    CREATE TABLE IF NOT EXISTS period_times (
      day_of_week INTEGER NOT NULL CHECK (day_of_week BETWEEN 1 AND 7),
      period INTEGER NOT NULL CHECK (period BETWEEN 1 AND 16),
      start_time TIME NOT NULL,
      end_time TIME NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (day_of_week, period),
      CHECK (end_time > start_time)
    )
  `);

  // term: 0 = yil boyu, 1 = 1. donem, 2 = 2. donem.
  // NULL yerine 0 kullanildi ki UNIQUE kisiti calissin (Postgres'te NULL'lar
  // birbirinden farkli sayilir, NULL'lu bir kisit ayni hucreyi iki kez
  // girmeyi engellemezdi).
  await query(`
    CREATE TABLE IF NOT EXISTS class_schedule (
      id TEXT PRIMARY KEY,
      term INTEGER NOT NULL DEFAULT 0 CHECK (term IN (0, 1, 2)),
      day_of_week INTEGER NOT NULL CHECK (day_of_week BETWEEN 1 AND 7),
      period INTEGER NOT NULL CHECK (period BETWEEN 1 AND 16),
      subject TEXT NOT NULL,
      class_name TEXT NOT NULL DEFAULT '',
      room TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL DEFAULT 'lesson' CHECK (kind IN ('lesson', 'duty')),
      week_start DATE NOT NULL DEFAULT DATE '1900-01-01',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  // Benzersizlik satir ici degil ADLI kisitla veriliyor (asagida): satir ici
  // yazilsaydi temiz kurulumda hem o hem gocteki adli kisit olusur, tabloda
  // ayni sey icin IKI unique dururdu.

  // HAFTAYA OZEL CIZELGE. Cizelge tek bir haftalik sablondu ve her hafta ayni
  // kabul ediliyordu; oysa hafta hafta degisebiliyor (seminer, sinav haftasi,
  // telafi dersi, DYK duzeni). Artik bir hafta "ozellestirilebilir".
  //
  // week_start = SABLON_HAFTA (1900-01-01) satirlari VARSAYILAN sablondur.
  // Baska bir tarih o haftanin kendi cizelgesidir; o hafta icin sablon degil
  // YALNIZCA o satirlar gecerlidir (birlestirme degil, tam degistirme) —
  // birlestirme "bu hafta bu ders yok"u ifade edemezdi.
  //
  // NULL yerine SABIT TARIH kullaniliyor: Postgres'te NULL'lar birbirinden
  // farkli sayildigi icin NULL'lu bir UNIQUE kisiti ayni hucrenin iki kez
  // girilmesini engellemezdi. `term` sutununda da ayni sebeple 0 secilmisti.
  await query(
    `ALTER TABLE class_schedule ADD COLUMN IF NOT EXISTS week_start DATE NOT NULL DEFAULT DATE '1900-01-01'`
  );
  await query(
    `ALTER TABLE class_schedule DROP CONSTRAINT IF EXISTS class_schedule_term_day_of_week_period_key`
  );
  await query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'class_schedule'::regclass
          AND conname = 'class_schedule_week_slot_key'
      ) THEN
        ALTER TABLE class_schedule
        ADD CONSTRAINT class_schedule_week_slot_key
        UNIQUE (week_start, term, day_of_week, period);
      END IF;
    END $$;
  `);
  await query(
    `CREATE INDEX IF NOT EXISTS class_schedule_week_idx ON class_schedule (week_start)`
  );

  // "BU HAFTA OZEL" ISARETI, ders satirlarindan AYRI tutulur.
  //
  // Ozelligi satir varliginden turetmek denendi ve tutmadi: bir haftayi
  // ozellestirip BOSALTMAK ("bu hafta hic ders yok") satirlari sildigi icin
  // hafta yeniden sablona donuyordu — tam da anlatilmak isteneni silen bir
  // davranis. Isaret ayri durunca "ozel ama bos" ifade edilebilir hale gelir;
  // o hafta icin defter gorevi de acilmaz.
  await query(`
    CREATE TABLE IF NOT EXISTS schedule_week_overrides (
      week_start DATE PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Haftalik islenen konular (ders defteri).
  //
  // Kayit class_schedule satirina DEGIL, (hafta, gun, ders saati) uclusune
  // baglanir; ayrica o andaki ders/sinif adi kaydin icine kopyalanir. Boylece
  // cizelge sonradan degisse bile gecmis defter okunabilir kalir — bir donem
  // sonra "11-A Mobil Uygulamalar" satirinin ne oldugu kaybolmaz.
  await query(`
    CREATE TABLE IF NOT EXISTS lesson_topics (
      id TEXT PRIMARY KEY,
      week_start DATE NOT NULL,
      day_of_week INTEGER NOT NULL CHECK (day_of_week BETWEEN 1 AND 7),
      period INTEGER NOT NULL CHECK (period BETWEEN 1 AND 16),
      subject TEXT NOT NULL DEFAULT '',
      class_name TEXT NOT NULL DEFAULT '',
      topic TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (week_start, day_of_week, period)
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS lesson_topics_week_idx ON lesson_topics (week_start DESC)`);

  // CIZELGE 7 GUNLUK OLDU. Iki tablonun da gun kontrolu 1-5 idi (Pzt-Cum);
  // hafta sonuna ders koyan bir duzen (DYK, ek ders, kurs) programa hic
  // girilemiyordu. CREATE TABLE IF NOT EXISTS var olan tabloyu degistirmedigi
  // icin kisit elle genisletilir. Daraltma degil genisletme oldugundan mevcut
  // satirlarin hepsi yeni kisiti saglar.
  await query(`ALTER TABLE class_schedule DROP CONSTRAINT IF EXISTS class_schedule_day_of_week_check`);
  await query(`
    ALTER TABLE class_schedule
    ADD CONSTRAINT class_schedule_day_of_week_check
    CHECK (day_of_week BETWEEN 1 AND 7)
  `);
  await query(`ALTER TABLE lesson_topics DROP CONSTRAINT IF EXISTS lesson_topics_day_of_week_check`);
  await query(`
    ALTER TABLE lesson_topics
    ADD CONSTRAINT lesson_topics_day_of_week_check
    CHECK (day_of_week BETWEEN 1 AND 7)
  `);

  // --- Uyanma rutini -----------------------------------------------------
  //
  // wake_routines: ogrenci basina hedef saat + tolerans (tek satir).
  // wake_logs   : gun basina tek kayit. Hedef saat ve tolerans kaydin
  //               icine kopyalanir; rutin sonradan degistirilirse gecmis
  //               degerlendirmeler bozulmaz.
  await query(`
    CREATE TABLE IF NOT EXISTS wake_routines (
      student_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      target_time TIME NOT NULL,
      tolerance_minutes INTEGER NOT NULL DEFAULT 0
        CHECK (tolerance_minutes >= 0 AND tolerance_minutes <= 240),
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS wake_logs (
      id TEXT PRIMARY KEY,
      student_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      day DATE NOT NULL,
      target_time TIME NOT NULL,
      tolerance_minutes INTEGER NOT NULL DEFAULT 0,
      woke_at TIME NULL,
      status TEXT NOT NULL CHECK (status IN ('on_time', 'late', 'missed')),
      delay_minutes INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (student_id, day)
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS wake_logs_student_day_idx ON wake_logs (student_id, day DESC)`);

  // Ogrencinin o gune yazdigi serbest not. Gorevlerdeki "aciklama" alaninin
  // rutin karsiligi; rutin gorev listesinde ayni sutunda gosterilir.
  await query(`ALTER TABLE wake_logs ADD COLUMN IF NOT EXISTS note TEXT NOT NULL DEFAULT ''`);

  // ADMIN ELLE KAYDININ IZI (gorevlerdeki "Durum Duzelt" deseninin aynisi).
  // Ogrenci tarafinda "ilk basis gecerli" kurali degismedi; admin bir GUNUN
  // kaydini elle girebilir ya da duzeltebilir. Kapi sessiz olmasin diye her
  // yazma kimin, ne zaman ve NEYIN uzerine yazdigiyla satirin icinde durur.
  await query(
    `ALTER TABLE wake_logs ADD COLUMN IF NOT EXISTS corrected_by TEXT REFERENCES users(id) ON DELETE SET NULL`
  );
  await query(`ALTER TABLE wake_logs ADD COLUMN IF NOT EXISTS corrected_at TIMESTAMPTZ`);
  await query(`ALTER TABLE wake_logs ADD COLUMN IF NOT EXISTS previous_status TEXT`);
  await query(`ALTER TABLE wake_logs ADD COLUMN IF NOT EXISTS previous_time TIME`);
  await query(
    `ALTER TABLE wake_logs ADD COLUMN IF NOT EXISTS correction_note TEXT NOT NULL DEFAULT ''`
  );

  // --- Gunluk spor rutini ------------------------------------------------
  //
  // Uyanma rutininin kardesi. Fark: hedef saat + tolerans yerine bir ARALIK
  // tutulur (varsayilan 06:15-06:30). Aralik baslangici "niyet edilen saat",
  // bitisi son teslimdir; gecikme baslangica gore olculur (uyanmadaki
  // tolerans mantiginin aynisi).
  await query(`
    CREATE TABLE IF NOT EXISTS sport_routines (
      student_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      start_time TIME NOT NULL DEFAULT '06:15',
      end_time TIME NOT NULL DEFAULT '06:30',
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS sport_logs (
      id TEXT PRIMARY KEY,
      student_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      day DATE NOT NULL,
      start_time TIME NOT NULL,
      end_time TIME NOT NULL,
      done_at TIME NULL,
      status TEXT NOT NULL CHECK (status IN ('on_time', 'late', 'missed')),
      delay_minutes INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (student_id, day)
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS sport_logs_student_day_idx ON sport_logs (student_id, day DESC)`);

  await query(`ALTER TABLE sport_logs ADD COLUMN IF NOT EXISTS note TEXT NOT NULL DEFAULT ''`);

  // Uyanmadaki elle kayit izinin aynisi (bkz. wake_logs).
  await query(
    `ALTER TABLE sport_logs ADD COLUMN IF NOT EXISTS corrected_by TEXT REFERENCES users(id) ON DELETE SET NULL`
  );
  await query(`ALTER TABLE sport_logs ADD COLUMN IF NOT EXISTS corrected_at TIMESTAMPTZ`);
  await query(`ALTER TABLE sport_logs ADD COLUMN IF NOT EXISTS previous_status TEXT`);
  await query(`ALTER TABLE sport_logs ADD COLUMN IF NOT EXISTS previous_time TIME`);
  await query(
    `ALTER TABLE sport_logs ADD COLUMN IF NOT EXISTS correction_note TEXT NOT NULL DEFAULT ''`
  );

  // GUNLUK 5 VAKIT NAMAZ RUTINI.
  //
  // Uyanma/spor rutinlerinin UCUNCUSU degil, BASKA BIR SEKLI:
  //
  // 1. Gunde TEK degil BES kayit var (her vakit ayri degerlendirilir).
  // 2. Durum saatten HESAPLANMAZ. Vakit saatleri gune ve konuma gore kayar;
  //    uygulama onlari bilmiyor ve uydurmamali. Durumu kullanici beyan eder.
  //    Bu yuzden tabloda hedef/aralik sutunu yok — kopyalanacak bir ayar da
  //    yok, rutin yalnizca acik/kapali.
  // 3. Ucuncu bir durum var: KAZA. "Kilinmadi" kalici bir son degil; sonradan
  //    kazasi kilinabilir. Yani wake/sport'taki "ilk basis kalicidir" kurali
  //    burada tek bir gecise izin verir: missed -> qada.
  //
  // Bu farklar yuzunden ROUTINE_KINDS soyutlamasina sokulmadi (o soyutlama
  // "gun basina tek satir + saat sutunu + ayardan hesaplanan durum" varsayar).
  await query(`
    CREATE TABLE IF NOT EXISTS prayer_routines (
      student_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS prayer_logs (
      id TEXT PRIMARY KEY,
      student_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      day DATE NOT NULL,
      prayer TEXT NOT NULL CHECK (prayer IN ('sabah', 'ogle', 'ikindi', 'aksam', 'yatsi')),
      status TEXT NOT NULL CHECK (status IN ('on_time', 'missed', 'qada')),
      marked_at TIME NULL,
      -- Kaza BASKA BIR GUN kilinir: hangi gun ve saatte kilindigi ayri
      -- tutulur, yoksa "dunun ikindisini bugun kildim" kaydi kaybolurdu.
      qada_day DATE NULL,
      qada_at TIME NULL,
      note TEXT NOT NULL DEFAULT '',
      corrected_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      corrected_at TIMESTAMPTZ,
      previous_status TEXT,
      correction_note TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (student_id, day, prayer)
    )
  `);
  await query(
    `CREATE INDEX IF NOT EXISTS prayer_logs_student_day_idx ON prayer_logs (student_id, day DESC)`
  );

  // --- YZ / YDS programlari kaldirildi -----------------------------------
  //
  // Gorevler artik yalnizca UYANMA RUTINI, SPOR RUTINI ve DERS DEFTERI'nden
  // gelir. Yapay Zeka mufredati ve YDS calisma programi (gorev ureten iki
  // kaynak), yds.obs ilerleme aynasi ve elle gorev acma tamamen kaldirildi.
  //
  // Bu blok tek seferlik degil IDEMPOTENT bir temizliktir: her acilista
  // kalinti arar, yoksa hicbir sey yapmaz.
  await query(`DROP TABLE IF EXISTS yds_days`);
  await query(`DROP TABLE IF EXISTS yds_sync`);
  await query(`DROP TABLE IF EXISTS yds_program_settings`);

  // Program gorevleri ve durumlari (task_statuses CASCADE ile gider).
  // 'defter:%' = haftalik "Ders defterini doldur" gorevleri; model ders basina
  // goreve (source_key 'ders:<tarih>:<saat>') cevrildigi icin onlar da gider.
  const silinenGorev = await query(
    `DELETE FROM tasks WHERE source_key LIKE 'yz:%' OR source_key LIKE 'ydsp:%' OR source_key LIKE 'defter:%'`
  );
  if (silinenGorev.rowCount > 0) {
    console.log(`${silinenGorev.rowCount} YZ/YDS program görevi silindi.`);
  }

  // yds.obs aynasindan gelen soru kayitlari; elle girilenler (source_key NULL)
  // korunur.
  const silinenSoru = await query(`DELETE FROM daily_questions WHERE source_key LIKE 'yds:%'`);
  if (silinenSoru.rowCount > 0) {
    console.log(`${silinenSoru.rowCount} YDS ayna soru kaydı silindi.`);
  }

  // Bosalan program kategorileri. Baska gorev ya da soru kaydi bagliysa
  // DOKUNULMAZ - kategori silmek o kayitlarin etiketini kaybettirirdi.
  const silinenKategori = await query(
    `
      DELETE FROM categories c
      WHERE c.name IN ('Yapay Zeka', 'Doktora', 'Ders Defteri')
        AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.category_id = c.id)
        AND NOT EXISTS (SELECT 1 FROM daily_questions d WHERE d.category_id = c.id)
    `
  );
  if (silinenKategori.rowCount > 0) {
    console.log(`${silinenKategori.rowCount} boşalan program kategorisi silindi.`);
  }

  // --- Puan sistemi kaldirildi -------------------------------------------
  //
  // Odul/ceza puanlamasi uygulamadan tamamen cikarildi. Asagidaki migrasyon
  // ilgili tablolari ve users.points sutununu kalici olarak dusurur.
  // weekly_category_evaluations, point_logs'a referans verdigi icin once o
  // dusuruluyor. Islem idempotenttir: tablolar yoksa sessizce gecer.
  await query(`DROP TABLE IF EXISTS weekly_category_evaluations`);
  await query(`DROP TABLE IF EXISTS point_logs`);
  await query(`DROP TABLE IF EXISTS weekly_category_rules`);
  await query(`ALTER TABLE users DROP COLUMN IF EXISTS points`);
}

async function seedAdmin() {
  const result = await query("SELECT id FROM users WHERE role = 'admin' LIMIT 1");
  if (result.rowCount > 0) return;

  const username = process.env.DEFAULT_ADMIN_USERNAME || 'admin';
  const password = process.env.DEFAULT_ADMIN_PASSWORD || 'admin123';

  await query(
    `
      INSERT INTO users (id, name, username, password_hash, role)
      VALUES ($1, $2, $3, $4, 'admin')
    `,
    [
      `user_${crypto.randomUUID()}`,
      'Sistem Yönetici',
      username,
      bcrypt.hashSync(password, 10)
    ]
  );

  console.log('Varsayılan admin oluşturuldu:');
  console.log(`Kullanıcı: ${username}`);
  console.log(`Şifre: ${password}`);
}

module.exports = {
  pool,
  query,
  initDb,
  seedAdmin
};
