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
      points INTEGER NOT NULL DEFAULT 0,
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
      is_archived BOOLEAN NOT NULL DEFAULT FALSE,
      created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
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
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (student_id, day)
    )
  `);

  await query(`ALTER TABLE daily_questions ADD COLUMN IF NOT EXISTS category_id TEXT`);
  await query(`ALTER TABLE daily_questions ADD COLUMN IF NOT EXISTS lesson_name TEXT NOT NULL DEFAULT ''`);
  await query(`ALTER TABLE daily_questions ADD COLUMN IF NOT EXISTS correct_count INTEGER NOT NULL DEFAULT 0`);
  await query(`ALTER TABLE daily_questions ADD COLUMN IF NOT EXISTS wrong_count INTEGER NOT NULL DEFAULT 0`);
  await query(`ALTER TABLE daily_questions ADD COLUMN IF NOT EXISTS duration_minutes INTEGER NOT NULL DEFAULT 0`);

  await query(`
    CREATE TABLE IF NOT EXISTS point_logs (
      id TEXT PRIMARY KEY,
      student_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK (type IN ('reward', 'penalty')),
      points INTEGER NOT NULL CHECK (points > 0),
      reason TEXT NOT NULL,
      delta INTEGER NOT NULL,
      created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function seedAdmin() {
  const result = await query("SELECT id FROM users WHERE role = 'admin' LIMIT 1");
  if (result.rowCount > 0) return;

  const username = process.env.DEFAULT_ADMIN_USERNAME || 'admin';
  const password = process.env.DEFAULT_ADMIN_PASSWORD || 'admin123';

  await query(
    `
      INSERT INTO users (id, name, username, password_hash, role, points)
      VALUES ($1, $2, $3, $4, 'admin', 0)
    `,
    [
      `user_${crypto.randomUUID()}`,
      'Sistem Yonetici',
      username,
      bcrypt.hashSync(password, 10)
    ]
  );

  console.log('Varsayilan admin olusturuldu:');
  console.log(`Kullanici: ${username}`);
  console.log(`Sifre: ${password}`);
}

module.exports = {
  pool,
  query,
  initDb,
  seedAdmin
};
