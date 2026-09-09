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

  // term: 0 = yil boyu, 1 = 1. donem, 2 = 2. donem.
  // NULL yerine 0 kullanildi ki UNIQUE kisiti calissin (Postgres'te NULL'lar
  // birbirinden farkli sayilir, NULL'lu bir kisit ayni hucreyi iki kez
  // girmeyi engellemezdi).
  await query(`
    CREATE TABLE IF NOT EXISTS class_schedule (
      id TEXT PRIMARY KEY,
      term INTEGER NOT NULL DEFAULT 0 CHECK (term IN (0, 1, 2)),
      day_of_week INTEGER NOT NULL CHECK (day_of_week BETWEEN 1 AND 5),
      period INTEGER NOT NULL CHECK (period BETWEEN 1 AND 16),
      subject TEXT NOT NULL,
      class_name TEXT NOT NULL DEFAULT '',
      room TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL DEFAULT 'lesson' CHECK (kind IN ('lesson', 'duty')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (term, day_of_week, period)
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
      day_of_week INTEGER NOT NULL CHECK (day_of_week BETWEEN 1 AND 5),
      period INTEGER NOT NULL CHECK (period BETWEEN 1 AND 16),
      subject TEXT NOT NULL DEFAULT '',
      class_name TEXT NOT NULL DEFAULT '',
      topic TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (week_start, day_of_week, period)
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS lesson_topics_week_idx ON lesson_topics (week_start DESC)`);

  // --- YDS / YOKDIL takibi -----------------------------------------------
  //
  // yds.obs uygulamasinin ilerlemesi bu tablolara YANSITILIR. Kaynak dosya
  // (state-<kullanici>.json) uygulamadan sifirlanabildigi icin veriyi burada
  // saklamak gecmis denetim kaydini korur — canli aynada olsaydi sifirlama
  // gecmisi de silerdi.
  await query(`
    CREATE TABLE IF NOT EXISTS yds_days (
      student_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      day DATE NOT NULL,
      lessons INTEGER NOT NULL DEFAULT 0,
      decks INTEGER NOT NULL DEFAULT 0,
      quizzes INTEGER NOT NULL DEFAULT 0,
      readings INTEGER NOT NULL DEFAULT 0,
      words_learned INTEGER NOT NULL DEFAULT 0,
      questions_solved INTEGER NOT NULL DEFAULT 0,
      scored_questions INTEGER NOT NULL DEFAULT 0,
      questions_correct INTEGER NOT NULL DEFAULT 0,
      goal_met BOOLEAN NOT NULL DEFAULT FALSE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (student_id, day)
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS yds_sync (
      student_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      goal_okuma INTEGER NOT NULL DEFAULT 0,
      goal_kelime INTEGER NOT NULL DEFAULT 0,
      goal_gramer INTEGER NOT NULL DEFAULT 0,
      goal_test INTEGER NOT NULL DEFAULT 0,
      streak_count INTEGER NOT NULL DEFAULT 0,
      streak_max INTEGER NOT NULL DEFAULT 0,
      streak_last_day DATE NULL,
      plan_start DATE NULL,
      learned_cards INTEGER NOT NULL DEFAULT 0,
      synced_at TIMESTAMPTZ NULL,
      last_error TEXT NOT NULL DEFAULT ''
    )
  `);
  // YDS uygulamasindaki "Ilerlemeyi sifirla" damgasi. Kaynaktaki resetAt bu
  // degerden buyukse aynadaki gecmis temizlenir (bkz. syncYdsProgress).
  await query(`ALTER TABLE yds_sync ADD COLUMN IF NOT EXISTS source_reset_at BIGINT NOT NULL DEFAULT 0`);
  await query(`ALTER TABLE yds_sync ADD COLUMN IF NOT EXISTS reset_applied_at TIMESTAMPTZ NULL`);

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
