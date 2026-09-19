const path = require('path');
const crypto = require('crypto');
const express = require('express');
const ExcelJS = require('exceljs');
const session = require('express-session');
const pgSessionFactory = require('connect-pg-simple');
const bcrypt = require('bcryptjs');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { pool, query, initDb, seedAdmin } = require('./db');
const academicCalendar = require('./academicCalendar');
const yzProgram = require('./yzProgram');
const ydsSync = require('./ydsSync');
const ydsProgram = require('./ydsProgram');
const ydsPlan = require('./ydsPlan');
const schedule = require('./schedule');

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(
  helmet({
    contentSecurityPolicy: false
  })
);

app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, 'public')));

const PgSession = pgSessionFactory(session);
const isProduction = process.env.NODE_ENV === 'production';

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Çok fazla giriş denemesi yaptınız. Lütfen daha sonra tekrar deneyin.'
});

const sessionConfig = {
  secret: process.env.SESSION_SECRET || 'degistir-beni-session-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProduction,
    maxAge: 1000 * 60 * 60 * 12
  }
};

if (isProduction) {
  sessionConfig.store = new PgSession({
    pool,
    tableName: 'user_sessions',
    createTableIfMissing: true
  });
}

app.use(session(sessionConfig));

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function makeId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function normalizeText(value) {
  return String(value || '').trim();
}

function validateTaskTitle(value) {
  const title = normalizeText(value);
  if (!title) return { ok: false, error: 'Görev başlığı zorunlu.' };
  if (title.length < 2) return { ok: false, error: 'Görev başlığı en az 2 karakter olmalı.' };
  if (title.length > 120) return { ok: false, error: 'Görev başlığı en fazla 120 karakter olabilir.' };
  return { ok: true, value: title };
}

function validateTaskDescription(value) {
  const description = normalizeText(value);
  if (description.length > 300) {
    return { ok: false, error: 'Açıklama en fazla 300 karakter olabilir.' };
  }
  return { ok: true, value: description };
}

function normalizeIdList(value) {
  const values = Array.isArray(value) ? value : [value];
  const ids = values.map((item) => normalizeText(item)).filter(Boolean);
  return [...new Set(ids)];
}

function toDateOnly(value) {
  if (!value) return '';
  if (typeof value === 'string') return value.slice(0, 10);
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  // pg, DATE sutunlarini YEREL gece yarisi olan bir Date nesnesi olarak
  // dondurur. toISOString() bunu UTC'ye cevirdigi icin saat dilimi UTC'nin
  // ILERISINDE olan bir makinede (ör. TZ=Europe/Istanbul) her tarih bir gun
  // geriye kayiyordu: 2026-09-17 kaydi ekranda 2026-09-16 satirinda cikti.
  // Yerel parcalardan okumak sunucu UTC iken davranisi degistirmez.
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function shiftDate(dateStr, offsetDays) {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + offsetDays);
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function startOfWeek(dateStr) {
  const d = new Date(`${dateStr}T00:00:00`);
  const day = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - day);
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function getWeekDates(weekStart) {
  return Array.from({ length: 7 }, (_, index) => shiftDate(weekStart, index));
}

function getDateRangeInclusive(startDate, endDate, maxDays = 366) {
  const days = [];
  let cursor = startDate;
  let count = 0;

  while (cursor <= endDate) {
    days.push(cursor);
    cursor = shiftDate(cursor, 1);
    count += 1;

    if (count > maxDays) {
      return null;
    }
  }

  return days;
}

function getDayName(dateStr) {
  const names = ['Pazar', 'Pazartesi', 'Salı', 'Çarşamba', 'Perşembe', 'Cuma', 'Cumartesi'];
  const d = new Date(`${dateStr}T00:00:00`);
  return names[d.getDay()];
}

function todayDateString() {
  return dateStringInTimeZone(process.env.APP_TIMEZONE || 'Europe/Istanbul');
}

function dateStringInTimeZone(timeZone = 'Europe/Istanbul') {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  return formatter.format(new Date());
}

function isDateOnly(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function normalizeEstimatedTimeForStorage(value) {
  const timeValue = normalizeText(value);
  if (!timeValue) return { ok: true, value: null };
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(timeValue)) {
    return { ok: false, error: 'Tahmini saat HH:MM formatında olmalı.' };
  }
  return { ok: true, value: timeValue };
}

function normalizeEstimatedTimeForDisplay(value) {
  if (!value) return '';
  const timeValue = normalizeText(value);
  const match = timeValue.match(/^(\d{2}):(\d{2})/);
  if (!match) return '';
  return `${match[1]}:${match[2]}`;
}

// --- Sure dolumu / otomatik "yapilmadi" isaretleme -------------------------
//
// Bir gorev ornegi (gorev + gun) kendi son saatini gecince kilitlenir:
// artik "yapildi" olarak isaretlenemez ve isareti degistirilemez.
// Tahmini Saat girilmemisse son saat gun sonudur (23:59).
//
// AUTO_LOCK_START_DATE: bu tarihten onceki gunlere hic dokunulmaz. Ozellik
// devreye girmeden onceki gecmis kayitlar geriye donuk muhurlenmesin diye
// vardir; ortam degiskeniyle degistirilebilir.
const AUTO_LOCK_START_DATE = normalizeText(process.env.AUTO_LOCK_START_DATE) || '2026-09-06';
const DEFAULT_TASK_DEADLINE = '23:59';
// Muhurleme penceresi: bugunden geriye en fazla bu kadar gun taranir.
const AUTO_LOCK_LOOKBACK_DAYS = 14;

function timeStringInTimeZone(timeZone = process.env.APP_TIMEZONE || 'Europe/Istanbul') {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date());
}

function taskDeadlineTime(task) {
  return normalizeEstimatedTimeForDisplay(task.estimatedTime) || DEFAULT_TASK_DEADLINE;
}

// Verilen gun icin gorev ornegi kilitli mi? (HH:MM sifir dolgulu oldugu icin
// duz string karsilastirmasi dogru sonuc verir.)
function isTaskInstanceLocked(task, dayStr, today, nowHm) {
  if (!dayStr || dayStr < AUTO_LOCK_START_DATE) return false;
  if (dayStr > today) return false;
  if (dayStr < today) return true;
  return nowHm > taskDeadlineTime(task);
}

// Ogrenci ekranindaki satir icin: 'once' gorevde kendi tarihi, tekrarli
// gorevde bugunku ornek esas alinir (durum yazma rotasi her zaman bugune yazar).
function isTaskLockedNow(task, today, nowHm) {
  if (task.repeatType === 'once') {
    return isTaskInstanceLocked(task, task.singleDate || today, today, nowHm);
  }
  if (!isTaskDueOnDate(task, new Date(`${today}T00:00:00`), today)) return false;
  return isTaskInstanceLocked(task, today, today, nowHm);
}

// --- Uyanma rutini ---------------------------------------------------------
//
// Hedef saat + tolerans ogrenci basina tutulur; her gun icin tek bir kayit
// olusur. Gec basma da KAYDEDILIR (saatiyle birlikte) — cunku bir uyanma
// denetiminde 06:01 ile 10:00 arasindaki fark asil veridir; ikisini de
// "yapilmadi" saymak bu bilgiyi yok eder. Hic basilmayan gunler ertesi gun
// otomatik "missed" muhurlenir.

// SISTEM TABAN TARIHI: uygulamanin kaydi bu gunde baslar.
//
// 2026-09-14 ogretim yilinin ilk gunu. Sistem bu tarihten once kurulup
// denendigi icin oncesinde anlamsiz kayitlar olusmustu: rutinler "kuruldugu
// gunden" geriye muhurledigi icin 11-13 Eylul "kacirildi" yaziyordu, deneme
// gorevleri ve durumlari duruyordu. Bunlar gercek bir gecmis degil, kurulum
// artigi.
//
// Iki sey yapar:
//   1. Muhurleme (uyanma/spor) bu tarihten oncesine hic inmez; rutin gorunumu
//      de gun listesini burada keser.
//   2. Acilista bu tarihten onceki kayitlar SILINIR (purgeBeforeSystemStart).
//
// YDS aynasina DOKUNULMAZ: yds_days ve source_key'i 'yds:' ile baslayan soru
// kayitlari baska bir uygulamanin (yds.obs) gercek calisma gecmisidir; burada
// yalnizca yansitilir, bu uygulamanin kaydi degildir.
const SYSTEM_START_DATE = normalizeText(process.env.SYSTEM_START_DATE) || '2026-09-14';

// Temizlik istenmezse kapatilabilir (SYSTEM_PURGE=off).
const SYSTEM_PURGE_ENABLED = normalizeText(process.env.SYSTEM_PURGE).toLowerCase() !== 'off';

const WAKE_MAX_TOLERANCE = 240;
// Muhurleme penceresi: bugunden geriye en fazla bu kadar gun taranir.
const WAKE_LOOKBACK_DAYS = 30;

function hmToMinutes(hm) {
  if (!hm || typeof hm !== 'string') return null;
  const parcalar = hm.split(':');
  if (parcalar.length < 2) return null;
  const saat = Number(parcalar[0]);
  const dakika = Number(parcalar[1]);
  if (!Number.isFinite(saat) || !Number.isFinite(dakika)) return null;
  return saat * 60 + dakika;
}

function minutesToHm(dakika) {
  const t = Math.max(0, Math.round(dakika));
  return `${String(Math.floor(t / 60) % 24).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

/** Basilan saate gore durum: hedef + tolerans icindeyse 'on_time'. */
function evaluateWake(wokeHm, targetHm, toleranceMinutes) {
  const woke = hmToMinutes(wokeHm);
  const target = hmToMinutes(targetHm);
  if (woke === null || target === null) return null;
  const sinir = target + (Number(toleranceMinutes) || 0);
  return {
    status: woke <= sinir ? 'on_time' : 'late',
    // Gecikme toleransa gore degil HEDEFE gore olculur: tolerans "affedilen"
    // suredir, gercekte ne kadar gec kalindigini gizlememeli.
    delayMinutes: Math.max(0, woke - target)
  };
}

function wakeStatusText(status) {
  if (status === 'on_time') return 'Zamanında';
  if (status === 'late') return 'Geç';
  if (status === 'missed') return 'Kaçırıldı';
  return 'Bekliyor';
}

/**
 * Admin elle kayit izini tek satirlik metne cevirir. Gorevlerdeki
 * "Duzeltildi · Kim (Onceki → Yeni) · gerekce" satirinin rutin karsiligi;
 * saat de degerin parcasi oldugu icin onceki saat de yazilir.
 */
function routineCorrectionText(row, statusTextFn, yeniEtiket) {
  if (!row || !row.correctedAt) return '';
  const kim = row.correctedByName || 'Admin';
  const oncekiSaat = normalizeEstimatedTimeForDisplay(row.previousTime);
  const onceki = row.previousStatus
    ? `${statusTextFn(row.previousStatus)}${oncekiSaat ? ' ' + oncekiSaat : ''}`
    : 'Kayıtsız';
  const gerekce = normalizeText(row.correctionNote);
  return `Elle yazıldı · ${kim} (${onceki} → ${yeniEtiket})${gerekce ? ' · ' + gerekce : ''}`;
}

function mapWakeLog(row) {
  const wokeAt = normalizeEstimatedTimeForDisplay(row.wokeAt);
  return {
    day: toDateOnly(row.day),
    targetTime: normalizeEstimatedTimeForDisplay(row.targetTime),
    toleranceMinutes: Number(row.toleranceMinutes) || 0,
    wokeAt,
    status: row.status,
    statusText: wakeStatusText(row.status),
    delayMinutes: Number(row.delayMinutes) || 0,
    note: row.note || '',
    correctedAt: row.correctedAt || null,
    correctionText: routineCorrectionText(
      row,
      wakeStatusText,
      `${wakeStatusText(row.status)}${wokeAt ? ' ' + wokeAt : ''}`
    ),
    gunAdi: getDayName(toDateOnly(row.day))
  };
}

async function getWakeRoutine(studentId) {
  const res = await query(
    `
      SELECT
        student_id AS "studentId",
        target_time AS "targetTime",
        tolerance_minutes AS "toleranceMinutes",
        is_active AS "isActive",
        created_at AS "createdAt"
      FROM wake_routines
      WHERE student_id = $1
    `,
    [studentId]
  );
  if (res.rowCount === 0) return null;
  const row = res.rows[0];
  return {
    studentId: row.studentId,
    targetTime: normalizeEstimatedTimeForDisplay(row.targetTime),
    toleranceMinutes: Number(row.toleranceMinutes) || 0,
    isActive: row.isActive,
    createdDay: toDateOnly(row.createdAt)
  };
}

// --- Gunluk spor rutini ----------------------------------------------------
//
// Uyanma rutininin kardesi; ayni "tek dokunusla isaretle, basilan saati kaydet"
// mantigi. Tek fark hedefin bir ARALIK olmasi (varsayilan 06:15-06:30):
//   - aralik BASLANGICI  = niyet edilen saat (gecikme buna gore olculur)
//   - aralik BITISI      = son teslim (bundan sonrasi "gec")
// Yani uyanmadaki "hedef + tolerans" ikilisinin okunakli hali. Erken yapmak
// gec kalmak degildir: 05:40'ta spor yapmak da zamanindadir.

const SPORT_LOOKBACK_DAYS = 30;
const SPORT_DEFAULT_START = '06:15';
const SPORT_DEFAULT_END = '06:30';

function evaluateSport(doneHm, startHm, endHm) {
  const done = hmToMinutes(doneHm);
  const start = hmToMinutes(startHm);
  const end = hmToMinutes(endHm);
  if (done === null || start === null || end === null) return null;
  return {
    status: done <= end ? 'on_time' : 'late',
    // Gecikme BITISE degil BASLANGICA gore olculur: aralik "affedilen"
    // suredir, gercekte ne kadar gec kalindigini gizlememeli.
    delayMinutes: Math.max(0, done - start)
  };
}

function sportStatusText(status) {
  if (status === 'on_time') return 'Zamanında';
  if (status === 'late') return 'Geç';
  if (status === 'missed') return 'Yapılmadı';
  return 'Bekliyor';
}

function mapSportLog(row) {
  const doneAt = normalizeEstimatedTimeForDisplay(row.doneAt);
  return {
    day: toDateOnly(row.day),
    startTime: normalizeEstimatedTimeForDisplay(row.startTime),
    endTime: normalizeEstimatedTimeForDisplay(row.endTime),
    doneAt,
    status: row.status,
    statusText: sportStatusText(row.status),
    delayMinutes: Number(row.delayMinutes) || 0,
    note: row.note || '',
    correctedAt: row.correctedAt || null,
    correctionText: routineCorrectionText(
      row,
      sportStatusText,
      `${sportStatusText(row.status)}${doneAt ? ' ' + doneAt : ''}`
    ),
    gunAdi: getDayName(toDateOnly(row.day))
  };
}

async function getSportRoutine(studentId) {
  const res = await query(
    `
      SELECT student_id AS "studentId", start_time AS "startTime",
             end_time AS "endTime", is_active AS "isActive",
             created_at AS "createdAt"
      FROM sport_routines
      WHERE student_id = $1
    `,
    [studentId]
  );
  if (res.rowCount === 0) return null;
  const row = res.rows[0];
  return {
    studentId: row.studentId,
    startTime: normalizeEstimatedTimeForDisplay(row.startTime),
    endTime: normalizeEstimatedTimeForDisplay(row.endTime),
    isActive: row.isActive,
    // Muhurleyici rutin kurulmadan onceki gunlere inmez; elle silmenin
    // kalici olup olmadigini bu tarih belirler.
    createdDay: toDateOnly(row.createdAt)
  };
}

/** Uyanmadaki ile ayni kural: yalnizca GECMIS gunler muhurlenir, bugun degil. */
async function sealMissedSportLogs() {
  const today = dateStringInTimeZone(process.env.APP_TIMEZONE || 'Europe/Istanbul');
  const routines = await query(
    `
      SELECT student_id AS "studentId", start_time AS "startTime",
             end_time AS "endTime", created_at AS "createdAt"
      FROM sport_routines
      WHERE is_active = TRUE
    `
  );

  let sealed = 0;
  for (const routine of routines.rows) {
    const kuruldu = toDateOnly(routine.createdAt) || today;
    const basladi = kuruldu > SYSTEM_START_DATE ? kuruldu : SYSTEM_START_DATE;
    for (let i = 1; i <= SPORT_LOOKBACK_DAYS; i += 1) {
      const gun = shiftDate(today, -i);
      if (gun < basladi) break;
      const res = await query(
        `
          INSERT INTO sport_logs (id, student_id, day, start_time, end_time, done_at, status, delay_minutes)
          VALUES ($1,$2,$3,$4,$5,NULL,'missed',0)
          ON CONFLICT (student_id, day) DO NOTHING
        `,
        [makeId('sport'), routine.studentId, gun, routine.startTime, routine.endTime]
      );
      sealed += res.rowCount || 0;
    }
  }
  return { sealed };
}

async function buildSportView(studentId, gunSayisi = 14) {
  const routine = await getSportRoutine(studentId);
  const today = dateStringInTimeZone(process.env.APP_TIMEZONE || 'Europe/Istanbul');
  const nowHm = timeStringInTimeZone();

  if (!routine) {
    return { routine: null, today, nowHm, todayLog: null, rows: [], summary: null, streak: 0 };
  }

  const res = await query(
    `
      SELECT sl.day, sl.start_time AS "startTime", sl.end_time AS "endTime",
             sl.done_at AS "doneAt", sl.status, sl.delay_minutes AS "delayMinutes", sl.note,
             sl.corrected_at AS "correctedAt", sl.previous_status AS "previousStatus",
             sl.previous_time AS "previousTime", sl.correction_note AS "correctionNote",
             u.name AS "correctedByName"
      FROM sport_logs sl
      LEFT JOIN users u ON u.id = sl.corrected_by
      WHERE sl.student_id = $1 AND sl.day >= $2
      ORDER BY sl.day DESC
    `,
    [studentId, shiftDate(today, -(gunSayisi - 1))]
  );

  const logs = res.rows.map(mapSportLog);
  const logByDay = new Map(logs.map((l) => [l.day, l]));
  const todayLog = logByDay.get(today) || null;

  const rows = [];
  for (let i = 0; i < gunSayisi; i += 1) {
    const gun = shiftDate(today, -i);
    // Taban tarihten onceki gunler takvimde hic gosterilmez.
    if (gun < SYSTEM_START_DATE) break;
    rows.push(
      logByDay.get(gun) || {
        day: gun,
        startTime: routine.startTime,
        endTime: routine.endTime,
        doneAt: null,
        status: gun === today ? 'pending' : 'unknown',
        statusText: gun === today ? 'Bekliyor' : '-',
        delayMinutes: 0,
        gunAdi: getDayName(gun)
      }
    );
  }

  let streak = 0;
  const baslangic = todayLog && todayLog.status === 'on_time' ? 0 : 1;
  for (let i = baslangic; i < SPORT_LOOKBACK_DAYS; i += 1) {
    const log = logByDay.get(shiftDate(today, -i));
    if (!log || log.status !== 'on_time') break;
    streak += 1;
  }

  const degerlendirilen = logs.filter((l) => l.status !== 'unknown');
  const onTime = degerlendirilen.filter((l) => l.status === 'on_time').length;
  const late = degerlendirilen.filter((l) => l.status === 'late').length;
  const missed = degerlendirilen.filter((l) => l.status === 'missed').length;
  const yapilan = degerlendirilen.filter((l) => l.doneAt);
  const ortalamaDakika = yapilan.length
    ? yapilan.reduce((t, l) => t + (hmToMinutes(l.doneAt) || 0), 0) / yapilan.length
    : null;

  return {
    routine,
    today,
    nowHm,
    todayLog,
    rows,
    streak,
    summary: {
      gunSayisi,
      total: degerlendirilen.length,
      onTime,
      late,
      missed,
      onTimeRate: degerlendirilen.length ? Math.round((onTime / degerlendirilen.length) * 100) : null,
      averageTime: ortalamaDakika === null ? null : minutesToHm(Math.round(ortalamaDakika))
    }
  };
}

/**
 * Basilmadan gunu gecen rutinleri "missed" olarak muhurler.
 * Yalnizca GECMIS gunlere dokunur: bugun hala gec de olsa basilabilir.
 * Idempotenttir (ON CONFLICT DO NOTHING).
 */
async function sealMissedWakeLogs() {
  const today = dateStringInTimeZone(process.env.APP_TIMEZONE || 'Europe/Istanbul');
  const routines = await query(
    `
      SELECT
        student_id AS "studentId",
        target_time AS "targetTime",
        tolerance_minutes AS "toleranceMinutes",
        created_at AS "createdAt"
      FROM wake_routines
      WHERE is_active = TRUE
    `
  );

  let sealed = 0;
  for (const routine of routines.rows) {
    // Rutin kurulmadan onceki gunler geriye donuk muhurlenmez; ayrica
    // SYSTEM_START_DATE'ten onceye hic inilmez.
    const kuruldu = toDateOnly(routine.createdAt) || today;
    const basladi = kuruldu > SYSTEM_START_DATE ? kuruldu : SYSTEM_START_DATE;
    for (let i = 1; i <= WAKE_LOOKBACK_DAYS; i += 1) {
      const gun = shiftDate(today, -i);
      if (gun < basladi) break;
      const res = await query(
        `
          INSERT INTO wake_logs (id, student_id, day, target_time, tolerance_minutes, woke_at, status, delay_minutes)
          VALUES ($1, $2, $3, $4, $5, NULL, 'missed', 0)
          ON CONFLICT (student_id, day) DO NOTHING
        `,
        [makeId('wake'), routine.studentId, gun, routine.targetTime, routine.toleranceMinutes]
      );
      sealed += res.rowCount || 0;
    }
  }
  return { sealed };
}

/**
 * Bir ogrencinin uyanma rutini goruntusu: bugunku durum, seri ve son gunler.
 * gunSayisi kadar gecmis gun ozetlenir.
 */
async function buildWakeView(studentId, gunSayisi = 14) {
  const routine = await getWakeRoutine(studentId);
  const today = dateStringInTimeZone(process.env.APP_TIMEZONE || 'Europe/Istanbul');
  const nowHm = timeStringInTimeZone();

  if (!routine) {
    return { routine: null, today, nowHm, todayLog: null, rows: [], summary: null, streak: 0 };
  }

  const res = await query(
    `
      SELECT wl.day, wl.target_time AS "targetTime", wl.tolerance_minutes AS "toleranceMinutes",
             wl.woke_at AS "wokeAt", wl.status, wl.delay_minutes AS "delayMinutes", wl.note,
             wl.corrected_at AS "correctedAt", wl.previous_status AS "previousStatus",
             wl.previous_time AS "previousTime", wl.correction_note AS "correctionNote",
             u.name AS "correctedByName"
      FROM wake_logs wl
      LEFT JOIN users u ON u.id = wl.corrected_by
      WHERE wl.student_id = $1 AND wl.day >= $2
      ORDER BY wl.day DESC
    `,
    [studentId, shiftDate(today, -(gunSayisi - 1))]
  );

  const logs = res.rows.map(mapWakeLog);
  const logByDay = new Map(logs.map((l) => [l.day, l]));
  const todayLog = logByDay.get(today) || null;

  // Son gunSayisi gun icin bosluklar da dahil satirlar (en yeni ustte).
  const rows = [];
  for (let i = 0; i < gunSayisi; i += 1) {
    const gun = shiftDate(today, -i);
    // Taban tarihten onceki gunler takvimde hic gosterilmez.
    if (gun < SYSTEM_START_DATE) break;
    const log = logByDay.get(gun);
    rows.push(
      log || {
        day: gun,
        targetTime: routine.targetTime,
        toleranceMinutes: routine.toleranceMinutes,
        wokeAt: null,
        status: gun === today ? 'pending' : 'unknown',
        statusText: gun === today ? 'Bekliyor' : '-',
        delayMinutes: 0,
        gunAdi: getDayName(gun)
      }
    );
  }

  // Seri: bugunden (ya da bugun henuz basilmadiysa dunden) geriye dogru
  // kesintisiz "zamaninda" gun sayisi.
  let streak = 0;
  const baslangic = todayLog && todayLog.status === 'on_time' ? 0 : 1;
  for (let i = baslangic; i < WAKE_LOOKBACK_DAYS; i += 1) {
    const log = logByDay.get(shiftDate(today, -i));
    if (!log || log.status !== 'on_time') break;
    streak += 1;
  }

  const degerlendirilen = logs.filter((l) => l.status !== 'unknown');
  const onTime = degerlendirilen.filter((l) => l.status === 'on_time').length;
  const late = degerlendirilen.filter((l) => l.status === 'late').length;
  const missed = degerlendirilen.filter((l) => l.status === 'missed').length;
  const kalkilan = degerlendirilen.filter((l) => l.wokeAt);
  const ortalamaDakika = kalkilan.length
    ? kalkilan.reduce((t, l) => t + (hmToMinutes(l.wokeAt) || 0), 0) / kalkilan.length
    : null;

  return {
    routine,
    today,
    nowHm,
    todayLog,
    rows,
    streak,
    summary: {
      gunSayisi,
      total: degerlendirilen.length,
      onTime,
      late,
      missed,
      // Veri yoksa oran null doner ve arayuzde '-' gosterilir (%0 ile karistirilmamali).
      onTimeRate: degerlendirilen.length
        ? Math.round((onTime / degerlendirilen.length) * 100)
        : null,
      averageWake: ortalamaDakika === null ? null : minutesToHm(ortalamaDakika),
      averageDelay: kalkilan.length
        ? Math.round(kalkilan.reduce((t, l) => t + l.delayMinutes, 0) / kalkilan.length)
        : null
    }
  };
}

function normalizeWeekStart(value, fallbackDate = null) {
  if (isDateOnly(value)) return startOfWeek(value);
  if (fallbackDate && isDateOnly(fallbackDate)) return startOfWeek(fallbackDate);
  return null;
}

async function buildStudentCalendar(studentId, requestedWeekStart, fallbackDate, allTasks = null) {
  const baseDate = /^\d{4}-\d{2}-\d{2}$/.test(requestedWeekStart) ? requestedWeekStart : fallbackDate;
  const weekStart = startOfWeek(baseDate);
  const weekEnd = shiftDate(weekStart, 6);

  const [calendarStatusesRes, calendarQuestionsRes, studentTasksRes] = await Promise.all([
    query(
      `
        SELECT task_id AS "taskId", day, status
        FROM task_statuses
        WHERE student_id = $1 AND day BETWEEN $2 AND $3
      `,
      [studentId, weekStart, weekEnd]
    ),
    query(
      `
        SELECT
          day,
          COALESCE(SUM(correct_count + wrong_count), 0) AS "totalQuestions",
          COALESCE(SUM(duration_minutes), 0) AS "totalDuration"
        FROM daily_questions
        WHERE student_id = $1 AND day BETWEEN $2 AND $3
        GROUP BY day
      `,
      [studentId, weekStart, weekEnd]
    ),
    allTasks
      ? Promise.resolve({ rows: [] })
      : query(
          `
            SELECT
              id,
              title,
              description,
              category_id AS "categoryId",
              student_id AS "studentId",
              repeat_type AS "repeatType",
              single_date AS "singleDate",
              weekly_day AS "weeklyDay",
              monthly_day AS "monthlyDay",
              custom_dates AS "customDates",
              start_date AS "startDate",
              end_date AS "endDate",
              estimated_time AS "estimatedTime",
              is_archived AS "isArchived",
              created_by AS "createdBy",
              created_at AS "createdAt"
            FROM tasks
            WHERE student_id = $1
            ORDER BY created_at DESC
          `,
          [studentId]
        )
  ]);

  const questionByDay = new Map(
    calendarQuestionsRes.rows.map((row) => [toDateOnly(row.day), row])
  );
  const statusByTaskAndDay = new Map(
    calendarStatusesRes.rows.map((row) => [`${row.taskId}:${toDateOnly(row.day)}`, row.status])
  );
  const tasks = allTasks || studentTasksRes.rows.map(mapTask);

  // Okul ders programi: gunun derslerini takvimde gorevlerin yaninda goster ki
  // hangi saatin bos oldugu anlasilsin. Program uygulama genelinde tektir
  // (tek ogretmen varsayimi); tanimli degilse bu kisim sessizce bos gecer.
  const [scheduleSettings, scheduleEntries] = await Promise.all([
    getScheduleSettings(),
    getScheduleEntries(weekStart)
  ]);

  const days = getWeekDates(weekStart).map((day) => {
    const dayDateObj = new Date(`${day}T00:00:00`);
    const dueTasks = tasks.filter((task) => isTaskDueOnDate(task, dayDateObj, day));
    const doneCount = dueTasks.filter(
      (task) => statusByTaskAndDay.get(`${task.id}:${day}`) === 'done'
    ).length;
    const dayQuestion = questionByDay.get(day);

    const dayInfo = academicCalendar.getDayInfo(day);

    // Cizelge HER GUN isler: hafta sonu da tatil de. O gun ders yoksa zaten
    // izgarada hucre yoktur; "bu hafta ders yok" demek icin o haftanin
    // cizelgesi bosaltilir.
    const haftaninGunu = schedule.dayOfWeek(day);
    const dersler = schedule.lessonsForDay(scheduleEntries, haftaninGunu, scheduleSettings);

    return {
      date: day,
      dayName: getDayName(day),
      dayType: dayInfo.type,
      dayLabel: dayInfo.label,
      isSchoolDay: dayInfo.isSchoolDay,
      lessons: dersler,
      lessonCount: dersler.filter((d) => d.kind === 'lesson').length,
      freePeriods: Math.max(0, scheduleSettings.periodCount - dersler.length),
      dueCount: dueTasks.length,
      doneCount,
      questionTotal: dayQuestion ? Number(dayQuestion.totalQuestions || 0) : 0,
      durationMinutes: dayQuestion ? Number(dayQuestion.totalDuration || 0) : 0,
      tasks: dueTasks.map((task) => ({
        id: task.id,
        title: task.title,
        categoryId: task.categoryId,
        estimatedTime: task.estimatedTime || '',
        status: statusByTaskAndDay.get(`${task.id}:${day}`) || 'not_set'
      }))
    };
  });

  return {
    weekStart,
    weekEnd,
    prevWeekStart: shiftDate(weekStart, -7),
    nextWeekStart: shiftDate(weekStart, 7),
    academic: academicCalendar.describeWeek(weekStart, weekEnd),
    scheduleSettings,
    hasSchedule: scheduleEntries.length > 0,
    days
  };
}

/**
 * Yillik plan (ogrenci): 2026-2027 ogretim yilinin BUTUN haftalari bir
 * listede, secili haftanin icerigi gun gun.
 *
 * Haftalik takvim tek haftayi gosterir ve ileri/geri tek tek gidilir; yilin
 * tamamini gormek icin 40 tik gerekiyordu. Burada hafta secilir, icerik
 * (gorev basligi + aciklamasi) hemen altta acilir.
 *
 * Gorev listesinden iki farki var:
 *  - DEFTER gorevleri kendi haftalarinda gorunur (listede yalnizca icinde
 *    bulunulan haftaninki kalir; burada "plan" gosteriliyor).
 *  - Gun bazli oldugu icin tekrarli gorevler her dustugu gunde sayilir.
 */
async function buildStudentProgramView(studentId, allTasks, categories, today, requestedWeek) {
  const yil = academicCalendar.ACADEMIC_YEAR;
  const ilkHafta = startOfWeek(yil.start);
  const sonHafta = startOfWeek(yil.end);

  const tasks = allTasks.filter((task) => !task.isArchived);
  const kategoriAdi = new Map(categories.map((c) => [c.id, c.name]));

  // Tum yilin durumlari tek sorguda; hafta hafta gitmek 40 gidis olurdu.
  const statusRes = await query(
    `
      SELECT task_id AS "taskId", day, status
      FROM task_statuses
      WHERE student_id = $1 AND day BETWEEN $2::date AND $3::date
    `,
    [studentId, ilkHafta, shiftDate(sonHafta, 6)]
  );
  const durumlar = new Map(
    statusRes.rows.map((row) => [`${row.taskId}:${toDateOnly(row.day)}`, row.status])
  );

  // Secili hafta ogretim yilinin disina cikmaz; parametre yoksa icinde
  // bulunulan hafta (yil disindaysak yilin ilk/son haftasi).
  const buHafta = startOfWeek(today);
  const sinirla = (hafta) => (hafta < ilkHafta ? ilkHafta : hafta > sonHafta ? sonHafta : hafta);
  const secilen = sinirla(normalizeWeekStart(requestedWeek, null) || buHafta);

  const haftalar = [];
  let secilenGunler = [];
  for (let hafta = ilkHafta; hafta <= sonHafta; hafta = shiftDate(hafta, 7)) {
    const secili = hafta === secilen;
    const gunler = [];
    const kategoriSayaci = new Map();
    let toplam = 0;
    let yapilan = 0;

    for (const gun of getWeekDates(hafta)) {
      const gunObj = new Date(`${gun}T00:00:00`);
      const gunGorevleri = tasks.filter((task) => isTaskDueOnDate(task, gunObj, gun));
      const satirlar = [];

      for (const gorev of gunGorevleri) {
        const durum = durumlar.get(`${gorev.id}:${gun}`) || 'not_set';
        const kategori = kategoriAdi.get(gorev.categoryId) || 'Kategori Yok';
        toplam += 1;
        if (durum === 'done') yapilan += 1;
        kategoriSayaci.set(kategori, (kategoriSayaci.get(kategori) || 0) + 1);
        // Icerik yalnizca secili hafta icin uretilir: 41 haftanin tum
        // gorevlerini goruntuye tasimak gereksiz.
        if (secili) {
          satirlar.push({
            id: gorev.id,
            title: gorev.title,
            description: gorev.description || '',
            categoryName: kategori,
            estimatedTime: normalizeEstimatedTimeForDisplay(gorev.estimatedTime),
            status: durum
          });
        }
      }

      if (secili) {
        const bilgi = academicCalendar.getDayInfo(gun);
        gunler.push({
          date: gun,
          dayName: getDayName(gun),
          dayLabel: bilgi.label,
          isSchoolDay: bilgi.isSchoolDay,
          isToday: gun === today,
          tasks: satirlar,
          doneCount: satirlar.filter((s) => s.status === 'done').length
        });
      }
    }

    if (secili) secilenGunler = gunler;

    haftalar.push({
      weekStart: hafta,
      weekEnd: shiftDate(hafta, 6),
      academic: academicCalendar.describeWeek(hafta, shiftDate(hafta, 6)),
      isCurrent: hafta === buHafta,
      isSelected: secili,
      isPast: shiftDate(hafta, 6) < today,
      total: toplam,
      done: yapilan,
      // Kategori kirilimi haftanin "ne icerdigini" tek bakista anlatir:
      // "Yapay Zeka 5 · Doktora 2 · Ders Defteri 1".
      categories: [...kategoriSayaci.entries()]
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'tr'))
    });
  }

  const sira = haftalar.findIndex((h) => h.isSelected);
  return {
    yearLabel: yil.label,
    weeks: haftalar,
    selected: haftalar[sira] || null,
    days: secilenGunler,
    prevWeek: sira > 0 ? haftalar[sira - 1].weekStart : '',
    nextWeek: sira >= 0 && sira < haftalar.length - 1 ? haftalar[sira + 1].weekStart : '',
    currentWeek: buHafta >= ilkHafta && buHafta <= sonHafta ? buHafta : '',
    totals: {
      weeks: haftalar.length,
      tasks: haftalar.reduce((toplam, h) => toplam + h.total, 0),
      done: haftalar.reduce((toplam, h) => toplam + h.done, 0)
    }
  };
}

// Haftalik analiz: bir hafta icin ogrenci basina gorev tamamlama, soru
// dogrulugu ve calisma suresi; ayrica secili ogrenci icin kategori ve gun
// kirilimi ile onceki haftaya gore degisim.
async function buildWeeklyAnalysis(weekStart, selectedStudentId) {
  const weekEnd = shiftDate(weekStart, 6);
  const prevWeekStart = shiftDate(weekStart, -7);
  const prevWeekEnd = shiftDate(weekStart, -1);

  const [studentsRes, categoriesRes, tasksRes, statusesRes, questionsRes, wakeRes, sportRes] =
    await Promise.all([
    query(`SELECT id, name FROM users WHERE role = 'student' ORDER BY name ASC`),
    query(`SELECT id, name FROM categories ORDER BY name ASC`),
    query(`
      SELECT
        id,
        category_id AS "categoryId",
        student_id AS "studentId",
        repeat_type AS "repeatType",
        single_date AS "singleDate",
        weekly_day AS "weeklyDay",
        monthly_day AS "monthlyDay",
        custom_dates AS "customDates",
        start_date AS "startDate",
        end_date AS "endDate",
        is_archived AS "isArchived"
      FROM tasks
      WHERE is_archived = false
    `),
    query(
      `
        SELECT task_id AS "taskId", student_id AS "studentId", day, status
        FROM task_statuses
        WHERE day BETWEEN $1 AND $2 AND status = 'done'
      `,
      [prevWeekStart, weekEnd]
    ),
    query(
      `
        SELECT
          student_id AS "studentId",
          category_id AS "categoryId",
          day,
          COALESCE(SUM(correct_count), 0) AS "correctCount",
          COALESCE(SUM(wrong_count), 0) AS "wrongCount",
          COALESCE(SUM(duration_minutes), 0) AS "durationMinutes"
        FROM daily_questions
        WHERE day BETWEEN $1 AND $2
        GROUP BY student_id, category_id, day
      `,
      [prevWeekStart, weekEnd]
    ),
    query(
      `
        SELECT student_id AS "studentId", day, woke_at AS "wokeAt",
               status, delay_minutes AS "delayMinutes"
        FROM wake_logs
        WHERE day BETWEEN $1 AND $2
      `,
      [prevWeekStart, weekEnd]
    ),
    // Spor da uyanmayla ayni turda cekilir; trend icin ikinci bir gidis yok.
    query(
      `
        SELECT student_id AS "studentId", day, done_at AS "doneAt",
               status, delay_minutes AS "delayMinutes"
        FROM sport_logs
        WHERE day BETWEEN $1 AND $2
      `,
      [prevWeekStart, weekEnd]
    )
  ]);

  const students = studentsRes.rows;
  const categories = categoriesRes.rows;
  const categoryNameById = new Map(categories.map((c) => [c.id, c.name]));
  const tasks = tasksRes.rows.map((row) => ({
    id: row.id,
    categoryId: row.categoryId,
    studentId: row.studentId,
    repeatType: row.repeatType,
    singleDate: toDateOnly(row.singleDate) || null,
    weeklyDay: row.weeklyDay,
    monthlyDay: row.monthlyDay,
    customDates: row.customDates || [],
    startDate: toDateOnly(row.startDate) || null,
    endDate: toDateOnly(row.endDate) || null,
    isArchived: row.isArchived
  }));

  const doneSet = new Set(
    statusesRes.rows.map((row) => `${row.studentId}:${row.taskId}:${toDateOnly(row.day)}`)
  );
  const questionRows = questionsRes.rows.map((row) => ({
    ...row,
    date: toDateOnly(row.day),
    correctCount: Number(row.correctCount || 0),
    wrongCount: Number(row.wrongCount || 0),
    durationMinutes: Number(row.durationMinutes || 0)
  }));

  const wakeRows = wakeRes.rows.map((row) => ({
    studentId: row.studentId,
    date: toDateOnly(row.day),
    wokeAt: normalizeEstimatedTimeForDisplay(row.wokeAt),
    status: row.status,
    delayMinutes: Number(row.delayMinutes || 0)
  }));
  const wakeByStudentDay = new Map(wakeRows.map((r) => [`${r.studentId}:${r.date}`, r]));

  const sportRows = sportRes.rows.map((row) => ({
    studentId: row.studentId,
    date: toDateOnly(row.day),
    doneAt: normalizeEstimatedTimeForDisplay(row.doneAt),
    status: row.status,
    delayMinutes: Number(row.delayMinutes || 0)
  }));
  const sportByStudentDay = new Map(sportRows.map((r) => [`${r.studentId}:${r.date}`, r]));

  const bosMetrik = () => ({
    due: 0,
    done: 0,
    correct: 0,
    wrong: 0,
    duration: 0,
    // Uyanma: wakeTracked kayit girilmis gun sayisi (missed dahil),
    // wakeWoke ise gercekten basilan gun sayisi (ortalama saat/gecikme paydasi).
    wakeTracked: 0,
    wakeOnTime: 0,
    wakeLate: 0,
    wakeMissed: 0,
    wakeWoke: 0,
    wakeMinutesSum: 0,
    wakeDelaySum: 0,
    // Spor: ayni desen (tracked = kayit girilmis gun, done = gercekten basilan).
    sportTracked: 0,
    sportOnTime: 0,
    sportLate: 0,
    sportMissed: 0,
    sportDone: 0,
    sportMinutesSum: 0,
    sportDelaySum: 0
  });

  /** Bir gunun uyanma kaydini metrige ekler. */
  function addWake(metrik, log) {
    if (!log) return;
    metrik.wakeTracked += 1;
    if (log.status === 'on_time') metrik.wakeOnTime += 1;
    else if (log.status === 'late') metrik.wakeLate += 1;
    else if (log.status === 'missed') metrik.wakeMissed += 1;
    const dakika = hmToMinutes(log.wokeAt);
    if (dakika !== null) {
      metrik.wakeWoke += 1;
      metrik.wakeMinutesSum += dakika;
      metrik.wakeDelaySum += log.delayMinutes;
    }
  }

  /** Bir gunun spor kaydini metrige ekler. */
  function addSport(metrik, log) {
    if (!log) return;
    metrik.sportTracked += 1;
    if (log.status === 'on_time') metrik.sportOnTime += 1;
    else if (log.status === 'late') metrik.sportLate += 1;
    else if (log.status === 'missed') metrik.sportMissed += 1;
    const dakika = hmToMinutes(log.doneAt);
    if (dakika !== null) {
      metrik.sportDone += 1;
      metrik.sportMinutesSum += dakika;
      metrik.sportDelaySum += log.delayMinutes;
    }
  }

  // Bir ogrencinin verilen gun araligindaki toplam metrikleri
  function metricsFor(studentId, days) {
    const metrik = bosMetrik();
    const studentTasks = tasks.filter((t) => t.studentId === studentId);

    for (const day of days) {
      const dayObj = new Date(`${day}T00:00:00`);
      for (const task of studentTasks) {
        if (!isTaskDueOnDate(task, dayObj, day)) continue;
        metrik.due += 1;
        if (doneSet.has(`${studentId}:${task.id}:${day}`)) metrik.done += 1;
      }
    }

    for (const row of questionRows) {
      if (row.studentId !== studentId || !days.includes(row.date)) continue;
      metrik.correct += row.correctCount;
      metrik.wrong += row.wrongCount;
      metrik.duration += row.durationMinutes;
    }

    for (const day of days) {
      addWake(metrik, wakeByStudentDay.get(`${studentId}:${day}`));
      addSport(metrik, sportByStudentDay.get(`${studentId}:${day}`));
    }

    return metrik;
  }

  const oran = (pay, payda) => (payda > 0 ? Math.round((pay / payda) * 1000) / 10 : null);

  function ozetle(metrik) {
    const questionTotal = metrik.correct + metrik.wrong;
    return {
      ...metrik,
      questionTotal,
      completionRate: oran(metrik.done, metrik.due),
      accuracy: oran(metrik.correct, questionTotal),
      // Veri yoksa null doner ve arayuzde '-' gosterilir (%0 ile karistirilmamali).
      wakeOnTimeRate: oran(metrik.wakeOnTime, metrik.wakeTracked),
      averageWake: metrik.wakeWoke
        ? minutesToHm(metrik.wakeMinutesSum / metrik.wakeWoke)
        : null,
      averageDelay: metrik.wakeWoke ? Math.round(metrik.wakeDelaySum / metrik.wakeWoke) : null,
      sportTracked: metrik.sportTracked,
      sportOnTime: metrik.sportOnTime,
      sportOnTimeRate: oran(metrik.sportOnTime, metrik.sportTracked),
      averageSport: metrik.sportDone ? minutesToHm(metrik.sportMinutesSum / metrik.sportDone) : null
    };
  }

  const weekDays = getWeekDates(weekStart);
  const prevDays = getWeekDates(prevWeekStart);

  const studentRows = students.map((student) => {
    const current = ozetle(metricsFor(student.id, weekDays));
    const previous = ozetle(metricsFor(student.id, prevDays));
    return {
      id: student.id,
      name: student.name,
      current,
      previous,
      delta: {
        completionRate:
          current.completionRate !== null && previous.completionRate !== null
            ? Math.round((current.completionRate - previous.completionRate) * 10) / 10
            : null,
        questionTotal: current.questionTotal - previous.questionTotal,
        duration: current.duration - previous.duration,
        sportOnTimeRate:
          current.sportOnTimeRate !== null && previous.sportOnTimeRate !== null
            ? Math.round((current.sportOnTimeRate - previous.sportOnTimeRate) * 10) / 10
            : null,
        wakeOnTimeRate:
          current.wakeOnTimeRate !== null && previous.wakeOnTimeRate !== null
            ? Math.round((current.wakeOnTimeRate - previous.wakeOnTimeRate) * 10) / 10
            : null
      }
    };
  });

  const totals = ozetle(
    studentRows.reduce((acc, row) => {
      acc.due += row.current.due;
      acc.done += row.current.done;
      acc.correct += row.current.correct;
      acc.wrong += row.current.wrong;
      acc.duration += row.current.duration;
      acc.wakeTracked += row.current.wakeTracked;
      acc.wakeOnTime += row.current.wakeOnTime;
      acc.wakeLate += row.current.wakeLate;
      acc.wakeMissed += row.current.wakeMissed;
      acc.wakeWoke += row.current.wakeWoke;
      acc.wakeMinutesSum += row.current.wakeMinutesSum;
      acc.wakeDelaySum += row.current.wakeDelaySum;
      return acc;
    }, bosMetrik())
  );

  // --- Secili ogrenci icin kategori ve gun kirilimi ---
  let detail = null;
  const selected = students.find((s) => s.id === selectedStudentId) || null;

  if (selected) {
    const studentTasks = tasks.filter((t) => t.studentId === selected.id);

    const byCategory = new Map();
    const kategoriAl = (categoryId) => {
      const key = categoryId || '__yok__';
      if (!byCategory.has(key)) {
        byCategory.set(key, {
          categoryId: key,
          categoryName: categoryNameById.get(categoryId) || 'Kategorisiz',
          ...bosMetrik()
        });
      }
      return byCategory.get(key);
    };

    const dayRows = weekDays.map((day) => {
      const dayObj = new Date(`${day}T00:00:00`);
      const dayInfo = academicCalendar.getDayInfo(day);
      const gun = bosMetrik();

      for (const task of studentTasks) {
        if (!isTaskDueOnDate(task, dayObj, day)) continue;
        const kategori = kategoriAl(task.categoryId);
        kategori.due += 1;
        gun.due += 1;
        if (doneSet.has(`${selected.id}:${task.id}:${day}`)) {
          kategori.done += 1;
          gun.done += 1;
        }
      }

      for (const row of questionRows) {
        if (row.studentId !== selected.id || row.date !== day) continue;
        const kategori = kategoriAl(row.categoryId);
        kategori.correct += row.correctCount;
        kategori.wrong += row.wrongCount;
        kategori.duration += row.durationMinutes;
        gun.correct += row.correctCount;
        gun.wrong += row.wrongCount;
        gun.duration += row.durationMinutes;
      }

      const wakeLog = wakeByStudentDay.get(`${selected.id}:${day}`) || null;
      addWake(gun, wakeLog);
      const sportLog = sportByStudentDay.get(`${selected.id}:${day}`) || null;
      addSport(gun, sportLog);

      return {
        date: day,
        dayName: getDayName(day),
        dayLabel: dayInfo.isSchoolDay ? 'Ders günü' : dayInfo.label,
        isSchoolDay: dayInfo.isSchoolDay,
        wake: wakeLog
          ? { ...wakeLog, statusText: wakeStatusText(wakeLog.status) }
          : null,
        sport: sportLog
          ? { ...sportLog, statusText: sportStatusText(sportLog.status) }
          : null,
        ...ozetle(gun)
      };
    });

    detail = {
      student: selected,
      categories: Array.from(byCategory.values())
        .map(ozetle)
        .sort((a, b) => b.due - a.due || a.categoryName.localeCompare(b.categoryName, 'tr')),
      days: dayRows
    };
  }

  return {
    weekStart,
    weekEnd,
    prevWeekStart,
    prevWeekEnd,
    nextWeekStart: shiftDate(weekStart, 7),
    academic: academicCalendar.describeWeek(weekStart, weekEnd),
    students,
    studentRows,
    totals,
    detail,
    selectedStudentId: selected ? selected.id : ''
  };
}

function parseDateRange(from, to) {
  const today = todayDateString();
  const fromDate = from || shiftDate(today, -6);
  const toDate = to || today;

  if (fromDate > toDate) {
    return { error: 'Başlangıç tarihi bitiş tarihinden büyük olamaz.' };
  }

  const days = [];
  let cursor = fromDate;
  let count = 0;

  while (cursor <= toDate) {
    days.push(cursor);
    cursor = shiftDate(cursor, 1);
    count += 1;

    if (count > 93) {
      return { error: 'Rapor aralığı en fazla 93 gün olabilir.' };
    }
  }

  return { fromDate, toDate, days, error: null };
}

function formatRepeat(task) {
  if (task.repeatType === 'once') return `Tek seferlik (${task.singleDate || '-'})`;
  if (task.repeatType === 'daily') return 'Her gün';
  if (task.repeatType === 'weekly') return `Haftalık (Gün ${task.weeklyDay})`;
  if (task.repeatType === 'monthly') return `Aylık (Gün ${task.monthlyDay})`;
  if (task.repeatType === 'custom') return `Özel (${(task.customDates || []).join(', ')})`;
  return '-';
}

function formatTaskSchedule(task) {
  if (task.repeatType === 'once') return task.singleDate || '-';
  if (task.repeatType === 'custom') return Array.isArray(task.customDates) ? task.customDates.join(', ') : '-';
  if (task.startDate && task.endDate) return `${task.startDate} - ${task.endDate}`;
  if (task.startDate) return task.startDate;
  if (task.endDate) return task.endDate;
  return '-';
}

function getTaskSortDate(task) {
  if (task.singleDate) return task.singleDate;
  if (Array.isArray(task.customDates) && task.customDates.length) {
    return [...task.customDates].sort()[0];
  }
  if (task.startDate) return task.startDate;
  if (task.endDate) return task.endDate;
  return '9999-12-31';
}

function getTaskSortTime(task) {
  return normalizeEstimatedTimeForDisplay(task.estimatedTime) || '99:99';
}

function compareTasksBySchedule(a, b) {
  const aDate = getTaskSortDate(a);
  const bDate = getTaskSortDate(b);
  if (aDate !== bDate) return aDate.localeCompare(bDate);

  const aTime = getTaskSortTime(a);
  const bTime = getTaskSortTime(b);
  if (aTime !== bTime) return aTime.localeCompare(bTime);

  return String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
}

/**
 * Bu gun "olagan disi" mi? (bayram / ara tatil / yariyil / ogretim yili disi)
 *
 * SADECE ETIKET ICINDIR, kapi degil. Once takvim cizelgenin isleyip
 * islemedigine karar veriyordu: hafta sonu ve tatil gunlerinde ders islemez
 * sayiliyor, o hucrelere deftere yazilamiyordu. Kullanici bu gunlerde de ders
 * yapabildigini soyledi (telafi, kurs, bayram sonrasi ek ders) — bu yuzden
 * takvim artik hicbir seyi ENGELLEMEZ, yalnizca rozet olarak bilgi verir.
 * "Bu hafta ders yok" demek icin dogru yer takvim degil, HAFTAYA OZEL
 * CIZELGE'dir (asagiya bakin): o haftanin izgarasi bosaltilir.
 */
function isUnusualCalendarDay(dateStr) {
  const tip = academicCalendar.getDayInfo(dateStr).type;
  return tip === 'holiday' || tip === 'break' || tip === 'outside';
}

function isTaskDueOnDate(task, dateObj, dateStr) {
  if (task.isArchived) return false;
  if (task.startDate && dateStr < task.startDate) return false;
  if (task.endDate && dateStr > task.endDate) return false;

  if (task.repeatType === 'once') return task.singleDate === dateStr;
  if (task.repeatType === 'daily') return true;
  if (task.repeatType === 'weekly') return Number(task.weeklyDay) === dateObj.getDay();
  if (task.repeatType === 'monthly') return Number(task.monthlyDay) === dateObj.getDate();
  if (task.repeatType === 'custom') return Array.isArray(task.customDates) && task.customDates.includes(dateStr);

  return false;
}

// Ogrencinin kendi gorevi uzerinde islem yapabilmesi icin gorevi getirir ve
// suresi dolmussa null doner. Kilit yalnizca isareti degil, gorevin kendisini
// de dondurur: aksi halde ogrenci gorevi silerek ya da saatini ileri alarak
// otomatik "yapilmadi" kaydindan kurtulabilirdi.
/**
 * Gorev ornegi ISARETLENMIS mi? (yapildi / yapilmadi)
 *
 * Isaretlemek kalicidir — uyanma ve spor rutinindeki "ilk basis gecerli"
 * kuralinin gorev tarafindaki karsiligi. Isaretlendikten sonra gorev PASIF
 * olur: durumu degistirilemez, alanlari duzenlenemez, silinemez.
 *
 * Tek seferlik gorevde HERHANGI bir durum satiri sayilir (o gorevin tek
 * ornegi vardir; tarihi sonradan degistiyse satir baska bir gune yazilmis
 * olabilir). Tekrarli gorevde yalnizca ILGILI GUNUN satiri sayilir — dunku
 * isaret bugunku ornegi kilitlemez.
 */
async function isTaskInstanceMarked(taskId, studentId, repeatType, gun) {
  const tekSeferlik = repeatType === 'once';
  const res = await query(
    tekSeferlik
      ? `SELECT 1 FROM task_statuses WHERE task_id = $1 AND student_id = $2 LIMIT 1`
      : `SELECT 1 FROM task_statuses WHERE task_id = $1 AND student_id = $2 AND day = $3::date LIMIT 1`,
    tekSeferlik ? [taskId, studentId] : [taskId, studentId, gun]
  );
  return res.rowCount > 0;
}

async function findStudentTaskIfEditable(taskId, studentId) {
  const result = await query(
    `
      SELECT
        id,
        title,
        description,
        category_id AS "categoryId",
        student_id AS "studentId",
        repeat_type AS "repeatType",
        single_date AS "singleDate",
        weekly_day AS "weeklyDay",
        monthly_day AS "monthlyDay",
        custom_dates AS "customDates",
        start_date AS "startDate",
        end_date AS "endDate",
        estimated_time AS "estimatedTime",
        is_archived AS "isArchived",
        created_by AS "createdBy",
        created_at AS "createdAt"
      FROM tasks
      WHERE id = $1 AND student_id = $2 AND is_archived = false
      LIMIT 1
    `,
    [taskId, studentId]
  );

  if (result.rowCount === 0) return { task: null, locked: false };

  const task = mapTask(result.rows[0]);
  const today = todayDateString();
  // Kilit iki sebepten olur: (a) zaten isaretlendi, (b) suresi doldu.
  // Hangisi oldugunu cagirana bildiriyoruz ki hata mesaji dogru olsun.
  const marked = await isTaskInstanceMarked(task.id, studentId, task.repeatType, today);
  const locked = marked || isTaskLockedNow(task, today, timeStringInTimeZone());

  return {
    task,
    locked,
    marked,
    kilitMesaji: marked
      ? 'Bu görev işaretlendi; üzerinde değişiklik yapılamaz.'
      : 'Bu görevin süresi doldu, üzerinde değişiklik yapılamaz.'
  };
}

// Suresi dolmus ve hic isaretlenmemis gorev orneklerine 'not_done' yazar.
// Idempotent: var olan kayitlara ON CONFLICT DO NOTHING ile dokunmaz, yani
// ogrencinin kendi isaretledigi 'done' kayitlari korunur.
async function sealOverdueTaskStatuses() {
  const today = todayDateString();
  const nowHm = timeStringInTimeZone();
  const lookbackStart = shiftDate(today, -AUTO_LOCK_LOOKBACK_DAYS);
  // Pencere tabani: geriye bakis, AUTO_LOCK_START_DATE ve SISTEM TABAN TARIHI
  // icinde EN GEC olani. Sistem tabani olmadan muhurleyici, temizligin sildigi
  // gunlere aninda yeniden satir yaziyordu (olculdu: 06-13 Eylul icin 9 satir
  // geri geldi) — silme ve muhurleme birbiriyle savasiyordu.
  const windowStart = [lookbackStart, AUTO_LOCK_START_DATE, SYSTEM_START_DATE].sort().pop();

  if (windowStart > today) return { inserted: 0 };

  const days = getDateRangeInclusive(windowStart, today, AUTO_LOCK_LOOKBACK_DAYS + 2);
  if (!days) return { inserted: 0 };

  const tasksRes = await query(`
    SELECT
      id,
      student_id AS "studentId",
      repeat_type AS "repeatType",
      single_date AS "singleDate",
      weekly_day AS "weeklyDay",
      monthly_day AS "monthlyDay",
      custom_dates AS "customDates",
      start_date AS "startDate",
      end_date AS "endDate",
      estimated_time AS "estimatedTime",
      is_archived AS "isArchived"
    FROM tasks
    WHERE is_archived = false
  `);

  if (!tasksRes.rowCount) return { inserted: 0 };

  const tasks = tasksRes.rows.map((row) => ({
    id: row.id,
    studentId: row.studentId,
    repeatType: row.repeatType,
    singleDate: toDateOnly(row.singleDate) || null,
    weeklyDay: row.weeklyDay,
    monthlyDay: row.monthlyDay,
    customDates: row.customDates || [],
    startDate: toDateOnly(row.startDate) || null,
    endDate: toDateOnly(row.endDate) || null,
    estimatedTime: normalizeEstimatedTimeForDisplay(row.estimatedTime),
    isArchived: row.isArchived
  }));

  const statusesRes = await query(
    `SELECT task_id AS "taskId", day FROM task_statuses WHERE day BETWEEN $1 AND $2`,
    [windowStart, today]
  );
  const existing = new Set(statusesRes.rows.map((row) => `${row.taskId}:${toDateOnly(row.day)}`));

  const pending = [];
  for (const day of days) {
    const dayObj = new Date(`${day}T00:00:00`);
    for (const task of tasks) {
      if (!isTaskDueOnDate(task, dayObj, day)) continue;
      if (!isTaskInstanceLocked(task, day, today, nowHm)) continue;
      if (existing.has(`${task.id}:${day}`)) continue;
      pending.push({ task, day });
    }
  }

  if (!pending.length) return { inserted: 0 };

  let inserted = 0;
  const CHUNK = 200;
  for (let i = 0; i < pending.length; i += CHUNK) {
    const chunk = pending.slice(i, i + CHUNK);
    const values = [];
    const params = [];
    chunk.forEach(({ task, day }, index) => {
      const base = index * 4;
      values.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, 'not_done', '')`);
      params.push(makeId('status'), task.id, task.studentId, day);
    });

    const result = await query(
      `
        INSERT INTO task_statuses (id, task_id, student_id, day, status, note)
        VALUES ${values.join(', ')}
        ON CONFLICT (task_id, student_id, day) DO NOTHING
      `,
      params
    );
    inserted += result.rowCount || 0;
  }

  return { inserted };
}

// --- yapayzeka.obs mufredati -> gorev aktarimi -----------------------------
//
// Program src/data/yzProgram.json'dan okunur (scripts/yz-program-uret.js ile
// platform deposundan uretilir). Aktarim idempotenttir: her ders satiri
// tasks.source_key ile isaretlenir, ikinci kez calistirildiginda yalnizca
// programa yeni eklenen dersler gorev olarak yazilir.

/** Programin hedefi olan ogrenciyi secer; varsayilan "ayhan". */
function pickYzStudent(students, requestedId) {
  const requested = students.find((s) => s.id === requestedId);
  if (requested) return requested;

  const varsayilan = students.find(
    (s) =>
      normalizeText(s.username).toLocaleLowerCase('tr') === 'ayhan' ||
      normalizeText(s.name).toLocaleLowerCase('tr').startsWith('ayhan')
  );
  return varsayilan || students[0] || null;
}

async function buildYzProgramView(req, students) {
  const program = yzProgram.loadYzProgram();
  const student = pickYzStudent(students, normalizeText(req.query.yzStudentId));

  let importedKeys = new Set();
  if (student) {
    const res = await query(
      `SELECT source_key AS "sourceKey" FROM tasks WHERE student_id = $1 AND source_key LIKE $2`,
      [student.id, `${yzProgram.SOURCE_PREFIX}:%`]
    );
    importedKeys = new Set(res.rows.map((r) => r.sourceKey));
  }

  const today = todayDateString();
  const rows = program.gorevler.map((lesson) => ({
    ...lesson,
    imported: importedKeys.has(lesson.sourceKey),
    gunAdi: getDayName(lesson.tarih),
    academic: academicCalendar.getDayInfo(lesson.tarih)
  }));

  const importedCount = rows.filter((r) => r.imported).length;
  const kurslar = [];
  for (const row of rows) {
    let kurs = kurslar.find((k) => k.kurs === row.kurs);
    if (!kurs) {
      kurs = { kurs: row.kurs, kursAd: row.kursAd, total: 0, imported: 0, ilk: row.tarih, son: row.tarih };
      kurslar.push(kurs);
    }
    kurs.total += 1;
    if (row.imported) kurs.imported += 1;
    if (row.tarih < kurs.ilk) kurs.ilk = row.tarih;
    if (row.tarih > kurs.son) kurs.son = row.tarih;
  }

  return {
    surum: program.surum,
    kaynak: program.kaynak,
    baslangic: program.baslangic,
    bitis: program.bitis,
    student,
    students,
    total: rows.length,
    imported: importedCount,
    pending: rows.length - importedCount,
    kurslar,
    // Tam liste cok uzun; yaklasan ve son eklenmeyen dersleri goster.
    upcoming: rows.filter((r) => r.tarih >= today).slice(0, 20),
    pendingRows: rows.filter((r) => !r.imported).slice(0, 20),
    rows
  };
}

/**
 * Programdaki dersleri gorev olarak yazar. Kategori (kurs adi) yoksa olusturur.
 * estimated_time bilerek bos birakilir: otomatik kilit boylece gun sonunu
 * (23:59) son saat kabul eder, dersin sure bilgisi aciklamaya yazilir.
 */
// yapayzeka.obs mufredatinin TAMAMI tek kategoride toplanir. Once her kurs
// ayri bir kategoriydi (24 tane) ve kategori listesi YZ kurslariyla doluyordu.
// Kurs adi kaybolmaz: gorev aciklamasinin ilk parcasi hala kurs adidir
// (bkz. yzProgram.describeLesson).
const YZ_CATEGORY = 'Yapay Zeka';
// yds.obs calisma programinin tamami tek kategoride: doktora hazirligi.
const YDS_CATEGORY = 'Doktora';

/**
 * Bir kaynagin (source_key oneki) TUM gorevlerini tek bir kategoride toplar.
 * Iki yerde kullanilir:
 *   yz:   -> "Yapay Zeka"  (yapayzeka.obs mufredati)
 *   ydsp: -> "Doktora"     (yds.obs calisma programi)
 *
 * Hem aktarim dugmesinde hem ACILIŞTA calisir. Acilista da calismasinin sebebi
 * somut: kategoriler yalnizca "Görevlere Aktar" basildiginda duzeliyordu ve
 * kullanici ekranda hala eski kategori adlarini gorup ozelligin calismadigini
 * dusunuyordu. Idempotenttir - toplanacak gorev yoksa hicbir sey yapmaz.
 *
 * Verilen client ile calisir (cagiran islemi yonetir).
 */
async function consolidateCategoryWith(client, prefix, categoryName) {
  const desen = `${prefix}:%`;

  // Toplanacak YZ gorevi yoksa kategoriyi bile acma (temiz kurulumda gurultu
  // olmasin diye); aktarim sirasinda zaten gerekince acilir.
  const varMi = await client.query(`SELECT 1 FROM tasks WHERE source_key LIKE $1 LIMIT 1`, [desen]);

  let categoryId;
  const mevcutKategori = await client.query(`SELECT id FROM categories WHERE name = $1`, [
    categoryName
  ]);
  if (mevcutKategori.rowCount > 0) {
    categoryId = mevcutKategori.rows[0].id;
  } else if (varMi.rowCount > 0) {
    categoryId = makeId('cat');
    await client.query(`INSERT INTO categories (id, name) VALUES ($1, $2)`, [categoryId, categoryName]);
  } else {
    return { categoryId: null, merged: 0, removedCategories: 0, keptCategories: 0 };
  }

  // Hangi kategorilerin bu kaynaga ait oldugunu ADA GORE tahmin etmiyoruz -
  // halen bu oneke sahip gorev tutan kategorilerin kimligine bakiyoruz; elle
  // acilmis bir kategoriyi yanlislikla toplamamak icin.
  const eskiKategoriler = await client.query(
    `SELECT DISTINCT category_id AS "id" FROM tasks
     WHERE source_key LIKE $1 AND category_id <> $2`,
    [desen, categoryId]
  );
  const tasima = await client.query(
    `UPDATE tasks SET category_id = $1 WHERE source_key LIKE $2 AND category_id <> $1`,
    [categoryId, desen]
  );
  const merged = tasima.rowCount || 0;

  // Bosalan eski kategorileri sil - ama yalnizca gercekten bos olanlari.
  // Baska bir gorev ya da bir soru kaydi hala bagliysa kategori durur; silmek
  // o kaydin kategorisini kaybettirirdi (daily_questions.category_id
  // ON DELETE SET NULL).
  let removedCategories = 0;
  let keptCategories = 0;
  for (const row of eskiKategoriler.rows) {
    const kullanim = await client.query(
      `SELECT
         (SELECT COUNT(*) FROM tasks WHERE category_id = $1)::int AS "gorev",
         (SELECT COUNT(*) FROM daily_questions WHERE category_id = $1)::int AS "soru"`,
      [row.id]
    );
    const { gorev, soru } = kullanim.rows[0];
    if (gorev === 0 && soru === 0) {
      await client.query(`DELETE FROM categories WHERE id = $1`, [row.id]);
      removedCategories += 1;
    } else {
      keptCategories += 1;
    }
  }

  return { categoryId, merged, removedCategories, keptCategories };
}

/**
 * Kategoriyi ada gore bulur, yoksa acar. Toplama fonksiyonu temiz kurulumda
 * (hic gorev yokken) bilerek kategori ACMAZ; aktarim ise yazacagi gorevler
 * icin bir kategoriye ihtiyac duyar. Iki aktarim da bu yardimciyi kullanir.
 */
async function ensureCategoryId(client, categoryName) {
  const mevcut = await client.query(`SELECT id FROM categories WHERE name = $1`, [categoryName]);
  if (mevcut.rowCount > 0) return { id: mevcut.rows[0].id, created: 0 };
  const id = makeId('cat');
  await client.query(`INSERT INTO categories (id, name) VALUES ($1, $2)`, [id, categoryName]);
  return { id, created: 1 };
}

/** Acilista calisan surum: kendi islemini acar. */
async function consolidateCategory(prefix, categoryName) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const sonuc = await consolidateCategoryWith(client, prefix, categoryName);
    await client.query('COMMIT');
    return sonuc;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function importYzProgram(studentId, createdBy) {
  const program = yzProgram.loadYzProgram();
  if (!program.gorevler.length) {
    return { inserted: 0, skipped: 0, merged: 0, removedCategories: 0, keptCategories: 0, moved: 0, pinned: 0 };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { categoryId: toplananId, merged, removedCategories, keptCategories } =
      await consolidateCategoryWith(client, yzProgram.SOURCE_PREFIX, YZ_CATEGORY);

    // Temiz kurulumda toplama kategori acmaz (acacak gorev yok); aktarim
    // yazacagi gorevler icin kategoriye ihtiyac duyar.
    let categoryId = toplananId;
    let createdCategories = 0;
    if (!categoryId) {
      const olusan = await ensureCategoryId(client, YZ_CATEGORY);
      categoryId = olusan.id;
      createdCategories = olusan.created;
    }

    // Program yeniden uretildiginde ders tarihleri kayabilir (orn. haftada 4
    // ders yerine 5 ders duzenine gecince). Daha once aktarilmis gorevler eski
    // tarihte kalirsa takvim karisir: ml_ders11, ml_ders01'den once gorunur.
    // Bu yuzden zaten aktarilmis gorevlerin tarihi programla hizalanir — ama
    // yalnizca DOKUNULMAMIS ve GELECEKTEKI gorevler tasinir. Isaretlenmis
    // (yapildi/yapilmadi) ya da gunu gecmis bir gorev asla oynatilmaz.
    const bugun = todayDateString();
    let moved = 0;
    let pinned = 0;
    for (const lesson of program.gorevler) {
      const tasima = await client.query(
        `
          UPDATE tasks t
          SET single_date = $1
          WHERE t.student_id = $2
            AND t.source_key = $3
            AND t.single_date IS DISTINCT FROM $1::date
            AND t.single_date >= $4::date
            AND $1::date >= $4::date
            AND NOT EXISTS (SELECT 1 FROM task_statuses st WHERE st.task_id = t.id)
        `,
        [lesson.tarih, studentId, lesson.sourceKey, bugun]
      );
      moved += tasima.rowCount || 0;
    }

    // Tarihi programdan farkli kalan (kilitli/isaretli/gecmis) gorevleri say.
    const sapan = await client.query(
      `SELECT source_key AS "sourceKey", single_date AS "singleDate"
       FROM tasks WHERE student_id = $1 AND source_key = ANY($2::text[])`,
      [studentId, program.gorevler.map((g) => g.sourceKey)]
    );
    const beklenen = new Map(program.gorevler.map((g) => [g.sourceKey, g.tarih]));
    for (const row of sapan.rows) {
      const mevcut = toDateOnly(row.singleDate);
      if (mevcut && beklenen.get(row.sourceKey) !== mevcut) pinned += 1;
    }

    let inserted = 0;
    for (const lesson of program.gorevler) {
      const result = await client.query(
        `
          INSERT INTO tasks (
            id, title, description, category_id, student_id, repeat_type,
            single_date, weekly_day, monthly_day, custom_dates,
            start_date, end_date, estimated_time, is_archived, created_by, source_key
          )
          VALUES ($1,$2,$3,$4,$5,'once',$6,NULL,NULL,'{}',NULL,NULL,NULL,false,$7,$8)
          ON CONFLICT (student_id, source_key) WHERE source_key IS NOT NULL DO NOTHING
        `,
        [
          makeId('task'),
          lesson.baslik,
          yzProgram.describeLesson(lesson),
          categoryId,
          studentId,
          lesson.tarih,
          createdBy,
          lesson.sourceKey
        ]
      );
      inserted += result.rowCount || 0;
    }

    await client.query('COMMIT');
    return {
      inserted,
      skipped: program.gorevler.length - inserted,
      categories: createdCategories,
      merged,
      removedCategories,
      keptCategories,
      moved,
      pinned
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// --- YDS / YOKDIL takibi ---------------------------------------------------
//
// yds.obs uygulamasi ilerlemeyi AYNI SUNUCUDA bir JSON dosyasinda tutar
// (bkz. ydsSync.js). Burada o dosya okunup takip.obs tablolarina yansitilir:
//   yds_days        -> gunluk kirilim (denetim ekrani)
//   daily_questions -> cozulen sorular (Soru Takibi + Haftalik Analiz'e akar)
// Yansitma idempotenttir; zamanlayicidan sik sik cagrilabilir.

// Verinin hangi ogrenciye yazilacagi. YDS tarafinda Basic Auth kullanicisi
// 'ayhan'; takip.obs'ta ayni kullanici adina sahip ogrenci hedeflenir.
const YDS_STUDENT_USERNAME = normalizeText(process.env.YDS_STUDENT_USERNAME) || 'ayhan';

async function findYdsStudent() {
  const res = await query(
    `SELECT id, name, username FROM users WHERE role = 'student' AND lower(username) = lower($1)`,
    [YDS_STUDENT_USERNAME]
  );
  return res.rowCount > 0 ? res.rows[0] : null;
}

/**
 * Durum dosyasini okuyup ogrencinin YDS tablolarina yansitir.
 * Dosya yoksa/bozuksa hata firlatmaz; sonucu rapor eder ve son hatayi saklar.
 */
async function syncYdsProgress() {
  const student = await findYdsStudent();
  if (!student) {
    return { ok: false, reason: `'${YDS_STUDENT_USERNAME}' kullanıcı adlı öğrenci bulunamadı.` };
  }

  const state = ydsSync.readYdsState();
  if (!state.ok) {
    await query(
      `
        INSERT INTO yds_sync (student_id, last_error)
        VALUES ($1, $2)
        ON CONFLICT (student_id) DO UPDATE SET last_error = EXCLUDED.last_error
      `,
      [student.id, state.reason]
    );
    return { ok: false, reason: state.reason, filePath: state.filePath, student };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // --- Sifirlama yayilimi ---------------------------------------------
    //
    // YDS uygulamasindaki "Ilerlemeyi sifirla" sunucu durumunu bosaltir ve
    // resetAt damgasi birakir; diger cihazlar bu damgayi gorup kendilerini
    // temizler. takip.obs aynasi da bir "cihaz" gibi davranmali: damga
    // ilerlediyse buradaki gecmis de silinir. Aksi halde sifirlama hic
    // yansimazdi — gunler bosalinca dongu hicbir sey yazmaz, eski satirlar
    // sonsuza kadar kalirdi.
    //
    // Silme YALNIZCA damga ilerlediginde olur (idempotent); her senkronda
    // degil. Programdan gelen gorevler (source_key 'ydsp:') ve ogrencinin
    // takip.obs'ta kendi isaretledigi durumlar bundan etkilenmez — onlar
    // YDS ilerlemesi degil, bu uygulamanin kendi kaydi.
    const oncekiRes = await client.query(
      `SELECT source_reset_at AS "sourceResetAt" FROM yds_sync WHERE student_id = $1`,
      [student.id]
    );
    const oncekiReset = oncekiRes.rowCount > 0 ? Number(oncekiRes.rows[0].sourceResetAt) || 0 : 0;
    const sifirlandi = state.resetAt > oncekiReset;

    let removedDays = 0;
    let removedQuestionRows = 0;
    if (sifirlandi) {
      const gunSilme = await client.query(`DELETE FROM yds_days WHERE student_id = $1`, [student.id]);
      removedDays = gunSilme.rowCount || 0;
      const soruSilme = await client.query(
        `DELETE FROM daily_questions WHERE student_id = $1 AND source_key LIKE $2`,
        [student.id, `${ydsSync.SOURCE_PREFIX}:%`]
      );
      removedQuestionRows = soruSilme.rowCount || 0;
    }

    await client.query(
      `
        INSERT INTO yds_sync (
          student_id, goal_okuma, goal_kelime, goal_gramer, goal_test,
          streak_count, streak_max, streak_last_day, plan_start, learned_cards,
          synced_at, last_error, source_reset_at, reset_applied_at
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW(),'',$11,
                CASE WHEN $12::boolean THEN NOW() ELSE NULL END)
        ON CONFLICT (student_id) DO UPDATE SET
          goal_okuma = EXCLUDED.goal_okuma,
          goal_kelime = EXCLUDED.goal_kelime,
          goal_gramer = EXCLUDED.goal_gramer,
          goal_test = EXCLUDED.goal_test,
          streak_count = EXCLUDED.streak_count,
          streak_max = EXCLUDED.streak_max,
          streak_last_day = EXCLUDED.streak_last_day,
          plan_start = EXCLUDED.plan_start,
          learned_cards = EXCLUDED.learned_cards,
          synced_at = NOW(),
          last_error = '',
          source_reset_at = EXCLUDED.source_reset_at,
          reset_applied_at = COALESCE(EXCLUDED.reset_applied_at, yds_sync.reset_applied_at)
      `,
      [
        student.id,
        state.goals.okuma,
        state.goals.kelime,
        state.goals.gramer,
        state.goals.test,
        state.streak.count,
        state.streak.max,
        state.streak.lastDay,
        state.planStart,
        state.learnedCards,
        state.resetAt,
        sifirlandi
      ]
    );

    let gunler = 0;
    let soruSatiri = 0;
    for (const gun of state.days) {
      const hedef = ydsSync.goalStatus(gun, state.goals);
      await client.query(
        `
          INSERT INTO yds_days (
            student_id, day, lessons, decks, quizzes, readings, words_learned,
            questions_solved, scored_questions, questions_correct, goal_met, updated_at
          )
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
          ON CONFLICT (student_id, day) DO UPDATE SET
            lessons = EXCLUDED.lessons,
            decks = EXCLUDED.decks,
            quizzes = EXCLUDED.quizzes,
            readings = EXCLUDED.readings,
            words_learned = EXCLUDED.words_learned,
            questions_solved = EXCLUDED.questions_solved,
            scored_questions = EXCLUDED.scored_questions,
            questions_correct = EXCLUDED.questions_correct,
            goal_met = EXCLUDED.goal_met,
            updated_at = NOW()
        `,
        [
          student.id,
          gun.date,
          gun.lessons,
          gun.decks,
          gun.quizzes,
          gun.readings,
          gun.wordsLearned,
          gun.questionsSolved,
          gun.scoredQuestions,
          gun.questionsCorrect,
          hedef.allDone
        ]
      );
      gunler += 1;

      // Soru Takibi'ne yalnizca soru cozulen gunler yazilir.
      //
      // DIKKAT: dogru/yanlis yalnizca PUANLI testlerden gelir (YDS tarafinda
      // dilbilgisi testleri scored:false). Bu yuzden correct + wrong =
      // scoredQuestions <= questionsSolved. Cozulen toplam `count` sutununda
      // durur; puansiz sorulari "yanlis" saymak veriyi bozardi.
      if (gun.questionsSolved > 0) {
        const not = gun.scoredQuestions
          ? `YDS · ${gun.questionsSolved} soru çözüldü, ${gun.scoredQuestions} tanesi puanlı`
          : `YDS · ${gun.questionsSolved} soru çözüldü (puanlı test yok)`;
        await client.query(
          `
            INSERT INTO daily_questions (
              id, student_id, day, category_id, lesson_name,
              correct_count, wrong_count, duration_minutes, count, note, source_key, updated_at
            )
            VALUES ($1,$2,$3,NULL,'YDS / YÖKDİL',$4,$5,0,$6,$7,$8,NOW())
            ON CONFLICT (student_id, source_key) WHERE source_key IS NOT NULL
            DO UPDATE SET
              correct_count = EXCLUDED.correct_count,
              wrong_count = EXCLUDED.wrong_count,
              count = EXCLUDED.count,
              note = EXCLUDED.note,
              updated_at = NOW()
          `,
          [
            makeId('dq'),
            student.id,
            gun.date,
            gun.questionsCorrect,
            gun.questionsWrong,
            gun.questionsSolved,
            not,
            gun.sourceKey
          ]
        );
        soruSatiri += 1;
      }
    }

    await client.query('COMMIT');
    return {
      ok: true,
      student,
      days: gunler,
      questionRows: soruSatiri,
      filePath: state.filePath,
      reset: sifirlandi,
      removedDays,
      removedQuestionRows
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * YDS programini gorev olarak yazar (YZ aktarimiyla ayni desen).
 *
 * Ek olarak BAYAT GOREV TEMIZLIGI yapar: icerik buyuyup program yeniden
 * uretildiginde bir gunun paketi degisebilir. O gune ait artik programda
 * olmayan gorevler silinir — ama yalnizca ISARETLENMEMIS ve GUNU GELMEMIS
 * olanlar. Gecmis ya da isaretli gorev asla silinmez/oynatilmaz.
 */
const YDS_PROGRAM_SETTINGS_ID = 'default';

/**
 * Doktora programinin CALISMA GUNU ayari (admin belirler).
 *
 * Program dosyasi hafta sonuna gore uretilmistir; kullanici "haftanin her gunu
 * ya da ozel gunler" isteyebilir ve bunun icin deploy beklemek zorunda
 * kalmamali. Ayar burada tutulur, aktarim sirasinda uygulanir.
 */
async function getYdsProgramSettings() {
  const program = ydsProgram.loadYdsProgram();
  const varsayilanGun = ydsPlan.normalizeGunSet(program.gunSet || program.gunDuzeni || 'hafta-sonu');
  const varsayilanDakika = Number(program.gunlukDakika) || ydsPlan.VARSAYILAN_DAKIKA;

  const res = await query(
    `SELECT gun_set AS "gunSet", gunluk_dakika AS "gunlukDakika", updated_at AS "updatedAt"
       FROM yds_program_settings WHERE id = $1`,
    [YDS_PROGRAM_SETTINGS_ID]
  );
  if (res.rowCount === 0) {
    return { gunSet: varsayilanGun, gunlukDakika: varsayilanDakika, isDefault: true, updatedAt: null };
  }
  const row = res.rows[0];
  return {
    gunSet: ydsPlan.normalizeGunSet(row.gunSet),
    gunlukDakika: Number(row.gunlukDakika) || varsayilanDakika,
    isDefault: false,
    updatedAt: row.updatedAt
  };
}

async function saveYdsProgramSettings(gunSet, gunlukDakika) {
  const gunler = ydsPlan.normalizeGunSet(gunSet);
  const dakika = Math.floor(Number(gunlukDakika));
  if (!Number.isFinite(dakika) || dakika < 15 || dakika > 600) {
    return { ok: false, error: 'Günlük süre 15 ile 600 dakika arasında olmalı.' };
  }
  await query(
    `
      INSERT INTO yds_program_settings (id, gun_set, gunluk_dakika, updated_at)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT (id) DO UPDATE
        SET gun_set = EXCLUDED.gun_set,
            gunluk_dakika = EXCLUDED.gunluk_dakika,
            updated_at = NOW()
    `,
    [YDS_PROGRAM_SETTINGS_ID, gunler.join(','), dakika]
  );
  return { ok: true, gunSet: gunler, gunlukDakika: dakika };
}

/**
 * Aktarilacak gorev listesini uretir.
 *
 * Ayar program dosyasiyla AYNIYSA dosya oldugu gibi kullanilir — davranis
 * eskisiyle birebir ayni kalir, yeniden yayma yok. Ayar degistiyse program
 * BUGUNDEN ITIBAREN yeniden yayilir ve su iki kural korunur:
 *
 *   - Gecmis gune yazilmis ya da ISARETLENMIS bir gorevin parcasi yeniden
 *     planlanmaz; islenmis is tekrar onune konmaz.
 *   - Yeni plan yalnizca bugun ve sonrasini kapsar; aktarimdaki silme kurali
 *     zaten gecmise ve isaretliye dokunmuyor.
 */
async function planYdsGorevleri(client, studentId) {
  const program = ydsProgram.loadYdsProgram();
  const ayar = await getYdsProgramSettings();
  const dosyaGun = ydsPlan.normalizeGunSet(program.gunSet || program.gunDuzeni || 'hafta-sonu');

  const ayni =
    ayar.gunSet.join(',') === dosyaGun.join(',') &&
    Number(ayar.gunlukDakika) === Number(program.gunlukDakika);
  if (ayni) {
    return { gorevler: program.gorevler, ayar, yenidenYayildi: false };
  }

  const bugun = todayDateString();

  // Isaretlenmis gorevler yerinde kalir (aktarim onlari zaten silmez), o yuzden
  // ayni occurrence ikinci kez yayilmamali — yoksa tamamladigi is tekrar
  // karsisina cikardi.
  const isaretliRes = await client.query(
    `
      SELECT t.source_key AS "sourceKey"
      FROM tasks t
      WHERE t.student_id = $1
        AND t.source_key LIKE $2
        AND t.single_date >= $3::date
        AND EXISTS (SELECT 1 FROM task_statuses st WHERE st.task_id = t.id)
    `,
    [studentId, `${ydsProgram.SOURCE_PREFIX}:%`, bugun]
  );
  const isaretliAnahtarlar = new Set(isaretliRes.rows.map((r) => r.sourceKey));

  // Dosyadaki planin BUGUN VE SONRASINA dusen kismi — icerik ve tekrar sirasi
  // korunarak yeni gunlere tasinacak. Gecmis gunlere hic dokunulmaz.
  const kalanOccurrences = [];
  for (const gun of program.gunler) {
    if (!gun || typeof gun.tarih !== 'string' || gun.tarih < bugun) continue;
    for (const parca of gun.parcalar || []) {
      if (!parca || !parca.id) continue;
      if (isaretliAnahtarlar.has(ydsProgram.sourceKey(gun.tarih, parca.id))) continue;
      kalanOccurrences.push(parca);
    }
  }

  const dosyaBaslangic = program.baslangic || bugun;
  const baslangic = bugun > dosyaBaslangic ? bugun : dosyaBaslangic;
  const gunler = ydsPlan.calismaGunleri({ gunSet: ayar.gunSet, baslangic });
  const { program: yeniPlan, yerlesmeyen } = ydsPlan.yenidenYay(kalanOccurrences, gunler, {
    gunlukDakika: ayar.gunlukDakika
  });

  return {
    gorevler: ydsProgram.gunlerdenGorevler(yeniPlan, ayar.gunlukDakika),
    ayar,
    yenidenYayildi: true,
    tasinanParca: kalanOccurrences.length,
    yerlesmeyen,
    calismaGunu: gunler.length,
    doluGun: yeniPlan.filter((g) => g.durum === 'dolu').length
  };
}

async function importYdsProgram(studentId, createdBy) {
  const program = ydsProgram.loadYdsProgram();
  if (!program.gorevler.length) {
    return { inserted: 0, updated: 0, removed: 0, skipped: 0, categories: 0 };
  }

  const today = todayDateString();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Aktarilacak liste ya dosyadaki plandir ya da admin gun duzenini
    // degistirmisse bugunden itibaren yeniden yayilmis plandir.
    const plan = await planYdsGorevleri(client, studentId);
    // GECMIS GUNE GOREV YAZILMAZ. Muhurleyici gunu gecmis ve isaretsiz her
    // ornege "yapilmadi" yazar; ogrenci bunu geri alamaz (duzeltmesi yalnizca
    // adminin "Durum Duzelt" panelinde). Yani gecmise yazilan gorev, hicbir
    // zaman yapilamamis bir is olarak kayda geciyordu.
    //
    // Bu suzgec once yalnizca YENIDEN YAYIM durumunda calisiyordu; dosyadaki
    // plan gecmiste basliyorsa (program 14 Eylul'de basliyor, aktarim 19
    // Eylul'de yapiliyor) aradaki gunler yine aciliyordu. Artik her iki
    // durumda da yalnizca bugun ve sonrasi yazilir.
    const planGorevleri = plan.gorevler.filter((g) => g.tarih >= today);

    // TEK kategori: "Doktora". Once tur basina bes kategori aciliyordu
    // (YDS · Konu Anlatimi, Kelime, Okuma, Test, Serbest Calisma); kategori
    // listesi bunlarla doluyordu. Tur bilgisi kaybolmaz: gorev aciklamasinin
    // ilk parcasi hala tur adidir (ydsProgram.describeItem) ve YDS sayfasindaki
    // tur kirilimi tablosu program dosyasindan geldigi icin aynen durur.
    const { categoryId, merged, removedCategories, keptCategories } =
      await consolidateCategoryWith(client, ydsProgram.SOURCE_PREFIX, YDS_CATEGORY);

    // Temiz kurulumda toplama kategori acmaz; aktarim burada aciyor.
    let kategoriId = categoryId;
    let createdCategories = 0;
    if (!kategoriId) {
      const olusan = await ensureCategoryId(client, YDS_CATEGORY);
      kategoriId = olusan.id;
      createdCategories = olusan.created;
    }

    let inserted = 0;
    let updated = 0;
    for (const gorev of planGorevleri) {
      const aciklama = ydsProgram.describeItem(gorev);
      const ekleme = await client.query(
        `
          INSERT INTO tasks (
            id, title, description, category_id, student_id, repeat_type,
            single_date, weekly_day, monthly_day, custom_dates,
            start_date, end_date, estimated_time, is_archived, created_by, source_key
          )
          VALUES ($1,$2,$3,$4,$5,'once',$6,NULL,NULL,'{}',NULL,NULL,NULL,false,$7,$8)
          ON CONFLICT (student_id, source_key) WHERE source_key IS NOT NULL DO NOTHING
        `,
        [
          makeId('task'),
          gorev.baslik,
          aciklama,
          kategoriId,
          studentId,
          gorev.tarih,
          createdBy,
          gorev.sourceKey
        ]
      );

      if (ekleme.rowCount > 0) {
        inserted += 1;
        continue;
      }

      // Zaten var: basligi/aciklamasi degistiyse yalnizca dokunulmamis ve
      // gunu gelmemis gorevi tazele.
      const guncelleme = await client.query(
        `
          UPDATE tasks t
          SET title = $1,
              description = CASE WHEN t.description_edited THEN t.description ELSE $2 END,
              category_id = $3
          WHERE t.student_id = $4
            AND t.source_key = $5
            AND t.single_date >= $6::date
            AND (t.title IS DISTINCT FROM $1
                 OR (NOT t.description_edited AND t.description IS DISTINCT FROM $2)
                 OR t.category_id IS DISTINCT FROM $3)
            AND NOT EXISTS (SELECT 1 FROM task_statuses st WHERE st.task_id = t.id)
        `,
        [gorev.baslik, aciklama, kategoriId, studentId, gorev.sourceKey, today]
      );
      updated += guncelleme.rowCount || 0;
    }

    // Bayat gorevler: programda olmayan, gunu gelmemis, isaretlenmemis olanlar.
    const gecerliAnahtarlar = planGorevleri.map((g) => g.sourceKey);
    const silme = await client.query(
      `
        DELETE FROM tasks t
        WHERE t.student_id = $1
          AND t.source_key LIKE $2
          AND NOT (t.source_key = ANY($3::text[]))
          AND t.single_date >= $4::date
          AND NOT EXISTS (SELECT 1 FROM task_statuses st WHERE st.task_id = t.id)
      `,
      [studentId, `${ydsProgram.SOURCE_PREFIX}:%`, gecerliAnahtarlar, today]
    );

    await client.query('COMMIT');
    return {
      inserted,
      updated,
      removed: silme.rowCount || 0,
      skipped: planGorevleri.length - inserted,
      replanned: plan.yenidenYayildi,
      gunSet: plan.ayar.gunSet,
      gunlukDakika: plan.ayar.gunlukDakika,
      movedPieces: plan.tasinanParca || 0,
      unplaced: plan.yerlesmeyen || 0,
      categories: createdCategories,
      merged,
      removedCategories,
      keptCategories
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** /admin/yds sayfasindaki program paneli icin ozet. */
async function buildYdsProgramSummary(studentId) {
  const program = ydsProgram.loadYdsProgram();
  if (!program.gorevler.length) return null;

  let importedKeys = new Set();
  if (studentId) {
    const res = await query(
      `SELECT source_key AS "sourceKey" FROM tasks WHERE student_id = $1 AND source_key LIKE $2`,
      [studentId, `${ydsProgram.SOURCE_PREFIX}:%`]
    );
    importedKeys = new Set(res.rows.map((r) => r.sourceKey));
  }

  const imported = program.gorevler.filter((g) => importedKeys.has(g.sourceKey)).length;
  const turler = [];
  for (const gorev of program.gorevler) {
    let tur = turler.find((t) => t.ad === gorev.kategoriAd);
    if (!tur) {
      tur = { ad: gorev.kategoriAd, total: 0, imported: 0, sure: 0 };
      turler.push(tur);
    }
    tur.total += 1;
    tur.sure += gorev.sure;
    if (importedKeys.has(gorev.sourceKey)) tur.imported += 1;
  }

  const today = todayDateString();
  const ayar = await getYdsProgramSettings();
  const dosyaGun = ydsPlan.normalizeGunSet(program.gunSet || program.gunDuzeni || 'hafta-sonu');
  // Ayar dosyadan farkliysa aktarim programi yeniden yayacak; arayuz bunu
  // "aktarim bekliyor" olarak gostersin ki degisiklik sessizce asili kalmasin.
  const ayarBekliyor =
    ayar.gunSet.join(',') !== dosyaGun.join(',') ||
    Number(ayar.gunlukDakika) !== Number(program.gunlukDakika);

  // YZ programi hafta ici calisiyor. Doktora hafta ici bir gune tasinirsa iki
  // program ayni gune duser; bu yasak degil ama kullanici bilerek secmeli.
  let cakisanGun = 0;
  if (studentId && ayar.gunSet.some((g) => g >= 1 && g <= 5)) {
    const res = await query(
      `
        SELECT count(DISTINCT single_date)::int AS n
        FROM tasks
        WHERE student_id = $1
          AND source_key LIKE $2
          AND single_date >= $3::date
          AND EXTRACT(dow FROM single_date)::int = ANY($4::int[])
      `,
      [studentId, `${yzProgram.SOURCE_PREFIX}:%`, today, ayar.gunSet]
    );
    cakisanGun = res.rows[0] ? res.rows[0].n : 0;
  }

  return {
    cakisanGun,
    surum: program.surum,
    kaynak: program.kaynak,
    baslangic: program.baslangic,
    bitis: program.bitis,
    gunlukDakika: program.gunlukDakika,
    gunSet: ayar.gunSet,
    gunSetEtiket: ydsPlan.gunSetEtiketi(ayar.gunSet),
    gunSetDuzen: ydsPlan.duzenAdi(ayar.gunSet),
    ayarGunlukDakika: ayar.gunlukDakika,
    ayarBekliyor,
    gunAdlari: ydsPlan.GUN_ADLARI,
    duzenler: Object.entries(ydsPlan.GUN_DUZENLERI).map(([ad, t]) => ({ ad, etiket: t.etiket })),
    toplamParca: program.toplamParca,
    dersGunu: program.dersGunu,
    doluGun: program.doluGun,
    bekleyenGun: program.bekleyenGun,
    total: program.gorevler.length,
    imported,
    // Aktarim gecmis gune yazmadigi icin "bekleyen" yalnizca BUGUN VE
    // SONRASINDAKI aktarilmamis gorevlerdir. Fark (gecmiste kalanlar) ayri
    // sayilir: aksi halde panel kalici bir "8 bekleyen" gosterir ve "Görevlere
    // Aktar" dugmesi her basista 0 gorev ekleyen olu bir kontrole donerdi.
    pending: program.gorevler.filter((g) => g.tarih >= today && !importedKeys.has(g.sourceKey))
      .length,
    pastSkipped: program.gorevler.filter((g) => g.tarih < today && !importedKeys.has(g.sourceKey))
      .length,
    turler,
    upcoming: program.gorevler
      .filter((g) => g.tarih >= today)
      .slice(0, 20)
      .map((g) => ({ ...g, imported: importedKeys.has(g.sourceKey), gunAdi: getDayName(g.tarih) }))
  };
}

/** Admin "YDS Takibi" sayfasinin goruntusu. */
async function buildYdsView(gunSayisi = 30) {
  const student = await findYdsStudent();
  const dosya = ydsSync.stateFilePath();

  if (!student) {
    return {
      student: null,
      filePath: dosya,
      expectedUsername: YDS_STUDENT_USERNAME,
      sync: null,
      rows: [],
      totals: null
    };
  }

  const today = todayDateString();
  const [syncRes, daysRes] = await Promise.all([
    query(
      `
        SELECT goal_okuma AS "okuma", goal_kelime AS "kelime", goal_gramer AS "gramer",
               goal_test AS "test", streak_count AS "streakCount", streak_max AS "streakMax",
               streak_last_day AS "streakLastDay", plan_start AS "planStart",
               learned_cards AS "learnedCards", synced_at AS "syncedAt", last_error AS "lastError",
               reset_applied_at AS "resetAppliedAt"
        FROM yds_sync WHERE student_id = $1
      `,
      [student.id]
    ),
    query(
      `
        SELECT day, lessons, decks, quizzes, readings, words_learned AS "wordsLearned",
               questions_solved AS "questionsSolved", scored_questions AS "scoredQuestions",
               questions_correct AS "questionsCorrect", goal_met AS "goalMet"
        FROM yds_days
        WHERE student_id = $1 AND day >= $2
        ORDER BY day DESC
      `,
      [student.id, shiftDate(today, -(gunSayisi - 1))]
    )
  ]);

  const rows = daysRes.rows.map((row) => {
    const scored = Number(row.scoredQuestions) || 0;
    const correct = Number(row.questionsCorrect) || 0;
    return {
      date: toDateOnly(row.day),
      gunAdi: getDayName(toDateOnly(row.day)),
      lessons: Number(row.lessons) || 0,
      decks: Number(row.decks) || 0,
      quizzes: Number(row.quizzes) || 0,
      readings: Number(row.readings) || 0,
      wordsLearned: Number(row.wordsLearned) || 0,
      questionsSolved: Number(row.questionsSolved) || 0,
      scoredQuestions: scored,
      questionsCorrect: correct,
      // Veri yoksa null doner ve arayuzde '-' gosterilir (%0 ile karistirilmamali).
      accuracy: scored ? Math.round((correct / scored) * 100) : null,
      goalMet: row.goalMet
    };
  });

  const toplam = rows.reduce(
    (acc, r) => {
      acc.lessons += r.lessons;
      acc.decks += r.decks;
      acc.quizzes += r.quizzes;
      acc.readings += r.readings;
      acc.wordsLearned += r.wordsLearned;
      acc.questionsSolved += r.questionsSolved;
      acc.scoredQuestions += r.scoredQuestions;
      acc.questionsCorrect += r.questionsCorrect;
      if (r.goalMet) acc.goalDays += 1;
      return acc;
    },
    {
      lessons: 0,
      decks: 0,
      quizzes: 0,
      readings: 0,
      wordsLearned: 0,
      questionsSolved: 0,
      scoredQuestions: 0,
      questionsCorrect: 0,
      goalDays: 0
    }
  );

  const sync = syncRes.rowCount > 0 ? syncRes.rows[0] : null;

  return {
    student,
    filePath: dosya,
    expectedUsername: YDS_STUDENT_USERNAME,
    gunSayisi,
    sync: sync
      ? {
          goals: {
            okuma: sync.okuma,
            kelime: sync.kelime,
            gramer: sync.gramer,
            test: sync.test
          },
          streakCount: sync.streakCount,
          streakMax: sync.streakMax,
          streakLastDay: toDateOnly(sync.streakLastDay),
          planStart: toDateOnly(sync.planStart),
          learnedCards: sync.learnedCards,
          syncedAt: sync.syncedAt,
          resetAppliedAt: sync.resetAppliedAt,
          lastError: sync.lastError || ''
        }
      : null,
    rows,
    totals: {
      ...toplam,
      dayCount: rows.length,
      accuracy: toplam.scoredQuestions
        ? Math.round((toplam.questionsCorrect / toplam.scoredQuestions) * 100)
        : null
    }
  };
}

// --- Okul ders programi ----------------------------------------------------
//
// Uygulama sahibinin (ogretmen) haftalik cizelgesi; ogrenci basina degil,
// uygulama genelinde tek programdir. Zil saatleri saklanmaz, ayardan
// hesaplanir (bkz. schedule.js).

const SCHEDULE_SETTINGS_ID = 'default';

function mapScheduleEntry(row) {
  return {
    id: row.id,
    term: Number(row.term) || 0,
    dayOfWeek: Number(row.dayOfWeek),
    period: Number(row.period),
    subject: row.subject,
    className: row.className || '',
    room: row.room || '',
    kind: row.kind || 'lesson'
  };
}

/** Zil ayarlarini okur; kayit yoksa varsayilani doner (yazmaz). */
async function getScheduleSettings() {
  const res = await query(
    `
      SELECT start_time AS "startTime", lesson_minutes AS "lessonMinutes",
             break_minutes AS "breakMinutes", period_count AS "periodCount",
             lunch_after_period AS "lunchAfterPeriod", lunch_minutes AS "lunchMinutes"
      FROM school_settings WHERE id = $1
    `,
    [SCHEDULE_SETTINGS_ID]
  );
  if (res.rowCount === 0) return { ...schedule.VARSAYILAN_AYAR, isDefault: true };
  const row = res.rows[0];
  return {
    startTime: normalizeEstimatedTimeForDisplay(row.startTime) || schedule.VARSAYILAN_AYAR.startTime,
    lessonMinutes: Number(row.lessonMinutes),
    breakMinutes: Number(row.breakMinutes),
    periodCount: Number(row.periodCount),
    lunchAfterPeriod: row.lunchAfterPeriod === null ? null : Number(row.lunchAfterPeriod),
    lunchMinutes: Number(row.lunchMinutes),
    isDefault: false
  };
}

/**
 * HAFTAYA OZEL CIZELGE.
 *
 * `week_start = SABLON_HAFTA` satirlari varsayilan haftalik sablondur; baska
 * bir tarih o haftanin kendi cizelgesidir. Bir hafta ozellestirilmisse o hafta
 * icin sablon HIC kullanilmaz, yalnizca o satirlar gecerlidir.
 *
 * Neden birlestirme degil tam degistirme: birlestirme "bu hafta bu ders yok"u
 * ifade edemezdi (silinen hucre icin mezar tasi satiri gerekirdi). Tam
 * degistirmede ozellestirme sablonu o haftaya KOPYALAYARAK baslar, sonra
 * istenen hucreler eklenir/silinir; "bu hafta hic ders yok" da bos birakarak
 * anlatilir.
 */
const SABLON_HAFTA = '1900-01-01';

const SCHEDULE_SELECT = `
  SELECT id, term, day_of_week AS "dayOfWeek", period, subject,
         class_name AS "className", room, kind, week_start AS "weekStart"
  FROM class_schedule
  WHERE week_start = $1
  ORDER BY day_of_week ASC, period ASC
`;

/** Hafta OZELLESTIRILMIS mi? Isaret `schedule_week_overrides`'tadir. */
async function isWeekOverridden(weekStart) {
  const res = await query(`SELECT 1 FROM schedule_week_overrides WHERE week_start = $1`, [weekStart]);
  return res.rowCount > 0;
}

/**
 * Bir haftanin GECERLI cizelgesi (hafta verilmezse varsayilan sablon).
 *
 * Olcut satir varligi DEGIL isarettir: isaretli bir hafta BOS da olabilir
 * ("bu hafta ders yok") ve o zaman sablona donmemelidir.
 */
async function getScheduleEntries(weekStart = null) {
  const hafta = isDateOnly(weekStart) ? startOfWeek(weekStart) : null;
  if (hafta && (await isWeekOverridden(hafta))) {
    const ozel = await query(SCHEDULE_SELECT, [hafta]);
    return ozel.rows.map(mapScheduleEntry);
  }
  const sablon = await query(SCHEDULE_SELECT, [SABLON_HAFTA]);
  return sablon.rows.map(mapScheduleEntry);
}

/**
 * Ogretim yilindaki TUM ozellestirilmis haftalar: weekStart -> kayitlar.
 * Bos ozel haftalar da haritaya BOS DIZI olarak girer — yoksa defter
 * hesabinda sablona duserlerdi.
 */
async function getCustomScheduleWeeks() {
  const [isaretler, satirlar] = await Promise.all([
    query(`SELECT week_start AS "weekStart" FROM schedule_week_overrides`),
    query(
      `
        SELECT id, term, day_of_week AS "dayOfWeek", period, subject,
               class_name AS "className", room, kind, week_start AS "weekStart"
        FROM class_schedule
        WHERE week_start <> $1
        ORDER BY week_start ASC, day_of_week ASC, period ASC
      `,
      [SABLON_HAFTA]
    )
  ]);

  const harita = new Map();
  for (const row of isaretler.rows) harita.set(toDateOnly(row.weekStart), []);
  for (const row of satirlar.rows) {
    const hafta = toDateOnly(row.weekStart);
    if (!harita.has(hafta)) harita.set(hafta, []);
    harita.get(hafta).push(mapScheduleEntry(row));
  }
  return harita;
}

/** Bir hafta ozellestirilmis mi, kac satiri var? */
async function getWeekScheduleInfo(weekStart) {
  const [isaret, sayim] = await Promise.all([
    isWeekOverridden(weekStart),
    query(`SELECT COUNT(*)::int AS n FROM class_schedule WHERE week_start = $1`, [weekStart])
  ]);
  return { ozel: isaret, satirSayisi: sayim.rows[0].n };
}

/** Bir haftanin islenen konu kayitlari. */
async function getLessonTopics(weekStart) {
  const res = await query(
    `
      SELECT day_of_week AS "dayOfWeek", period, subject, class_name AS "className", topic
      FROM lesson_topics
      WHERE week_start = $1
    `,
    [weekStart]
  );
  return new Map(res.rows.map((r) => [`${r.dayOfWeek}:${r.period}`, r]));
}

/**
 * "İşlenen Konular" gorunumu: cizelgeyle AYNI izgara, ama secili haftada her
 * dolu ders saatine konu yazilir. Tatil/bayrama denk gelen gunlerde giris
 * alani acilmaz — o gun ders islenmedi.
 */
async function buildTopicWeekView(req, ayar) {
  const today = todayDateString();
  const weekStart = normalizeWeekStart(normalizeText(req.query.hafta), today) || startOfWeek(today);
  const weekEnd = shiftDate(weekStart, 6);

  const [konular, oncekiKonular] = await Promise.all([
    getLessonTopics(weekStart),
    getLessonTopics(shiftDate(weekStart, -7))
  ]);

  // O HAFTANIN cizelgesi: hafta ozellestirilmisse kendi satirlari, degilse
  // sablon. Defter, o hafta gercekten ne okutulduguna gore acilir.
  const kayitlar = await getScheduleEntries(weekStart);
  const haftaBilgi = await getWeekScheduleInfo(weekStart);

  const saatler = schedule.buildPeriods(ayar);
  const kayitByKey = new Map(kayitlar.map((k) => [`${k.dayOfWeek}:${k.period}`, k]));

  // Gun basliklari: haftanin gercek tarihleri + takvim durumu.
  const gunler = schedule.GUNLER.map((gun) => {
    const tarih = shiftDate(weekStart, gun - 1);
    const bilgi = academicCalendar.getDayInfo(tarih);
    return {
      dayOfWeek: gun,
      gunAdi: schedule.GUN_ADLARI[gun],
      tarih,
      isSchoolDay: bilgi.isSchoolDay,
      // Rozet YALNIZCA bilgi: bayram/ara tatil/yariyil isaretlenir ki yanlis
      // haftaya yazilmasin. Hicbir hücreyi kapatmaz — tatilde de ders
      // islenebilir.
      olagandisi: isUnusualCalendarDay(tarih),
      dayLabel: bilgi.label
    };
  });

  const izgara = saatler.map((saat) => ({
    ...saat,
    hucreler: gunler.map((g) => {
      const anahtar = `${g.dayOfWeek}:${saat.period}`;
      const ders = kayitByKey.get(anahtar) || null;
      const kayit = konular.get(anahtar) || null;
      const onceki = oncekiKonular.get(anahtar) || null;
      return {
        ...g,
        entry: ders,
        topic: kayit ? kayit.topic : '',
        oncekiTopic: onceki && onceki.topic ? onceki.topic : ''
      };
    })
  }));

  // Nobet saatine de konu yazilabildigi icin payda TUM dolu hucreleri sayar;
  // yalnizca dersleri saysaydi hepsi doldugunda "15 / 14" gibi bir sayac cikardi.
  const yazilabilir = izgara.reduce(
    (t, satir) => t + satir.hucreler.filter((h) => h.entry).length,
    0
  );
  const dolu = izgara.reduce(
    (t, satir) => t + satir.hucreler.filter((h) => h.entry && h.topic).length,
    0
  );

  // Excel disa aktarim varsayilani: icinde bulunulan donem (yoksa tum yil).
  const donem =
    academicCalendar.ACADEMIC_YEAR.terms.find((t) => today >= t.start && today <= t.end) || null;

  // Bu haftanin defter gorevi hangi durumda?
  const buHaftaGorev = await query(
    `
      SELECT t.id, u.name AS "studentName",
             (SELECT st.status FROM task_statuses st WHERE st.task_id = t.id LIMIT 1) AS status
      FROM tasks t JOIN users u ON u.id = t.student_id
      WHERE t.source_key = $1
      LIMIT 1
    `,
    [lessonLogSourceKey(weekStart)]
  );

  return {
    weekStart,
    weekEnd,
    prevWeekStart: shiftDate(weekStart, -7),
    nextWeekStart: shiftDate(weekStart, 7),
    thisWeekStart: startOfWeek(today),
    logTask: buHaftaGorev.rowCount
      ? {
          studentName: buHaftaGorev.rows[0].studentName,
          status: buHaftaGorev.rows[0].status || 'not_set'
        }
      : null,
    exportFrom: donem ? donem.start : academicCalendar.ACADEMIC_YEAR.start,
    exportTo: donem ? donem.end : academicCalendar.ACADEMIC_YEAR.end,
    exportLabel: donem ? donem.label : 'Öğretim yılı',
    academic: academicCalendar.describeWeek(weekStart, weekEnd),
    ozelHafta: haftaBilgi.ozel,
    gunler,
    izgara,
    yazilabilir,
    dolu
  };
}

// --- Ders defteri gorevleri ------------------------------------------------
//
// Her okul haftasi icin tek gorev: "Ders defterini doldur". O haftanin TUM
// yazilabilir ders saatlerine konu girilince gorev otomatik "yapildi"
// isaretlenir. Ders basina ayri gorev acmak haftada 15 gorev demekti; YZ ve
// YDS gorevlerinin ustune binmesin diye haftalik tek denetim tercih edildi.
//
// Gorev haftanin SON GUNUNE (pazar) tarihlenir: defter haftalik bir kayittir,
// dogal son tarihi haftanin bitisidir. Cuma'ya tarihlenseydi cumartesi
// doldurmak otomatik kilide takilip kalici "yapilmadi" olurdu.

const LESSON_LOG_PREFIX = 'defter';
const LESSON_LOG_CATEGORY = 'Ders Defteri';
// Otomatik tamamlamada geriye kac hafta taranir.
const LESSON_LOG_LOOKBACK_WEEKS = 10;

function lessonLogSourceKey(weekStart) {
  return `${LESSON_LOG_PREFIX}:${weekStart}`;
}

function isLessonLogTask(sourceKey) {
  return typeof sourceKey === 'string' && sourceKey.startsWith(`${LESSON_LOG_PREFIX}:`);
}

/**
 * Ogretim yilindaki haftalar: her biri icin o hafta kac ders saatine konu
 * yazilabilecegini hesaplar. Yazilacak sey yoksa hafta listeye girmez — bos
 * gorev acilmaz.
 *
 * Her hafta KENDI cizelgesiyle hesaplanir: ozellestirilmis haftalar kendi
 * satirlarini, digerleri sablonu kullanir. Tatil takvimi artik hicbir seyi
 * elemez; "bu hafta defter gorevi olmasin" demenin yolu o haftanin
 * cizelgesini BOSALTMAKTIR (ozellestir + hepsini sil).
 */
function buildLessonLogWeeks(sablon, ozelHaftalar, ayar) {
  const { start, end } = academicCalendar.ACADEMIC_YEAR;
  const haftalar = [];

  let weekStart = startOfWeek(start);
  while (weekStart <= end) {
    const haftaninKayitlari = ozelHaftalar.get(weekStart) || sablon;
    let yazilabilir = 0;
    for (const gun of schedule.GUNLER) {
      const tarih = shiftDate(weekStart, gun - 1);
      if (tarih < start || tarih > end) continue;
      yazilabilir += haftaninKayitlari.filter((e) => e.dayOfWeek === gun).length;
    }

    if (yazilabilir > 0) {
      const weekEnd = shiftDate(weekStart, 6);
      haftalar.push({
        weekStart,
        weekEnd,
        dueDate: weekEnd, // pazar
        yazilabilir,
        kayitlar: haftaninKayitlari,
        academic: academicCalendar.describeWeek(weekStart, weekEnd)
      });
    }
    weekStart = shiftDate(weekStart, 7);
  }

  return haftalar;
}

function lessonLogTitle(hafta) {
  const no = hafta.academic && hafta.academic.weekNo ? ` (${hafta.academic.weekNo}. hafta)` : '';
  return `Ders defterini doldur${no}`;
}

function lessonLogDescription(hafta) {
  const donem = hafta.academic && hafta.academic.termLabel ? `${hafta.academic.termLabel} · ` : '';
  return `${donem}${hafta.weekStart} - ${hafta.weekEnd} · ${hafta.yazilabilir} ders saati`;
}

/**
 * Defter gorevlerini olusturur/tazeler. YZ ve YDS aktarimlariyla ayni desen:
 * yeni haftalari ekler, degisen basligi yalnizca ISARETLENMEMIS ve GUNU
 * GELMEMIS gorevlerde tazeler, artik gecerli olmayan haftalarin (yine yalnizca
 * isaretlenmemis + gelecek) gorevlerini siler.
 */
async function importLessonLogTasks(studentId, createdBy) {
  const [ayar, sablon, ozelHaftalar] = await Promise.all([
    getScheduleSettings(),
    getScheduleEntries(),
    getCustomScheduleWeeks()
  ]);
  const haftalar = buildLessonLogWeeks(sablon, ozelHaftalar, ayar);
  if (!haftalar.length) {
    return { inserted: 0, updated: 0, removed: 0, skipped: 0, categories: 0, weeks: 0 };
  }

  const today = todayDateString();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let createdCategories = 0;
    const mevcut = await client.query(`SELECT id FROM categories WHERE name = $1`, [
      LESSON_LOG_CATEGORY
    ]);
    let categoryId;
    if (mevcut.rowCount > 0) {
      categoryId = mevcut.rows[0].id;
    } else {
      categoryId = makeId('cat');
      await client.query(`INSERT INTO categories (id, name) VALUES ($1, $2)`, [
        categoryId,
        LESSON_LOG_CATEGORY
      ]);
      createdCategories = 1;
    }

    let inserted = 0;
    let updated = 0;
    for (const hafta of haftalar) {
      const sourceKey = lessonLogSourceKey(hafta.weekStart);
      const baslik = lessonLogTitle(hafta);
      const aciklama = lessonLogDescription(hafta);

      const ekleme = await client.query(
        `
          INSERT INTO tasks (
            id, title, description, category_id, student_id, repeat_type,
            single_date, weekly_day, monthly_day, custom_dates,
            start_date, end_date, estimated_time, is_archived, created_by, source_key
          )
          VALUES ($1,$2,$3,$4,$5,'once',$6,NULL,NULL,'{}',NULL,NULL,NULL,false,$7,$8)
          ON CONFLICT (student_id, source_key) WHERE source_key IS NOT NULL DO NOTHING
        `,
        [makeId('task'), baslik, aciklama, categoryId, studentId, hafta.dueDate, createdBy, sourceKey]
      );

      if (ekleme.rowCount > 0) {
        inserted += 1;
        continue;
      }

      const guncelleme = await client.query(
        `
          UPDATE tasks t
          SET title = $1,
              description = CASE WHEN t.description_edited THEN t.description ELSE $2 END,
              category_id = $3,
              single_date = $4
          WHERE t.student_id = $5
            AND t.source_key = $6
            AND t.single_date >= $7::date
            AND (t.title IS DISTINCT FROM $1
                 OR (NOT t.description_edited AND t.description IS DISTINCT FROM $2)
                 OR t.single_date IS DISTINCT FROM $4::date)
            AND NOT EXISTS (SELECT 1 FROM task_statuses st WHERE st.task_id = t.id)
        `,
        [baslik, aciklama, categoryId, hafta.dueDate, studentId, sourceKey, today]
      );
      updated += guncelleme.rowCount || 0;
    }

    const gecerli = haftalar.map((h) => lessonLogSourceKey(h.weekStart));
    const silme = await client.query(
      `
        DELETE FROM tasks t
        WHERE t.student_id = $1
          AND t.source_key LIKE $2
          AND NOT (t.source_key = ANY($3::text[]))
          AND t.single_date >= $4::date
          AND NOT EXISTS (SELECT 1 FROM task_statuses st WHERE st.task_id = t.id)
      `,
      [studentId, `${LESSON_LOG_PREFIX}:%`, gecerli, today]
    );

    await client.query('COMMIT');
    return {
      inserted,
      updated,
      removed: silme.rowCount || 0,
      skipped: haftalar.length - inserted,
      categories: createdCategories,
      weeks: haftalar.length
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Defteri tamamlanan haftalarin gorevini otomatik "yapildi" isaretler.
 *
 * Otomatik kilitten ONCE calismali (bkz. runSealSafely): kilit once calissa
 * pazar gunu tamamlanan bir defter "yapilmadi" muhurlenmis olurdu.
 * Idempotenttir; zaten isaretli gorev ON CONFLICT ile atlanir.
 */
async function completeLessonLogTasks() {
  const [ayar, sablon, ozelHaftalar] = await Promise.all([
    getScheduleSettings(),
    getScheduleEntries(),
    getCustomScheduleWeeks()
  ]);
  if (!sablon.length && ozelHaftalar.size === 0) return { completed: 0 };

  const today = todayDateString();
  const enEski = startOfWeek(shiftDate(today, -7 * LESSON_LOG_LOOKBACK_WEEKS));

  const gorevler = await query(
    `
      SELECT t.id, t.student_id AS "studentId", t.source_key AS "sourceKey", t.single_date AS "singleDate"
      FROM tasks t
      WHERE t.source_key LIKE $1
        AND NOT EXISTS (SELECT 1 FROM task_statuses st WHERE st.task_id = t.id)
    `,
    [`${LESSON_LOG_PREFIX}:%`]
  );
  if (gorevler.rowCount === 0) return { completed: 0 };

  const haftaByKey = new Map(
    buildLessonLogWeeks(sablon, ozelHaftalar, ayar).map((h) => [lessonLogSourceKey(h.weekStart), h])
  );

  let completed = 0;
  for (const gorev of gorevler.rows) {
    const hafta = haftaByKey.get(gorev.sourceKey);
    if (!hafta || hafta.weekStart < enEski) continue;

    const konular = await getLessonTopics(hafta.weekStart);
    let dolu = 0;
    for (const [anahtar, kayit] of konular) {
      if (!kayit.topic) continue;
      const [gun, saat] = anahtar.split(':').map(Number);
      if (!hafta.kayitlar.some((k) => k.dayOfWeek === gun && k.period === saat)) continue;
      dolu += 1;
    }

    if (dolu < hafta.yazilabilir) continue;

    const yazma = await query(
      `
        INSERT INTO task_statuses (id, task_id, student_id, day, status, note)
        VALUES ($1,$2,$3,$4,'done','Defter tamamlandığı için otomatik işaretlendi.')
        ON CONFLICT (task_id, student_id, day) DO NOTHING
      `,
      [makeId('status'), gorev.id, gorev.studentId, toDateOnly(gorev.singleDate)]
    );
    completed += yazma.rowCount || 0;
  }

  return { completed };
}

/**
 * Ogrenci tarafi ders programi: AYNI izgara, SALT OKUNUR.
 *
 * Cizelge ve ders defteri ogretmenin (admin) kaydidir; ogrenci gorur ama
 * duzenleyemez. Ileride baska ogrenciler eklendiginde de bu ayrim gecerli
 * kalir — program uygulama genelinde tektir, herkes ayni cizelgeyi gorur.
 */
async function buildStudentScheduleView(req) {
  // Ogrenci tarafinda varsayilan BU HAFTA'dir: cizelge haftadan haftaya
  // degisebildigi icin "o hafta ne var" sorusunun cevabi budur.
  const bugun = todayDateString();
  const haftaParam = normalizeText(req.query.hafta);
  const hafta = isDateOnly(haftaParam) ? startOfWeek(haftaParam) : startOfWeek(bugun);

  const [ayar, kayitlar] = await Promise.all([
    getScheduleSettings(),
    getScheduleEntries(hafta)
  ]);
  const haftaBilgi = await getWeekScheduleInfo(hafta);
  const gorunum = normalizeText(req.query.gorunum) === 'konular' ? 'konular' : 'cizelge';

  return {
    gorunum,
    canEditTopics: req.currentUser.isTeacher === true,
    hafta,
    haftaSonu: shiftDate(hafta, 6),
    oncekiHafta: shiftDate(hafta, -7),
    sonrakiHafta: shiftDate(hafta, 7),
    buHafta: startOfWeek(bugun),
    ozelHafta: haftaBilgi.ozel,
    haftaAkademik: academicCalendar.describeWeek(hafta, shiftDate(hafta, 6)),
    ayar,
    saatler: schedule.buildPeriods(ayar),
    izgara: schedule.buildGrid(kayitlar, ayar),
    bitisSaati: schedule.endOfDay(ayar),
    toplamDers: kayitlar.filter((k) => k.kind === 'lesson').length,
    varMi: kayitlar.length > 0,
    gunSayilari: schedule.GUNLER.map((gun) => ({
      dayOfWeek: gun,
      gunAdi: schedule.GUN_ADLARI[gun],
      dersSayisi: kayitlar.filter((k) => k.dayOfWeek === gun && k.kind === 'lesson').length,
      bosSaat: ayar.periodCount - kayitlar.filter((k) => k.dayOfWeek === gun).length
    })),
    topicWeek: gorunum === 'konular' ? await buildTopicWeekView(req, ayar) : null
  };
}

// --- Aylik hedefler --------------------------------------------------------
//
// Serbest metin hedef + ELLE kanit. Uygulama hedefi kendi olcemez (olculebilir
// hedef secilmedi), bu yuzden "kanit" su iki sekilde saglanir:
//   1. "Basarildi" isaretlemek icin kanit metni ZORUNLU - rota bos kaniti
//      reddeder. Boylece kayit kuru bir "yaptim" beyani olmaz.
//   2. Hedefin yanina o AYIN gercek verisi konur (tamamlanan gorev, cozulen
//      soru, dogruluk, calisma suresi, zamaninda uyanma). Kanit metni bu
//      sayilarla karsilastirilabilir olur.

const GOAL_STATUS_LABELS = {
  pending: 'Bekliyor',
  achieved: 'Başarıldı',
  missed: 'Başarılamadı'
};

/** 'YYYY-MM' ya da 'YYYY-MM-DD' girdisini ayin ilk gunune indirger. */
function normalizeMonthStart(value, fallbackToday) {
  const metin = normalizeText(value);
  const eslesme = /^(\d{4})-(\d{2})/.exec(metin);
  if (eslesme) {
    const ay = Number(eslesme[2]);
    if (ay >= 1 && ay <= 12) return `${eslesme[1]}-${eslesme[2]}-01`;
  }
  if (!fallbackToday) return null;
  return `${fallbackToday.slice(0, 7)}-01`;
}

function shiftMonth(monthStart, delta) {
  const [yil, ay] = monthStart.split('-').map(Number);
  const toplam = yil * 12 + (ay - 1) + delta;
  const yeniYil = Math.floor(toplam / 12);
  const yeniAy = (toplam % 12) + 1;
  return `${yeniYil}-${String(yeniAy).padStart(2, '0')}-01`;
}

const AY_ADLARI = [
  '',
  'Ocak',
  'Şubat',
  'Mart',
  'Nisan',
  'Mayıs',
  'Haziran',
  'Temmuz',
  'Ağustos',
  'Eylül',
  'Ekim',
  'Kasım',
  'Aralık'
];

function monthLabel(monthStart) {
  const [yil, ay] = monthStart.split('-').map(Number);
  return `${AY_ADLARI[ay]} ${yil}`;
}

/**
 * Bir ogrencinin bir aydaki gercek kaydi. Hedefin kaniti elle yazilir ama
 * yaninda bu sayilar durur; beyan bunlarla karsilastirilabilir olsun diye.
 */
async function buildMonthFacts(studentId, monthStart) {
  const monthEnd = shiftDate(shiftMonth(monthStart, 1), -1);

  const [statusRes, questionRes, wakeRes, sportRes] = await Promise.all([
    query(
      `
        SELECT
          COUNT(*) FILTER (WHERE status = 'done')::int AS "done",
          COUNT(*)::int AS "total"
        FROM task_statuses
        WHERE student_id = $1 AND day BETWEEN $2 AND $3
      `,
      [studentId, monthStart, monthEnd]
    ),
    query(
      `
        SELECT
          COALESCE(SUM(count), 0)::int AS "solved",
          COALESCE(SUM(correct_count), 0)::int AS "correct",
          COALESCE(SUM(wrong_count), 0)::int AS "wrong",
          COALESCE(SUM(duration_minutes), 0)::int AS "duration"
        FROM daily_questions
        WHERE student_id = $1 AND day BETWEEN $2 AND $3
      `,
      [studentId, monthStart, monthEnd]
    ),
    query(
      `
        SELECT
          COUNT(*)::int AS "tracked",
          COUNT(*) FILTER (WHERE status = 'on_time')::int AS "onTime"
        FROM wake_logs
        WHERE student_id = $1 AND day BETWEEN $2 AND $3
      `,
      [studentId, monthStart, monthEnd]
    ),
    query(
      `
        SELECT
          COUNT(*)::int AS "tracked",
          COUNT(*) FILTER (WHERE status = 'on_time')::int AS "onTime"
        FROM sport_logs
        WHERE student_id = $1 AND day BETWEEN $2 AND $3
      `,
      [studentId, monthStart, monthEnd]
    )
  ]);

  const gorev = statusRes.rows[0];
  const soru = questionRes.rows[0];
  const uyanma = wakeRes.rows[0];
  const spor = sportRes.rows[0];
  const scored = soru.correct + soru.wrong;

  return {
    monthStart,
    monthEnd,
    taskDone: gorev.done,
    taskTotal: gorev.total,
    // Veri yoksa oran null doner ve arayuzde "-" gorunur; %0 ile karistirilmasin.
    taskRate: gorev.total > 0 ? Math.round((gorev.done / gorev.total) * 1000) / 10 : null,
    questionsSolved: soru.solved,
    accuracy: scored > 0 ? Math.round((soru.correct / scored) * 1000) / 10 : null,
    duration: soru.duration,
    wakeTracked: uyanma.tracked,
    wakeOnTime: uyanma.onTime,
    wakeRate: uyanma.tracked > 0 ? Math.round((uyanma.onTime / uyanma.tracked) * 1000) / 10 : null,
    sportTracked: spor.tracked,
    sportOnTime: spor.onTime
  };
}

/** Admin "Aylık Hedefler" sayfasinin goruntusu. */
async function buildMonthlyGoalsView(req, students) {
  const today = todayDateString();
  const monthStart = normalizeMonthStart(req.query.ay, today);
  const secilenIdRaw = normalizeText(req.query.goalStudentId);
  const secilen = students.find((s) => s.id === secilenIdRaw) || students[0] || null;

  const goalsRes = secilen
    ? await query(
        `
          SELECT id, title, description, status, evidence,
                 evaluated_at AS "evaluatedAt"
          FROM monthly_goals
          WHERE student_id = $1 AND month_start = $2
          ORDER BY created_at ASC
        `,
        [secilen.id, monthStart]
      )
    : { rows: [] };

  const goals = goalsRes.rows.map((row) => ({
    ...row,
    statusLabel: GOAL_STATUS_LABELS[row.status] || row.status
  }));

  return {
    monthStart,
    monthLabel: monthLabel(monthStart),
    prevMonth: shiftMonth(monthStart, -1),
    nextMonth: shiftMonth(monthStart, 1),
    thisMonth: `${today.slice(0, 7)}-01`,
    student: secilen,
    students,
    goals,
    counts: {
      total: goals.length,
      achieved: goals.filter((g) => g.status === 'achieved').length,
      missed: goals.filter((g) => g.status === 'missed').length,
      pending: goals.filter((g) => g.status === 'pending').length
    },
    facts: secilen ? await buildMonthFacts(secilen.id, monthStart) : null
  };
}

/** Admin "Ders Programı" sayfasinin goruntusu. */
async function buildScheduleView(req) {
  // Cizelge artik HAFTAYA OZEL olabiliyor. `?hafta=` verilmezse VARSAYILAN
  // SABLON duzenlenir (eski davranis); bir hafta secilirse o haftanin kendi
  // izgarasi acilir.
  const bugun = todayDateString();
  const haftaParam = normalizeText(req.query.hafta);
  const sablonModu = !isDateOnly(haftaParam);
  const hafta = sablonModu ? null : startOfWeek(haftaParam);

  const [ayar, kayitlar] = await Promise.all([
    getScheduleSettings(),
    getScheduleEntries(hafta)
  ]);
  const haftaBilgi = hafta ? await getWeekScheduleInfo(hafta) : { ozel: false, satirSayisi: 0 };
  const saatler = schedule.buildPeriods(ayar);
  const izgara = schedule.buildGrid(kayitlar, ayar);
  const gorunum = normalizeText(req.query.gorunum) === 'konular' ? 'konular' : 'cizelge';
  const topicWeek = gorunum === 'konular' ? await buildTopicWeekView(req, ayar) : null;

  // Form on dolgusu: bos hucreye basilinca gun/saat secili gelsin.
  const formDay = Number(normalizeText(req.query.gun)) || '';
  const formPeriod = Number(normalizeText(req.query.saat)) || '';
  const duzenlenen = normalizeText(req.query.duzenle)
    ? kayitlar.find((k) => k.id === normalizeText(req.query.duzenle)) || null
    : null;

  const gunSayilari = schedule.GUNLER.map((gun) => ({
    dayOfWeek: gun,
    gunAdi: schedule.GUN_ADLARI[gun],
    dersSayisi: kayitlar.filter((k) => k.dayOfWeek === gun && k.kind === 'lesson').length,
    nobet: kayitlar.some((k) => k.dayOfWeek === gun && k.kind === 'duty'),
    bosSaat: ayar.periodCount - kayitlar.filter((k) => k.dayOfWeek === gun).length
  }));

  // Ogretmen isareti tasiyan ogrenci defteri kendi panelinden yazabilir.
  const ogrenciler = await query(
    `SELECT id, name, is_teacher AS "isTeacher" FROM users WHERE role = 'student' ORDER BY name`
  );

  return {
    gorunum,
    topicWeek,
    ayar,
    saatler,
    izgara,
    kayitlar,
    gunSayilari,
    // Hafta secimi: sablonModu ise varsayilan sablon duzenleniyor demektir.
    sablonModu,
    hafta,
    haftaSonu: hafta ? shiftDate(hafta, 6) : null,
    oncekiHafta: shiftDate(hafta || startOfWeek(bugun), -7),
    sonrakiHafta: shiftDate(hafta || startOfWeek(bugun), 7),
    buHafta: startOfWeek(bugun),
    ozelHafta: haftaBilgi.ozel,
    haftaAkademik: hafta
      ? academicCalendar.describeWeek(hafta, shiftDate(hafta, 6))
      : null,
    ogrenciler: ogrenciler.rows,
    bitisSaati: schedule.endOfDay(ayar),
    toplamDers: kayitlar.filter((k) => k.kind === 'lesson').length,
    toplamNobet: kayitlar.filter((k) => k.kind === 'duty').length,
    form: duzenlenen
      ? {
          isEdit: true,
          id: duzenlenen.id,
          dayOfWeek: duzenlenen.dayOfWeek,
          period: duzenlenen.period,
          subject: duzenlenen.subject,
          className: duzenlenen.className,
          room: duzenlenen.room,
          kind: duzenlenen.kind
        }
      : {
          isEdit: false,
          id: '',
          dayOfWeek: formDay,
          period: formPeriod,
          subject: '',
          className: '',
          room: '',
          kind: 'lesson'
        }
  };
}

function adminRedirect(req, res, queryParams) {
  const params = new URLSearchParams(queryParams);
  const requestedNext = normalizeText((req.body && req.body.next) || req.query.next);
  // sport ve goals bu listede yoktu: o sayfalardaki formlar next="/admin/sport"
  // gonderdigi halde kayittan sonra panoya donuyordu.
  const nextPath = /^\/admin\/(dashboard|students|users|categories|reports|analysis|yz-program|wake|sport|goals|yds|schedule|tasks(?:\/(?:create|update|active|status))?)(\?.*)?$/.test(requestedNext)
    ? requestedNext
    : '/admin/dashboard';
  const queryString = params.toString();
  if (!queryString) return res.redirect(nextPath);
  const separator = nextPath.includes('?') ? '&' : '?';
  return res.redirect(`${nextPath}${separator}${queryString}`);
}

function studentRedirect(req, res, queryParams) {
  const params = new URLSearchParams(queryParams);
  const requestedNext = normalizeText((req.body && req.body.next) || req.query.next);
  const nextPath = /^\/student\/(dashboard|new-task|questions|calendar|program|wake|schedule|goals|sport)(\?.*)?$/.test(requestedNext)
    ? requestedNext
    : '/student/dashboard';
  const queryString = params.toString();
  if (!queryString) return res.redirect(nextPath);
  const separator = nextPath.includes('?') ? '&' : '?';
  return res.redirect(`${nextPath}${separator}${queryString}`);
}

function mapUser(row) {
  return {
    id: row.id,
    name: row.name,
    username: row.username,
    role: row.role,
    isTeacher: row.isTeacher === true,
    createdAt: row.createdAt
  };
}

function mapTask(row) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    categoryId: row.categoryId,
    studentId: row.studentId,
    repeatType: row.repeatType,
    singleDate: toDateOnly(row.singleDate) || null,
    weeklyDay: row.weeklyDay,
    monthlyDay: row.monthlyDay,
    customDates: row.customDates || [],
    startDate: toDateOnly(row.startDate) || null,
    endDate: toDateOnly(row.endDate) || null,
    estimatedTime: normalizeEstimatedTimeForDisplay(row.estimatedTime),
    isArchived: row.isArchived,
    createdBy: row.createdBy,
    sourceKey: row.sourceKey || null,
    createdAt: row.createdAt
  };
}

async function getCurrentUserById(userId, withPassword = false) {
  const sql = withPassword
    ? `
      SELECT id, name, username, role, is_teacher AS "isTeacher",
             created_at AS "createdAt", password_hash AS "passwordHash"
      FROM users
      WHERE id = $1
    `
    : `
      SELECT id, name, username, role, is_teacher AS "isTeacher",
             created_at AS "createdAt"
      FROM users
      WHERE id = $1
    `;

  const result = await query(sql, [userId]);
  if (result.rowCount === 0) return null;
  return result.rows[0];
}

app.use(
  asyncHandler(async (req, _res, next) => {
    if (!req.session.userId) return next();

    const user = await getCurrentUserById(req.session.userId, false);
    if (!user) {
      req.session.userId = null;
      return next();
    }

    req.currentUser = mapUser(user);
    return next();
  })
);

app.use((req, res, next) => {
  if (req.path.startsWith('/admin') || req.path.startsWith('/student')) {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
  }
  return next();
});

function requireAuth(req, res, next) {
  if (!req.currentUser) {
    return res.redirect('/login');
  }
  return next();
}

function requireRole(role) {
  return (req, res, next) => {
    if (!req.currentUser) {
      return res.redirect('/login');
    }

    if (req.currentUser.role !== role) {
      return res.status(403).send('Yetkisiz erişim.');
    }

    return next();
  };
}

app.get('/', requireAuth, (req, res) => {
  if (req.currentUser.role === 'admin') return res.redirect('/admin/dashboard');
  return res.redirect('/student/dashboard');
});

app.get('/login', (req, res) => {
  if (req.currentUser) return res.redirect('/');
  return res.render('login', { error: null });
});

app.post(
  '/login',
  loginLimiter,
  asyncHandler(async (req, res) => {
    const username = normalizeText(req.body.username);
    const password = normalizeText(req.body.password);

    const result = await query(
      `
        SELECT id, name, username, role, password_hash AS "passwordHash"
        FROM users
        WHERE username = $1
        LIMIT 1
      `,
      [username]
    );

    if (result.rowCount === 0) {
      return res.status(401).render('login', { error: 'Kullanıcı adı veya şifre hatalı.' });
    }

    const user = result.rows[0];
    if (!bcrypt.compareSync(password, user.passwordHash)) {
      return res.status(401).render('login', { error: 'Kullanıcı adı veya şifre hatalı.' });
    }

    req.session.userId = user.id;
    return res.redirect('/');
  })
);

app.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login');
  });
});

// --- Gorev durumu duzeltme (admin) ----------------------------------------
//
// "Isaretleme kalicidir" kuralinin TEK istisnasi. Ogrenci son saati kacirinca
// muhurleyici o ornege 'not_done' yaziyor; admin'in durum degistirme rotasi
// hic olmadigi icin yapilmis bir is kalici olarak "yapilmadi" kaliyordu. Kural
// esnetilmiyor — OGRENCI tarafi aynen kilitli; yalnizca admin'e bir kapi
// aciliyor ve kapinin her kullanimi satirin icine yaziliyor (kim, ne zaman,
// neyin uzerine).
//
// Duzeltme gorev degil GOREV ORNEGI (gorev + gun) seviyesinde calisir, cunku
// durum da o seviyede tutulur: tekrarli bir gorevin dun ve bugun ayri
// satirlari olur.

const TASK_STATUS_FIX_ACTIONS = new Set(['done', 'not_done', 'clear']);

/**
 * Bu ornegin isaretini SILMEK kalici mi?
 *
 * `sealOverdueTaskStatuses` suresi dolmus ve isaretsiz her ornege 'not_done'
 * yazar; penceresi son AUTO_LOCK_LOOKBACK_DAYS gundur ve 5 dakikada bir
 * calisir. Bu pencereye dusen kilitli bir ornegin isaretini silmek en fazla
 * 5 dakika yasar, sonra kendiliginden geri gelir. "Temizlendi" demek yalan
 * olurdu; rota bu durumu reddeder, panel de dugmeyi kapatir.
 */
function wouldSealerRewriteStatus(task, day, today, nowHm) {
  if (!isTaskInstanceLocked(task, day, today, nowHm)) return false;
  const lookbackStart = shiftDate(today, -AUTO_LOCK_LOOKBACK_DAYS);
  const windowStart = [lookbackStart, AUTO_LOCK_START_DATE, SYSTEM_START_DATE].sort().pop();
  return day >= windowStart && day <= today;
}

/** Arsivlenmis gorevin GECMIS ornegi de duzeltilebilmeli; arsiv bayragi
 *  yalnizca "yeni ornek acilmasin" demektir, gecmisi yok saymaz. */
function isTaskDueOnDateIgnoringArchive(task, dateObj, dateStr) {
  return isTaskDueOnDate({ ...task, isArchived: false }, dateObj, dateStr);
}

/**
 * Duzeltme panelinin verisi: secili ogrencinin secili GUNDE vadesi gelen
 * gorevleri ve o gune yazilmis durum satirlari. Gun bazli, cunku duzeltilen
 * sey bir gorev degil o gorevin o gunku ornegidir.
 */
async function buildTaskStatusFixView(req, students, tasks, today) {
  const studentIdRaw = normalizeText(req.query.fixStudentId);
  const student = students.find((s) => s.id === studentIdRaw) || students[0] || null;
  const dayRaw = normalizeText(req.query.fixDay);
  const day = isDateOnly(dayRaw) ? dayRaw : today;

  const ortak = {
    students,
    day,
    prevDay: shiftDate(day, -1),
    nextDay: shiftDate(day, 1),
    today,
    systemStartDate: SYSTEM_START_DATE,
    beforeSystemStart: day < SYSTEM_START_DATE
  };

  if (!student) return { ...ortak, student: null, rows: [], doneCount: 0 };

  const dayObj = new Date(`${day}T00:00:00`);
  const nowHm = timeStringInTimeZone();

  const dueTasks = tasks
    .filter((t) => t.studentId === student.id && isTaskDueOnDateIgnoringArchive(t, dayObj, day))
    .sort(
      (a, b) =>
        taskDeadlineTime(a).localeCompare(taskDeadlineTime(b)) ||
        String(a.title || '').localeCompare(String(b.title || ''), 'tr')
    );

  const statusesRes = await query(
    `
      SELECT
        ts.task_id AS "taskId",
        ts.status,
        ts.corrected_at AS "correctedAt",
        ts.previous_status AS "previousStatus",
        ts.correction_note AS "correctionNote",
        u.name AS "correctedByName"
      FROM task_statuses ts
      LEFT JOIN users u ON u.id = ts.corrected_by
      WHERE ts.student_id = $1 AND ts.day = $2::date
    `,
    [student.id, day]
  );
  const byTask = new Map(statusesRes.rows.map((r) => [r.taskId, r]));

  const rows = dueTasks.map((task) => {
    const st = byTask.get(task.id) || null;
    return {
      task,
      status: st ? st.status : null,
      statusText: !st ? 'İşaretlenmedi' : st.status === 'done' ? 'Yapıldı' : 'Yapılmadı',
      deadline: taskDeadlineTime(task),
      locked: isTaskInstanceLocked(task, day, today, nowHm),
      canClear: Boolean(st) && !wouldSealerRewriteStatus(task, day, today, nowHm),
      correctedAt: st && st.correctedAt ? st.correctedAt : null,
      correctedByName: st ? st.correctedByName : null,
      previousStatusText: !st
        ? ''
        : st.previousStatus === 'done'
          ? 'Yapıldı'
          : st.previousStatus === 'not_done'
            ? 'Yapılmadı'
            : 'İşaretsiz',
      correctionNote: st ? st.correctionNote || '' : ''
    };
  });

  return {
    ...ortak,
    student,
    rows,
    doneCount: rows.filter((r) => r.status === 'done').length
  };
}

/**
 * Rutin gun tablosuna elle kayit kontrollerini ekler.
 *
 * "Temizle" yalnizca silme KALICI oldugunda cikar: muhurleyicinin 5 dakika
 * icinde geri yazacagi bir dugme olu kontrol olurdu (gorevlerdeki canClear
 * kararinin aynisi). Satirlar zaten taban tarih ile bugun arasinda uretilir.
 */
function withRoutineLogControls(kind, detail, today) {
  if (!detail || !detail.rows) return detail;
  return {
    ...detail,
    rows: detail.rows.map((row) => {
      const hasLog = row.status !== 'pending' && row.status !== 'unknown';
      return {
        ...row,
        hasLog,
        canClear: hasLog && !wouldRoutineSealerRewrite(kind, detail.routine, row.day, today)
      };
    })
  };
}

async function getAdminViewModel(req, currentPage) {
  const [usersRes, studentsRes, categoriesRes, tasksRes] = await Promise.all([
    query(
      `SELECT id, name, username, role, created_at AS "createdAt" FROM users ORDER BY role DESC, name ASC`
    ),
    query(
      `SELECT id, name, username, role, created_at AS "createdAt" FROM users WHERE role = 'student' ORDER BY name ASC`
    ),
    query(`SELECT id, name, created_at AS "createdAt" FROM categories ORDER BY name ASC`),
    query(`
      SELECT
        id,
        title,
        description,
        category_id AS "categoryId",
        student_id AS "studentId",
        repeat_type AS "repeatType",
        single_date AS "singleDate",
        weekly_day AS "weeklyDay",
        monthly_day AS "monthlyDay",
        custom_dates AS "customDates",
        start_date AS "startDate",
        end_date AS "endDate",
        estimated_time AS "estimatedTime",
        is_archived AS "isArchived",
        created_by AS "createdBy",
        created_at AS "createdAt"
      FROM tasks
      ORDER BY created_at DESC
    `)
  ]);

  const users = usersRes.rows.map(mapUser);
  const students = studentsRes.rows.map(mapUser);
  const categories = categoriesRes.rows;
  const tasks = tasksRes.rows.map(mapTask).map((task) => ({
    ...task,
    student: students.find((s) => s.id === task.studentId) || null,
    category: categories.find((c) => c.id === task.categoryId) || null,
    repeatText: formatRepeat(task),
    dateText: formatTaskSchedule(task)
  }));

  const today = todayDateString();
  const dateObj = new Date(`${today}T00:00:00`);
  let weeklyAnalysis = null;
  if (currentPage === 'analysis') {
    const analysisWeekStart =
      normalizeWeekStart(normalizeText(req.query.weekStart), today) || startOfWeek(today);
    const analysisStudentIdRaw = normalizeText(req.query.analysisStudentId);
    weeklyAnalysis = await buildWeeklyAnalysis(analysisWeekStart, analysisStudentIdRaw);
  }

  const yzProgramView = currentPage === 'yz-program' ? await buildYzProgramView(req, students) : null;

  const goalsView = currentPage === 'goals' ? await buildMonthlyGoalsView(req, students) : null;

  const taskStatusFixView =
    currentPage === 'tasks-status' ? await buildTaskStatusFixView(req, students, tasks, today) : null;

  const scheduleView = currentPage === 'schedule' ? await buildScheduleView(req) : null;
  const ydsView = currentPage === 'yds' ? await buildYdsView(30) : null;
  const ydsProgramView =
    currentPage === 'yds' ? await buildYdsProgramSummary(ydsView && ydsView.student ? ydsView.student.id : null) : null;

  let sportAdmin = null;
  if (currentPage === 'sport') {
    const secilenIdRaw = normalizeText(req.query.sportStudentId);
    const secilen = students.find((s) => s.id === secilenIdRaw) || students[0] || null;
    const detay = secilen ? await buildSportView(secilen.id, 14) : null;
    const routinesRes = await query(
      `
        SELECT student_id AS "studentId", start_time AS "startTime",
               end_time AS "endTime", is_active AS "isActive"
        FROM sport_routines
      `
    );
    const routineByStudent = new Map(
      routinesRes.rows.map((r) => [
        r.studentId,
        {
          startTime: normalizeEstimatedTimeForDisplay(r.startTime),
          endTime: normalizeEstimatedTimeForDisplay(r.endTime),
          isActive: r.isActive
        }
      ])
    );
    sportAdmin = {
      selected: secilen,
      detail: detay ? withRoutineLogControls(ROUTINE_KINDS.sport, detay, today) : null,
      defaults: { startTime: SPORT_DEFAULT_START, endTime: SPORT_DEFAULT_END },
      today,
      systemStartDate: SYSTEM_START_DATE,
      rows: students.map((s) => ({ student: s, routine: routineByStudent.get(s.id) || null }))
    };
  }

  let wakeAdmin = null;
  if (currentPage === 'wake') {
    const secilenIdRaw = normalizeText(req.query.wakeStudentId);
    const secilen = students.find((s) => s.id === secilenIdRaw) || students[0] || null;
    const detay = secilen ? await buildWakeView(secilen.id, 14) : null;

    // Tum ogrencilerin rutinlerini tek sorguda cek (liste tablosu icin).
    const routinesRes = await query(
      `
        SELECT student_id AS "studentId", target_time AS "targetTime",
               tolerance_minutes AS "toleranceMinutes", is_active AS "isActive"
        FROM wake_routines
      `
    );
    const routineByStudent = new Map(
      routinesRes.rows.map((r) => [
        r.studentId,
        {
          targetTime: normalizeEstimatedTimeForDisplay(r.targetTime),
          toleranceMinutes: Number(r.toleranceMinutes) || 0,
          isActive: r.isActive
        }
      ])
    );

    wakeAdmin = {
      selected: secilen,
      detail: detay ? withRoutineLogControls(ROUTINE_KINDS.wake, detay, today) : null,
      today,
      systemStartDate: SYSTEM_START_DATE,
      rows: students.map((s) => ({ student: s, routine: routineByStudent.get(s.id) || null }))
    };
  }

  // Gorev "haftayi kopyala" formunun varsayilan degerleri
  const copyWeekStart = normalizeWeekStart(normalizeText(req.query.weekStart), today) || startOfWeek(today);
  const copyWeekNextStart = shiftDate(copyWeekStart, 7);
  const editTaskId = normalizeText(req.query.editTaskId);
  const activeTaskStudentIdRaw = normalizeText(req.query.activeTaskStudentId);
  const activeTaskStudentId = students.some((s) => s.id === activeTaskStudentIdRaw) ? activeTaskStudentIdRaw : '';
  const editingTask = tasks.find((t) => t.id === editTaskId) || null;
  const taskForm = editingTask
    ? {
        isEdit: true,
        action: `/admin/tasks/${editingTask.id}/update`,
        submitText: 'Görevi Güncelle',
        title: editingTask.title || '',
        description: editingTask.description || '',
        categoryId: editingTask.categoryId || '',
        studentId: editingTask.studentId || '',
        repeatType: editingTask.repeatType || 'once',
        singleDate: editingTask.singleDate || today,
        weeklyDay: editingTask.weeklyDay ?? '',
        monthlyDay: editingTask.monthlyDay ?? '',
        customDates: Array.isArray(editingTask.customDates) ? editingTask.customDates.join(',') : '',
        startDate: editingTask.startDate || '',
        endDate: editingTask.endDate || '',
        estimatedTime: editingTask.estimatedTime || ''
      }
    : {
        isEdit: false,
        action: '/admin/tasks',
        submitText: 'Görevi Kaydet',
        title: '',
        description: '',
        categoryId: '',
        studentId: '',
        repeatType: 'once',
        singleDate: today,
        weeklyDay: '',
        monthlyDay: '',
        customDates: '',
        startDate: '',
        endDate: '',
        estimatedTime: ''
      };

  const sortedAllTasks = [...tasks].sort(compareTasksBySchedule);
  const taskTableTasks = activeTaskStudentId
    ? sortedAllTasks.filter((t) => t.studentId === activeTaskStudentId)
    : sortedAllTasks;
  const activeTasks = sortedAllTasks.filter((t) => !t.isArchived);
  const archivedTasks = sortedAllTasks.filter((t) => t.isArchived);

    const [todayStatusesRes, todayQuestionsRes] = await Promise.all([
    query(
      `
        SELECT task_id AS "taskId", student_id AS "studentId", status
        FROM task_statuses
        WHERE day = $1
      `,
      [today]
    ),
      query(
        `
        SELECT
          student_id AS "studentId",
          COALESCE(SUM(correct_count + wrong_count), 0) AS "totalQuestions"
        FROM daily_questions
        WHERE day = $1
        GROUP BY student_id
      `,
      [today]
    )
  ]);

  const dailyBoard = students.map((student) => {
    const dueTasks = tasks.filter((t) => t.studentId === student.id && isTaskDueOnDate(t, dateObj, today));
    const doneCount = todayStatusesRes.rows.filter(
      (st) => st.studentId === student.id && st.status === 'done' && dueTasks.some((t) => t.id === st.taskId)
    ).length;
    const question = todayQuestionsRes.rows.find((q) => q.studentId === student.id);
    return {
      ...student,
      dueCount: dueTasks.length,
      doneCount,
      questionCount: question ? Number(question.totalQuestions || 0) : 0
    };
  });

  const reportStudentId = normalizeText(req.query.reportStudentId);
  const reportRange = parseDateRange(normalizeText(req.query.reportFrom), normalizeText(req.query.reportTo));
  const selectedStudent = students.find((s) => s.id === reportStudentId) || null;
  let report = null;

  if (currentPage === 'reports' && selectedStudent && !reportRange.error) {
    const [rangeStatusesRes, rangeQuestionsRes] = await Promise.all([
      query(
        `
          SELECT task_id AS "taskId", student_id AS "studentId", day, status
          FROM task_statuses
          WHERE student_id = $1 AND day BETWEEN $2 AND $3
        `,
        [selectedStudent.id, reportRange.fromDate, reportRange.toDate]
      ),
      query(
        `
          SELECT
            student_id AS "studentId",
            day,
            COALESCE(SUM(correct_count + wrong_count), 0) AS "totalQuestions"
          FROM daily_questions
          WHERE student_id = $1 AND day BETWEEN $2 AND $3
          GROUP BY student_id, day
        `,
        [selectedStudent.id, reportRange.fromDate, reportRange.toDate]
      )
    ]);

    const taskPool = tasks.filter((t) => t.studentId === selectedStudent.id);
    const rows = reportRange.days.map((dateStr) => {
      const reportDateObj = new Date(`${dateStr}T00:00:00`);
      const dueTasks = taskPool.filter((t) => isTaskDueOnDate(t, reportDateObj, dateStr));
      const doneCount = rangeStatusesRes.rows.filter(
        (st) =>
          toDateOnly(st.day) === dateStr &&
          st.status === 'done' &&
          dueTasks.some((task) => task.id === st.taskId)
      ).length;
      const question = rangeQuestionsRes.rows.find((q) => toDateOnly(q.day) === dateStr);
      return {
        date: dateStr,
        dueCount: dueTasks.length,
        doneCount,
        notDoneCount: Math.max(dueTasks.length - doneCount, 0),
        questionCount: question ? Number(question.totalQuestions || 0) : 0
      };
    });

    const totals = rows.reduce(
      (acc, row) => {
        acc.due += row.dueCount;
        acc.done += row.doneCount;
        acc.questions += row.questionCount;
        return acc;
      },
      { due: 0, done: 0, questions: 0 }
    );

    report = {
      student: selectedStudent,
      fromDate: reportRange.fromDate,
      toDate: reportRange.toDate,
      rows,
      totals,
      completionRate: totals.due ? Math.round((totals.done / totals.due) * 100) : 0
    };
  }

  return {
    user: req.currentUser,
    currentPage,
    users,
    adminCount: users.filter((u) => u.role === 'admin').length,
    students,
    categories,
    tasks,
    activeTasks,
    archivedTasks,
    taskTableTasks,
    taskForm,
    taskStatusFixView,
    activeTaskFilters: {
      studentId: activeTaskStudentId
    },
    copyWeekStart,
    copyWeekNextStart,
    weeklyAnalysis,
    yzProgramView,
    goalsView,
    ydsView,
    ydsProgramView,
    scheduleView,
    wakeAdmin,
    sportAdmin,
    dailyBoard,
    report,
    reportError: currentPage === 'reports' ? reportRange.error : null,
    reportFilters: {
      studentId: reportStudentId,
      fromDate: reportRange.fromDate || '',
      toDate: reportRange.toDate || ''
    },
    message: req.query.message || null,
    error: req.query.error || null,
    today
  };
}

// --- JSON API (React island'lari ve ileride mobil için) ---
async function getDailyBoardData() {
  const today = dateStringInTimeZone(process.env.APP_TIMEZONE || 'Europe/Istanbul');
  const dateObj = new Date(`${today}T00:00:00`);

  const [studentsRes, tasksRes, statusesRes, questionsRes] = await Promise.all([
    query(`SELECT id, name FROM users WHERE role = 'student' ORDER BY name ASC`),
    query(`
      SELECT
        id,
        student_id AS "studentId",
        repeat_type AS "repeatType",
        single_date AS "singleDate",
        weekly_day AS "weeklyDay",
        monthly_day AS "monthlyDay",
        custom_dates AS "customDates",
        start_date AS "startDate",
        end_date AS "endDate",
        is_archived AS "isArchived"
      FROM tasks
    `),
    query(
      `SELECT task_id AS "taskId", student_id AS "studentId", status FROM task_statuses WHERE day = $1`,
      [today]
    ),
    query(
      `
        SELECT student_id AS "studentId", COALESCE(SUM(correct_count + wrong_count), 0) AS "totalQuestions"
        FROM daily_questions
        WHERE day = $1
        GROUP BY student_id
      `,
      [today]
    )
  ]);

  const tasks = tasksRes.rows.map(mapTask);

  const students = studentsRes.rows.map((student) => {
    const dueTasks = tasks.filter((t) => t.studentId === student.id && isTaskDueOnDate(t, dateObj, today));
    const doneCount = statusesRes.rows.filter(
      (st) => st.studentId === student.id && st.status === 'done' && dueTasks.some((t) => t.id === st.taskId)
    ).length;
    const question = questionsRes.rows.find((q) => q.studentId === student.id);
    return {
      id: student.id,
      name: student.name,
      dueCount: dueTasks.length,
      doneCount,
      questionCount: question ? Number(question.totalQuestions || 0) : 0
    };
  });

  return { today, students };
}

app.get(
  '/api/admin/daily-board',
  requireRole('admin'),
  asyncHandler(async (_req, res) => {
    const data = await getDailyBoardData();
    return res.json(data);
  })
);

app.get('/admin', requireRole('admin'), (req, res) => res.redirect('/admin/dashboard'));

app.get('/admin/tasks', requireRole('admin'), (req, res) => {
  const studentId = normalizeText(req.query.activeTaskStudentId);
  if (studentId) {
    return res.redirect(`/admin/tasks/active?activeTaskStudentId=${encodeURIComponent(studentId)}`);
  }
  return res.redirect('/admin/tasks/active');
});

app.get(
  '/admin/tasks/:section',
  requireRole('admin'),
  asyncHandler(async (req, res, next) => {
    if (req.params.section === 'export-active') {
      return next();
    }
    const allowedSections = new Set(['create', 'update', 'active', 'status']);
    const section = allowedSections.has(req.params.section) ? req.params.section : 'active';
    const pageMap = {
      create: 'tasks-create',
      update: 'tasks-update',
      active: 'tasks-active',
      status: 'tasks-status'
    };
    const viewModel = await getAdminViewModel(req, pageMap[section]);
    return res.render('admin', viewModel);
  })
);

app.get(
  '/admin/tasks/export-active',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const viewModel = await getAdminViewModel(req, 'tasks-active');
    const tasks = viewModel.taskTableTasks || [];

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Öğrenci Takip';
    workbook.created = new Date();

    const sheet = workbook.addWorksheet('Tüm Görevler');
    sheet.columns = [
      { header: 'Başlık', key: 'title', width: 32 },
      { header: 'Konu', key: 'description', width: 42 },
      { header: 'Öğrenci', key: 'studentName', width: 24 },
      { header: 'Kategori', key: 'categoryName', width: 20 },
      { header: 'Saat', key: 'estimatedTime', width: 10 },
      { header: 'Tarih', key: 'dateText', width: 26 },
      { header: 'Tekrar', key: 'repeatText', width: 24 },
      { header: 'Arşivde Mi', key: 'archivedText', width: 12 }
    ];

    sheet.getRow(1).font = { bold: true };
    sheet.views = [{ state: 'frozen', ySplit: 1 }];

    tasks.forEach((task) => {
      sheet.addRow({
        title: task.title || '',
        description: task.description || '',
        studentName: task.student ? task.student.name : 'Öğrenci yok',
        categoryName: task.category ? task.category.name : 'Kategori yok',
        estimatedTime: task.estimatedTime || '-',
        dateText: task.dateText || '',
        repeatText: task.repeatText || '',
        archivedText: task.isArchived ? 'Evet' : 'Hayır'
      });
    });

    sheet.eachRow((row) => {
      row.alignment = { vertical: 'top', wrapText: true };
    });

    const fileName = `tum-gorevler-${todayDateString()}.xlsx`;
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);

    await workbook.xlsx.write(res);
    return res.end();
  })
);

app.get(
  '/admin/:page',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const allowedPages = new Set(['dashboard', 'students', 'users', 'categories', 'reports', 'analysis', 'yz-program', 'wake', 'yds', 'schedule', 'goals', 'sport']);
    const currentPage = allowedPages.has(req.params.page) ? req.params.page : 'dashboard';
    const viewModel = await getAdminViewModel(req, currentPage);
    return res.render('admin', viewModel);
  })
);

app.post(
  '/admin/students',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const name = normalizeText(req.body.name);
    const username = normalizeText(req.body.username);
    const password = normalizeText(req.body.password);

    if (!name || !username || !password) {
      return adminRedirect(req, res, { error: 'Öğrenci bilgileri eksik.' });
    }

    if (password.length < 6) {
      return adminRedirect(req, res, { error: 'Şifre en az 6 karakter olmalı.' });
    }

    const exists = await query(`SELECT id FROM users WHERE username = $1 LIMIT 1`, [username]);
    if (exists.rowCount > 0) {
      return adminRedirect(req, res, { error: 'Bu kullanıcı adı zaten var.' });
    }

    await query(
      `
        INSERT INTO users (id, name, username, password_hash, role)
        VALUES ($1, $2, $3, $4, 'student')
      `,
      [makeId('user'), name, username, bcrypt.hashSync(password, 10)]
    );

    return adminRedirect(req, res, { message: 'Öğrenci eklendi.' });
  })
);

app.post(
  '/admin/users',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const name = normalizeText(req.body.name);
    const username = normalizeText(req.body.username);
    const password = normalizeText(req.body.password);
    const role = normalizeText(req.body.role);

    if (!name || !username || !password || !role) {
      return adminRedirect(req, res, { error: 'Kullanıcı bilgileri eksik.' });
    }

    if (!['admin', 'student'].includes(role)) {
      return adminRedirect(req, res, { error: 'Geçersiz rol.' });
    }

    if (password.length < 6) {
      return adminRedirect(req, res, { error: 'Şifre en az 6 karakter olmalı.' });
    }

    const exists = await query(`SELECT id FROM users WHERE username = $1 LIMIT 1`, [username]);
    if (exists.rowCount > 0) {
      return adminRedirect(req, res, { error: 'Bu kullanıcı adı zaten var.' });
    }

    await query(
      `
        INSERT INTO users (id, name, username, password_hash, role)
        VALUES ($1, $2, $3, $4, $5)
      `,
      [makeId('user'), name, username, bcrypt.hashSync(password, 10), role]
    );

    return adminRedirect(req, res, { message: 'Kullanıcı eklendi.' });
  })
);

app.post(
  '/admin/users/:userId/role',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const { userId } = req.params;
    const role = normalizeText(req.body.role);

    if (!['admin', 'student'].includes(role)) {
      return adminRedirect(req, res, { error: 'Geçersiz rol.' });
    }

    if (userId === req.currentUser.id) {
      return adminRedirect(req, res, { error: 'Kendi rolünüzü bu ekrandan değiştiremezsiniz.' });
    }

    const userRes = await query(`SELECT id, role FROM users WHERE id = $1 LIMIT 1`, [userId]);
    if (userRes.rowCount === 0) {
      return adminRedirect(req, res, { error: 'Kullanıcı bulunamadı.' });
    }

    const target = userRes.rows[0];
    if (target.role === 'admin' && role !== 'admin') {
      const adminCountRes = await query(`SELECT COUNT(*)::int AS "count" FROM users WHERE role = 'admin'`);
      if (Number(adminCountRes.rows[0].count) <= 1) {
        return adminRedirect(req, res, { error: 'Son admin kullanıcı öğrenciye düşürülemez.' });
      }
    }

    await query(`UPDATE users SET role = $1 WHERE id = $2`, [role, userId]);
    return adminRedirect(req, res, { message: 'Kullanıcı rolü güncellendi.' });
  })
);

app.post(
  '/admin/users/:userId/password',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const { userId } = req.params;
    const password = normalizeText(req.body.password);

    if (password.length < 6) {
      return adminRedirect(req, res, { error: 'Şifre en az 6 karakter olmalı.' });
    }

    const updated = await query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [bcrypt.hashSync(password, 10), userId]);
    if (updated.rowCount === 0) {
      return adminRedirect(req, res, { error: 'Kullanıcı bulunamadı.' });
    }

    return adminRedirect(req, res, { message: 'Kullanıcı şifresi güncellendi.' });
  })
);

app.post(
  '/admin/users/:userId/delete',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const { userId } = req.params;

    if (userId === req.currentUser.id) {
      return adminRedirect(req, res, { error: 'Kendi hesabınızı silemezsiniz.' });
    }

    const userRes = await query(`SELECT id, role FROM users WHERE id = $1 LIMIT 1`, [userId]);
    if (userRes.rowCount === 0) {
      return adminRedirect(req, res, { error: 'Kullanıcı bulunamadı.' });
    }

    const target = userRes.rows[0];
    if (target.role === 'admin') {
      const adminCountRes = await query(`SELECT COUNT(*)::int AS "count" FROM users WHERE role = 'admin'`);
      if (Number(adminCountRes.rows[0].count) <= 1) {
        return adminRedirect(req, res, { error: 'Son admin kullanıcı silinemez.' });
      }
    }

    try {
      await query(`DELETE FROM users WHERE id = $1`, [userId]);
    } catch (err) {
      if (err.code === '23503') {
        return adminRedirect(req, res, { error: 'Bu kullanıcı bağlı kayıtlar nedeniyle silinemiyor.' });
      }
      throw err;
    }

    return adminRedirect(req, res, { message: 'Kullanıcı silindi.' });
  })
);

app.post(
  '/admin/categories',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const name = normalizeText(req.body.name);

    if (!name) {
      return adminRedirect(req, res, { error: 'Kategori adı zorunlu.' });
    }

    try {
      await query(
        `INSERT INTO categories (id, name) VALUES ($1, $2)`,
        [makeId('cat'), name]
      );
    } catch (err) {
      if (err.code === '23505') {
        return adminRedirect(req, res, { error: 'Bu kategori zaten var.' });
      }
      throw err;
    }

    return adminRedirect(req, res, { message: 'Kategori eklendi.' });
  })
);

app.post(
  '/admin/categories/:categoryId/delete',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const { categoryId } = req.params;

    const activeUse = await query(
      `SELECT id FROM tasks WHERE category_id = $1 AND is_archived = false LIMIT 1`,
      [categoryId]
    );

    if (activeUse.rowCount > 0) {
      return adminRedirect(req, res, { error: 'Bu kategori aktif görevlerde kullanılıyor.' });
    }

    const deleted = await query(`DELETE FROM categories WHERE id = $1`, [categoryId]);

    if (deleted.rowCount === 0) {
      return adminRedirect(req, res, { error: 'Kategori bulunamadı.' });
    }

    return adminRedirect(req, res, { message: 'Kategori silindi.' });
  })
);

app.post(
  '/admin/tasks',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const title = normalizeText(req.body.title);
    const description = normalizeText(req.body.description);
    const categoryId = normalizeText(req.body.categoryId);
    const studentId = normalizeText(req.body.studentId);
    const repeatType = normalizeText(req.body.repeatType);
    const singleDate = normalizeText(req.body.singleDate);
    const weeklyDay = normalizeText(req.body.weeklyDay);
    const monthlyDay = normalizeText(req.body.monthlyDay);
    const customDates = normalizeText(req.body.customDates);
    const startDate = normalizeText(req.body.startDate);
    const endDate = normalizeText(req.body.endDate);
    const estimatedTimeInput = normalizeText(req.body.estimatedTime);
    const estimatedTimeValidation = normalizeEstimatedTimeForStorage(estimatedTimeInput);
    if (!estimatedTimeValidation.ok) {
      return adminRedirect(req, res, { error: estimatedTimeValidation.error });
    }
    const estimatedTime = estimatedTimeValidation.value;

    if (!title || !categoryId || !studentId || !repeatType) {
      return adminRedirect(req, res, { error: 'Görev için zorunlu alanlar eksik.' });
    }

    if (startDate && endDate && startDate > endDate) {
      return adminRedirect(req, res, { error: 'Başlangıç tarihi bitiş tarihinden büyük olamaz.' });
    }

    const [categoryRes, studentRes] = await Promise.all([
      query(`SELECT id FROM categories WHERE id = $1`, [categoryId]),
      query(`SELECT id FROM users WHERE id = $1 AND role = 'student'`, [studentId])
    ]);

    if (categoryRes.rowCount === 0 || studentRes.rowCount === 0) {
      return adminRedirect(req, res, { error: 'Kategori veya öğrenci geçersiz.' });
    }

    let singleDateVal = null;
    let weeklyDayVal = null;
    let monthlyDayVal = null;
    let customDatesVal = [];

    if (repeatType === 'once') {
      if (!singleDate) {
        return adminRedirect(req, res, { error: 'Tek seferlik görev için tarih zorunlu.' });
      }
      singleDateVal = singleDate;
    } else if (repeatType === 'daily') {
      if (!startDate || !endDate) {
        return adminRedirect(req, res, { error: 'Her gün görev için başlangıç ve bitiş tarihi zorunlu.' });
      }
    } else if (repeatType === 'weekly') {
      if (weeklyDay === '') {
        return adminRedirect(req, res, { error: 'Haftalık görev için gün zorunlu.' });
      }
      weeklyDayVal = Number(weeklyDay);
    } else if (repeatType === 'monthly') {
      if (!monthlyDay) {
        return adminRedirect(req, res, { error: 'Aylık görev için gün zorunlu.' });
      }
      monthlyDayVal = Number(monthlyDay);
    } else if (repeatType === 'custom') {
      const parsedDates = customDates
        .split(',')
        .map((d) => d.trim())
        .filter(Boolean);

      if (!parsedDates.length) {
        return adminRedirect(req, res, { error: 'Özel tarihli görev için en az bir tarih girin.' });
      }
      customDatesVal = parsedDates;
    } else {
      return adminRedirect(req, res, { error: 'Geçersiz tekrar tipi.' });
    }

    if (repeatType === 'daily') {
      const dayList = getDateRangeInclusive(startDate, endDate);
      if (!dayList || dayList.length === 0) {
        return adminRedirect(req, res, { error: 'Tarih aralığı geçersiz veya çok uzun.' });
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        for (const day of dayList) {
          await client.query(
            `
              INSERT INTO tasks (
                id,
                title,
                description,
                category_id,
                student_id,
                repeat_type,
                single_date,
                weekly_day,
                monthly_day,
                custom_dates,
                start_date,
                end_date,
                estimated_time,
                is_archived,
                created_by
              )
              VALUES ($1,$2,$3,$4,$5,'once',$6,NULL,NULL,'{}',NULL,NULL,$7,false,$8)
            `,
            [makeId('task'), title, description, categoryId, studentId, day, estimatedTime, req.currentUser.id]
          );
        }

        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }

      return adminRedirect(req, res, { message: `${dayList.length} adet günlük görev oluşturuldu.` });
    }

    await query(
      `
        INSERT INTO tasks (
          id,
          title,
          description,
          category_id,
          student_id,
          repeat_type,
          single_date,
          weekly_day,
          monthly_day,
          custom_dates,
          start_date,
          end_date,
          estimated_time,
          is_archived,
          created_by
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,false,$14)
      `,
      [
        makeId('task'),
        title,
        description,
        categoryId,
        studentId,
        repeatType,
        singleDateVal,
        weeklyDayVal,
        monthlyDayVal,
        customDatesVal,
        startDate || null,
        endDate || null,
        estimatedTime,
        req.currentUser.id
      ]
    );

    return adminRedirect(req, res, { message: 'Görev oluşturuldu.' });
  })
);

app.post(
  '/admin/yds/program-settings',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    // Gunler ya hazir duzen adiyla ('her-gun') ya da tek tek isaretlenmis
    // kutularla ('gunler' alani) gelir; ikisi de normalizeGunSet'ten gecer.
    const duzen = normalizeText(req.body.duzen);

    let gunSet;
    if (duzen && duzen !== 'ozel') {
      if (!ydsPlan.GUN_DUZENLERI[duzen]) {
        return adminRedirect(req, res, { error: 'Geçersiz düzen seçildi.' });
      }
      gunSet = ydsPlan.normalizeGunSet(duzen);
    } else {
      // Ozel secimde varsayilana DUSULMEZ: gecersiz/bos secim sessizce hafta
      // sonuna donmemeli, kullanici ne sectigini bilmeli.
      const secilenler = normalizeIdList(req.body.gunler)
        .map((g) => Number(g))
        .filter((g) => Number.isInteger(g) && g >= 0 && g <= 6);
      if (!secilenler.length) {
        return adminRedirect(req, res, { error: 'En az bir geçerli çalışma günü seçin.' });
      }
      gunSet = ydsPlan.normalizeGunSet(secilenler);
    }

    const sonuc = await saveYdsProgramSettings(gunSet, req.body.gunlukDakika);
    if (!sonuc.ok) {
      return adminRedirect(req, res, { error: sonuc.error });
    }

    return adminRedirect(req, res, {
      message:
        `Doktora çalışma günleri "${ydsPlan.gunSetEtiketi(sonuc.gunSet)}" (${sonuc.gunlukDakika} dk/gün) olarak ayarlandı. ` +
        'Değişikliğin göreve dönüşmesi için "Görevlere Aktar" düğmesine basın; geçmiş ve işaretli görevler korunur.'
    });
  })
);

app.post(
  '/admin/yds/program-import',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const student = await findYdsStudent();
    if (!student) {
      return adminRedirect(req, res, {
        error: `'${YDS_STUDENT_USERNAME}' kullanıcı adlı öğrenci bulunamadı.`
      });
    }

    const program = ydsProgram.loadYdsProgram();
    if (!program.gorevler.length) {
      return adminRedirect(req, res, { error: 'Aktarılacak YDS programı bulunamadı.' });
    }

    const sonuc = await importYdsProgram(student.id, req.currentUser.id);
    const notlar = [];
    if (sonuc.categories) notlar.push(`${sonuc.categories} kategori oluşturuldu.`);
    if (sonuc.merged) {
      notlar.push(`${sonuc.merged} görev "${YDS_CATEGORY}" kategorisinde toplandı.`);
    }
    if (sonuc.removedCategories) {
      notlar.push(`${sonuc.removedCategories} boşalan kategori silindi.`);
    }
    if (sonuc.keptCategories) {
      notlar.push(`${sonuc.keptCategories} kategori başka kayıtlar bağlı olduğu için silinmedi.`);
    }
    if (sonuc.updated) notlar.push(`${sonuc.updated} görev güncellendi.`);
    if (sonuc.removed) notlar.push(`${sonuc.removed} bayat görev kaldırıldı.`);
    if (sonuc.replanned) {
      notlar.push(
        `Program "${ydsPlan.gunSetEtiketi(sonuc.gunSet)}" düzenine göre bugünden itibaren yeniden yayıldı (${sonuc.gunlukDakika} dk/gün).`
      );
      if (sonuc.movedPieces) {
        notlar.push(`${sonuc.movedPieces} içerik parçası yeni günlere taşındı; geçmiş ve işaretli görevler yerinde kaldı.`);
      }
      if (sonuc.unplaced) {
        notlar.push(`${sonuc.unplaced} parça takvime sığmadı — günlük süreyi artırmayı ya da daha çok gün seçmeyi düşün.`);
      }
    }

    if (sonuc.inserted === 0 && !notlar.length) {
      return adminRedirect(req, res, {
        message: `${student.name} için yeni görev yok; ${sonuc.skipped} görev zaten aktarılmış.`
      });
    }

    return adminRedirect(req, res, {
      message: `${sonuc.inserted} görev eklendi (${sonuc.skipped} görev zaten vardı).${notlar.length ? ' ' + notlar.join(' ') : ''}`
    });
  })
);

app.post(
  '/admin/yds/sync',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const sonuc = await syncYdsProgress();
    if (!sonuc.ok) {
      return adminRedirect(req, res, { error: `YDS verisi çekilemedi: ${sonuc.reason}` });
    }
    if (sonuc.reset) {
      return adminRedirect(req, res, {
        message:
          `Sıfırlama yansıtıldı: ${sonuc.removedDays} gün ve ${sonuc.removedQuestionRows} soru kaydı silindi. ` +
          `Ardından ${sonuc.days} gün yansıtıldı, ${sonuc.questionRows} güne soru kaydı yazıldı.`
      });
    }
    return adminRedirect(req, res, {
      message: `${sonuc.student.name} için ${sonuc.days} gün yansıtıldı, ${sonuc.questionRows} güne soru kaydı yazıldı.`
    });
  })
);

/**
 * Islenen konular Excel ciktisi. Hem admin hem ogrenci tarafindan cagrilir —
 * dosya ayni; ogrenci zaten ayni veriyi ekranda goruyor, indirmesini
 * engellemek yapay bir surtunme olurdu. Hata halinde nereye donulecegi
 * cagirana gore degistigi icin redirect fonksiyonu disaridan gelir.
 */
async function sendLessonTopicsExcel(req, res, redirect) {
  const today = todayDateString();

  // Varsayilan aralik: icinde bulunulan donem. Donem disindaysak (yariyil
  // tatili gibi) ogretim yilinin tamami alinir.
  const donem =
    academicCalendar.ACADEMIC_YEAR.terms.find((t) => today >= t.start && today <= t.end) || null;
  const varsayilanBas = donem ? donem.start : academicCalendar.ACADEMIC_YEAR.start;
  const varsayilanSon = donem ? donem.end : academicCalendar.ACADEMIC_YEAR.end;

  const fromRaw = normalizeText(req.query.from);
  const toRaw = normalizeText(req.query.to);
  const fromDate = isDateOnly(fromRaw) ? fromRaw : varsayilanBas;
  const toDate = isDateOnly(toRaw) ? toRaw : varsayilanSon;
  if (fromDate > toDate) {
    return redirect(req, res, { error: 'Başlangıç tarihi bitiş tarihinden büyük olamaz.' });
  }

  // week_start haftanin pazartesisi; aralik disina tasan gunleri sonra eleriz.
  const res_ = await query(
    `
      SELECT week_start AS "weekStart", day_of_week AS "dayOfWeek", period,
             subject, class_name AS "className", topic, updated_at AS "updatedAt"
      FROM lesson_topics
      WHERE week_start BETWEEN $1 AND $2
      ORDER BY week_start ASC, day_of_week ASC, period ASC
    `,
    [shiftDate(startOfWeek(fromDate), 0), toDate]
  );

  const ayar = await getScheduleSettings();
  const saatByPeriod = new Map(schedule.buildPeriods(ayar).map((s) => [s.period, s]));

  const satirlar = res_.rows
    .map((row) => {
      const haftaBasi = toDateOnly(row.weekStart);
      const tarih = shiftDate(haftaBasi, Number(row.dayOfWeek) - 1);
      const saat = saatByPeriod.get(Number(row.period)) || null;
      const bilgi = academicCalendar.getDayInfo(tarih);
      return {
        tarih,
        gunAdi: getDayName(tarih),
        hafta: haftaBasi,
        period: Number(row.period),
        saatAraligi: saat ? `${saat.start} - ${saat.end}` : '',
        subject: row.subject || '',
        className: row.className || '',
        topic: row.topic || '',
        donem: bilgi.term ? bilgi.term.label : ''
      };
    })
    .filter((r) => r.tarih >= fromDate && r.tarih <= toDate)
    .sort((a, b) => (a.tarih === b.tarih ? a.period - b.period : a.tarih < b.tarih ? -1 : 1));

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Öğrenci Takip';
  workbook.created = new Date();

  const sheet = workbook.addWorksheet('İşlenen Konular');
  sheet.columns = [
    { header: 'Tarih', key: 'tarih', width: 12 },
    { header: 'Gün', key: 'gunAdi', width: 11 },
    { header: 'Dönem', key: 'donem', width: 10 },
    { header: 'Ders Saati', key: 'period', width: 10 },
    { header: 'Saat', key: 'saatAraligi', width: 15 },
    { header: 'Ders', key: 'subject', width: 30 },
    { header: 'Sınıf', key: 'className', width: 10 },
    { header: 'İşlenen Konu', key: 'topic', width: 60 }
  ];
  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  sheet.autoFilter = { from: 'A1', to: 'H1' };

  satirlar.forEach((r) => sheet.addRow(r));
  sheet.eachRow((row, i) => {
    row.alignment = { vertical: 'top', wrapText: i > 1 };
  });

  // Sinif ozeti: zumre/idare raporunda "hangi sinifta kac saat islendi".
  const ozetSheet = workbook.addWorksheet('Sınıf Özeti');
  ozetSheet.columns = [
    { header: 'Sınıf', key: 'className', width: 14 },
    { header: 'Ders', key: 'subject', width: 30 },
    { header: 'İşlenen Ders Saati', key: 'adet', width: 18 },
    { header: 'İlk Kayıt', key: 'ilk', width: 12 },
    { header: 'Son Kayıt', key: 'son', width: 12 }
  ];
  ozetSheet.getRow(1).font = { bold: true };
  ozetSheet.views = [{ state: 'frozen', ySplit: 1 }];

  const ozet = new Map();
  for (const r of satirlar) {
    const anahtar = `${r.className}|${r.subject}`;
    const mevcut = ozet.get(anahtar);
    if (!mevcut) {
      ozet.set(anahtar, {
        className: r.className || '-',
        subject: r.subject,
        adet: 1,
        ilk: r.tarih,
        son: r.tarih
      });
      continue;
    }
    mevcut.adet += 1;
    if (r.tarih < mevcut.ilk) mevcut.ilk = r.tarih;
    if (r.tarih > mevcut.son) mevcut.son = r.tarih;
  }
  Array.from(ozet.values())
    .sort((a, b) => a.className.localeCompare(b.className, 'tr') || a.subject.localeCompare(b.subject, 'tr'))
    .forEach((o) => ozetSheet.addRow(o));

  const fileName = `islenen-konular-${fromDate}_${toDate}.xlsx`;
  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  );
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);

  await workbook.xlsx.write(res);
  return res.end();
}

app.post(
  '/admin/schedule/log-tasks',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const studentId = normalizeText(req.body.studentId);
    if (!studentId) {
      return adminRedirect(req, res, { error: 'Defter görevlerinin açılacağı öğrenciyi seçin.' });
    }
    const studentRes = await query(`SELECT id, name FROM users WHERE id = $1 AND role = 'student'`, [
      studentId
    ]);
    if (studentRes.rowCount === 0) {
      return adminRedirect(req, res, { error: 'Öğrenci bulunamadı.' });
    }

    const varMi = await query(`SELECT 1 FROM class_schedule LIMIT 1`);
    if (varMi.rowCount === 0) {
      return adminRedirect(req, res, {
        error: 'Önce Çizelge sekmesinden ders programını girin; defter görevleri ona göre açılır.'
      });
    }

    const sonuc = await importLessonLogTasks(studentId, req.currentUser.id);
    const notlar = [];
    if (sonuc.categories) notlar.push('"Ders Defteri" kategorisi oluşturuldu.');
    if (sonuc.updated) notlar.push(`${sonuc.updated} görev güncellendi.`);
    if (sonuc.removed) notlar.push(`${sonuc.removed} bayat görev kaldırıldı.`);

    if (sonuc.inserted === 0 && !notlar.length) {
      return adminRedirect(req, res, {
        message: `${studentRes.rows[0].name} için yeni hafta yok; ${sonuc.skipped} defter görevi zaten var.`
      });
    }
    return adminRedirect(req, res, {
      message: `${sonuc.inserted} defter görevi eklendi (${sonuc.weeks} okul haftası).${notlar.length ? ' ' + notlar.join(' ') : ''}`
    });
  })
);

app.get(
  '/admin/schedule/topics/export',
  requireRole('admin'),
  asyncHandler((req, res) => sendLessonTopicsExcel(req, res, adminRedirect))
);

app.get(
  '/student/schedule/topics/export',
  requireRole('student'),
  asyncHandler((req, res) => sendLessonTopicsExcel(req, res, studentRedirect))
);

/**
 * Bir haftanin islenen konularini yazar. Admin ve (ogretmen isaretli) ogrenci
 * rotalari ayni govdeyi kullanir; yetki kontrolu cagirana aittir.
 * Doner: { ok: false, error } ya da { ok: true, message }.
 */
async function saveLessonTopics(body) {
  const weekStart = normalizeWeekStart(normalizeText(body.weekStart));
  if (!weekStart) {
    return { ok: false, error: 'Hafta seçilmedi.' };
  }

  const [ayar, kayitlar] = await Promise.all([
    getScheduleSettings(),
    getScheduleEntries(weekStart)
  ]);
  const kayitByKey = new Map(kayitlar.map((k) => [`${k.dayOfWeek}:${k.period}`, k]));

  // Form tum haftayi tek seferde gonderir: alan adlari "konu[gun-saat]".
  // Yalnizca CIZELGEDE DERSI OLAN ve o gun okul gunu olan hucreler yazilir;
  // boylece formdan gelen beklenmedik anahtarlar kayit acamaz.
  const girdiler = [];
  for (const [alan, deger] of Object.entries(body || {})) {
    const eslesme = /^konu\[(\d+)-(\d+)\]$/.exec(alan);
    if (!eslesme) continue;
    const gun = Number(eslesme[1]);
    const saat = Number(eslesme[2]);
    if (!(gun >= 1 && gun <= 7) || !(saat >= 1 && saat <= ayar.periodCount)) continue;

    const ders = kayitByKey.get(`${gun}:${saat}`);
    if (!ders) continue;

    girdiler.push({
      gun,
      saat,
      konu: normalizeText(deger).slice(0, 500),
      subject: ders.subject,
      className: ders.className
    });
  }

  if (!girdiler.length) {
    return { ok: false, error: 'Yazılacak ders saati bulunamadı.' };
  }

  const client = await pool.connect();
  let yazilan = 0;
  let silinen = 0;
  try {
    await client.query('BEGIN');
    for (const g of girdiler) {
      if (!g.konu) {
        // Bosaltilan hucre kaydi silinir; bos satir birakmak yerine temiz kalir.
        const silme = await client.query(
          `DELETE FROM lesson_topics WHERE week_start = $1 AND day_of_week = $2 AND period = $3`,
          [weekStart, g.gun, g.saat]
        );
        silinen += silme.rowCount || 0;
        continue;
      }
      await client.query(
        `
          INSERT INTO lesson_topics (id, week_start, day_of_week, period, subject, class_name, topic, updated_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
          ON CONFLICT (week_start, day_of_week, period) DO UPDATE SET
            subject = EXCLUDED.subject,
            class_name = EXCLUDED.class_name,
            topic = EXCLUDED.topic,
            updated_at = NOW()
        `,
        [makeId('top'), weekStart, g.gun, g.saat, g.subject, g.className, g.konu]
      );
      yazilan += 1;
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  const silmeNotu = silinen ? ` ${silinen} boş bırakılan kayıt silindi.` : '';
  return {
  ok: true,
  message: `${weekStart} haftası kaydedildi: ${yazilan} ders saati.${silmeNotu}`
  };
}

// Ogretmen isareti: bir ogrenci hesabinin ders defterini KENDI panelinden
// yazabilmesini acar. Rol degismez; yalnizca defter yazma yetkisi verilir.
app.post(
  '/admin/goals',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const studentId = normalizeText(req.body.studentId);
    const monthStart = normalizeMonthStart(req.body.monthStart, null);
    const title = normalizeText(req.body.title).slice(0, 200);
    const description = normalizeText(req.body.description).slice(0, 1000);

    if (!monthStart) {
      return adminRedirect(req, res, { error: 'Ay seçilmedi.' });
    }
    if (!title) {
      return adminRedirect(req, res, { error: 'Hedef başlığı boş olamaz.' });
    }

    const studentRes = await query(`SELECT id FROM users WHERE id = $1 AND role = 'student'`, [
      studentId
    ]);
    if (studentRes.rowCount === 0) {
      return adminRedirect(req, res, { error: 'Öğrenci bulunamadı.' });
    }

    const sonuc = await query(
      `
        INSERT INTO monthly_goals (id, student_id, month_start, title, description, created_by)
        VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT (student_id, month_start, title) DO NOTHING
      `,
      [makeId('goal'), studentId, monthStart, title, description, req.currentUser.id]
    );

    if (sonuc.rowCount === 0) {
      return adminRedirect(req, res, {
        error: 'Bu ay için aynı başlıkta bir hedef zaten var.'
      });
    }

    return adminRedirect(req, res, { message: `Hedef eklendi: ${title}` });
  })
);

// Hedefi degerlendirir. "Basarildi" demek icin KANIT zorunlu: uygulama serbest
// metin hedefi kendi olcemedigi icin, kanit alani bos birakilirsa kayit kuru
// bir "yaptim" beyanindan ibaret kalir. "Basarilamadi" icin kanit istenmez -
// orada kanitlanacak bir iddia yok.
app.post(
  '/admin/goals/:goalId/evaluate',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const { goalId } = req.params;
    const status = normalizeText(req.body.status);
    const evidence = normalizeText(req.body.evidence).slice(0, 2000);

    if (!['pending', 'achieved', 'missed'].includes(status)) {
      return adminRedirect(req, res, { error: 'Geçersiz hedef durumu.' });
    }

    if (status === 'achieved' && !evidence) {
      return adminRedirect(req, res, {
        error: 'Başarıldı işaretlemek için kanıt yazmalısın (ne yapıldı, nereden görülüyor).'
      });
    }

    const mevcut = await query(`SELECT id, title FROM monthly_goals WHERE id = $1`, [goalId]);
    if (mevcut.rowCount === 0) {
      return adminRedirect(req, res, { error: 'Hedef bulunamadı.' });
    }

    await query(
      `
        UPDATE monthly_goals
        SET status = $1,
            evidence = $2,
            evaluated_at = CASE WHEN $1 = 'pending' THEN NULL ELSE NOW() END,
            evaluated_by = CASE WHEN $1 = 'pending' THEN NULL ELSE $3 END
        WHERE id = $4
      `,
      [status, evidence, req.currentUser.id, goalId]
    );

    return adminRedirect(req, res, {
      message: `"${mevcut.rows[0].title}" hedefi ${GOAL_STATUS_LABELS[status].toLowerCase()} olarak kaydedildi.`
    });
  })
);

app.post(
  '/admin/goals/:goalId/delete',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const { goalId } = req.params;
    const sonuc = await query(`DELETE FROM monthly_goals WHERE id = $1`, [goalId]);
    if (sonuc.rowCount === 0) {
      return adminRedirect(req, res, { error: 'Hedef bulunamadı.' });
    }
    return adminRedirect(req, res, { message: 'Hedef silindi.' });
  })
);

app.post(
  '/admin/schedule/teacher',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const studentId = normalizeText(req.body.studentId);
    const isTeacher = normalizeText(req.body.isTeacher) === '1';

    const studentRes = await query(
      `SELECT id, name FROM users WHERE id = $1 AND role = 'student'`,
      [studentId]
    );
    if (studentRes.rowCount === 0) {
      return adminRedirect(req, res, { error: 'Öğrenci bulunamadı.' });
    }

    await query(`UPDATE users SET is_teacher = $1 WHERE id = $2`, [isTeacher, studentId]);
    const ad = studentRes.rows[0].name;
    return adminRedirect(req, res, {
      message: isTeacher
        ? `${ad} artık ders defterini kendi panelinden yazabilir.`
        : `${ad} için defter yazma yetkisi kaldırıldı.`
    });
  })
);

app.post(
  '/admin/schedule/topics',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const sonuc = await saveLessonTopics(req.body || {});
    return adminRedirect(req, res, sonuc.ok ? { message: sonuc.message } : { error: sonuc.error });
  })
);

// Ders defterini ogrenci panelinden yalnizca OGRETMEN ISARETLI hesap yazabilir.
// Bayrak yoksa 403: defter uygulama genelinde tek kayittir, siradan bir
// ogrencinin ogretmenin defterini duzenlemesi dogru olmaz.
app.post(
  '/student/schedule/topics',
  requireRole('student'),
  asyncHandler(async (req, res) => {
    if (!req.currentUser.isTeacher) {
      return res.status(403).send('Yetkisiz erişim.');
    }
    const sonuc = await saveLessonTopics(req.body || {});
    return studentRedirect(req, res, sonuc.ok ? { message: sonuc.message } : { error: sonuc.error });
  })
);

app.post(
  '/admin/schedule/settings',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const startValidation = normalizeEstimatedTimeForStorage(normalizeText(req.body.startTime));
    if (!startValidation.ok || !startValidation.value) {
      return adminRedirect(req, res, { error: 'Başlangıç saati geçersiz (ör. 08:00).' });
    }

    const sayiAl = (deger, min, max) => {
      const n = Number(normalizeText(deger));
      return Number.isInteger(n) && n >= min && n <= max ? n : null;
    };

    const lessonMinutes = sayiAl(req.body.lessonMinutes, 10, 120);
    const breakMinutes = sayiAl(req.body.breakMinutes, 0, 60);
    const periodCount = sayiAl(req.body.periodCount, 1, 16);
    const lunchMinutes = sayiAl(req.body.lunchMinutes, 0, 180);
    if (lessonMinutes === null || breakMinutes === null || periodCount === null || lunchMinutes === null) {
      return adminRedirect(req, res, { error: 'Süre alanları geçersiz.' });
    }

    const lunchRaw = normalizeText(req.body.lunchAfterPeriod);
    const lunchAfterPeriod = lunchRaw === '' ? null : sayiAl(lunchRaw, 1, periodCount);
    if (lunchRaw !== '' && lunchAfterPeriod === null) {
      return adminRedirect(req, res, {
        error: `Öğle arası ders saati 1 ile ${periodCount} arasında olmalı.`
      });
    }

    // Ders saati sayisi kisaltilirsa disarida kalan kayitlar oksuz kalmasin.
    const artan = await query(`DELETE FROM class_schedule WHERE period > $1`, [periodCount]);

    await query(
      `
        INSERT INTO school_settings (
          id, start_time, lesson_minutes, break_minutes, period_count, lunch_after_period, lunch_minutes, updated_at
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
        ON CONFLICT (id) DO UPDATE SET
          start_time = EXCLUDED.start_time,
          lesson_minutes = EXCLUDED.lesson_minutes,
          break_minutes = EXCLUDED.break_minutes,
          period_count = EXCLUDED.period_count,
          lunch_after_period = EXCLUDED.lunch_after_period,
          lunch_minutes = EXCLUDED.lunch_minutes,
          updated_at = NOW()
      `,
      [
        SCHEDULE_SETTINGS_ID,
        startValidation.value,
        lessonMinutes,
        breakMinutes,
        periodCount,
        lunchAfterPeriod,
        lunchMinutes
      ]
    );

    const bitis = schedule.endOfDay({
      startTime: startValidation.value,
      lessonMinutes,
      breakMinutes,
      periodCount,
      lunchAfterPeriod,
      lunchMinutes
    });
    const silmeNotu = artan.rowCount ? ` ${artan.rowCount} ders kaydı kapsam dışı kaldığı için silindi.` : '';
    return adminRedirect(req, res, {
      message: `Zil çizelgesi kaydedildi. Gün ${startValidation.value} - ${bitis} arası.${silmeNotu}`
    });
  })
);

/**
 * Yazma rotalarinin hedef haftasi. `hafta` verilmezse VARSAYILAN SABLON
 * duzenlenir; bir hafta verilirse o haftanin kendi cizelgesi.
 */
function hedefHafta(body) {
  const ham = normalizeText(body && body.hafta);
  return isDateOnly(ham) ? startOfWeek(ham) : SABLON_HAFTA;
}

function haftaEtiketi(weekStart) {
  return weekStart === SABLON_HAFTA ? 'varsayılan çizelge' : `${weekStart} haftası`;
}

/**
 * Bir haftaya yazmadan ONCE sablonu o haftaya kopyalar (henuz kopyalanmadiysa).
 *
 * Sarttir: hafta cozumlemesi "o haftanin satiri varsa YALNIZCA onlar" diyor.
 * Onlemsiz, ozellestirilmemis bir haftaya tek ders eklemek o haftayi tek
 * derslik bir cizelgeye cevirir ve haftanin geri kalani sessizce kaybolurdu.
 * Kopya sayisi cagirana doner ki mesajda bildirilebilsin.
 */
async function ensureWeekCustomized(client, hafta) {
  if (hafta === SABLON_HAFTA) return 0;
  const isaret = await client.query(
    `INSERT INTO schedule_week_overrides (week_start) VALUES ($1) ON CONFLICT DO NOTHING`,
    [hafta]
  );
  // Isaret zaten varsa hafta ozellestirilmisti; kopya tekrarlanmaz.
  if (isaret.rowCount === 0) return 0;

  const kopya = await client.query(
    `
      INSERT INTO class_schedule (id, term, day_of_week, period, subject, class_name, room, kind, week_start)
      SELECT 'sch_' || md5(random()::text || clock_timestamp()::text),
             term, day_of_week, period, subject, class_name, room, kind, $2::date
      FROM class_schedule
      WHERE week_start = $1
    `,
    [SABLON_HAFTA, hafta]
  );
  return kopya.rowCount || 0;
}

app.post(
  '/admin/schedule/paste',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const metin = String(req.body.metin || '');
    if (!metin.trim()) {
      return adminRedirect(req, res, { error: 'Yapıştırılacak metin boş.' });
    }

    const ayar = await getScheduleSettings();
    const { gecerli, hatali } = schedule.parseScheduleText(metin, ayar.periodCount);

    if (!gecerli.length) {
      const ilk = hatali.length ? ` İlk sorun: ${hatali[0].hata}` : '';
      return adminRedirect(req, res, {
        error: `Hiçbir satır anlaşılamadı (${hatali.length} sorunlu satır).${ilk}`
      });
    }

    const temizle = normalizeText(req.body.temizle) === 'on';
    const hafta = hedefHafta(req.body);
    const client = await pool.connect();
    let silinen = 0;
    let kopyalanan = 0;
    try {
      await client.query('BEGIN');
      if (temizle) {
        // Temizlik YALNIZCA hedef haftayi kapsar: bir haftayi yapistirirken
        // varsayilan sablonun silinmesi surpriz olurdu.
        const silme = await client.query(`DELETE FROM class_schedule WHERE week_start = $1`, [hafta]);
        silinen = silme.rowCount || 0;
      } else {
        // Ustune ekleme: once sablon o haftaya kopyalanir, yoksa yapistirilan
        // birkac satir haftanin TAMAMI olurdu.
        kopyalanan = await ensureWeekCustomized(client, hafta);
      }
      for (const g of gecerli) {
        await client.query(
          `
            INSERT INTO class_schedule (id, term, day_of_week, period, subject, class_name, room, kind, week_start)
            VALUES ($1,0,$2,$3,$4,$5,$6,$7,$8)
            ON CONFLICT (week_start, term, day_of_week, period) DO UPDATE SET
              subject = EXCLUDED.subject,
              class_name = EXCLUDED.class_name,
              room = EXCLUDED.room,
              kind = EXCLUDED.kind
          `,
          [makeId('sch'), g.dayOfWeek, g.period, g.subject, g.className, g.room, g.kind, hafta]
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    const notlar = [];
    if (kopyalanan) notlar.push(`Hafta özelleştirildi: varsayılan çizelgeden ${kopyalanan} ders kopyalandı.`);
    if (silinen) notlar.push(`${silinen} eski kayıt temizlendi.`);
    if (hatali.length) {
      // Anlasilmayan satirlar sessizce kaybolmasin: kullaniciya geri gosterilir.
      notlar.push(`${hatali.length} satır anlaşılamadı — ilki: "${hatali[0].satir}" (${hatali[0].hata})`);
    }

    return adminRedirect(req, res, {
      message: `${gecerli.length} ders saati kaydedildi (${haftaEtiketi(hafta)}).${notlar.length ? ' ' + notlar.join(' ') : ''}`
    });
  })
);

app.post(
  '/admin/schedule/entry',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const ayar = await getScheduleSettings();
    const dayOfWeek = Number(normalizeText(req.body.dayOfWeek));
    const period = Number(normalizeText(req.body.period));
    const subject = normalizeText(req.body.subject);
    const className = normalizeText(req.body.className);
    const room = normalizeText(req.body.room);
    const kind = normalizeText(req.body.kind) === 'duty' ? 'duty' : 'lesson';

    if (!Number.isInteger(dayOfWeek) || dayOfWeek < 1 || dayOfWeek > 7) {
      return adminRedirect(req, res, { error: 'Gün seçilmedi.' });
    }
    if (!Number.isInteger(period) || period < 1 || period > ayar.periodCount) {
      return adminRedirect(req, res, {
        error: `Ders saati 1 ile ${ayar.periodCount} arasında olmalı.`
      });
    }
    if (!subject) {
      return adminRedirect(req, res, { error: 'Ders adı zorunlu.' });
    }

    // Ayni hucre ikinci kez girilirse ustune yazilir; boylece duzeltmek icin
    // once silmek gerekmez.
    const hafta = hedefHafta(req.body);
    const client = await pool.connect();
    let kopyalanan = 0;
    try {
      await client.query('BEGIN');
      kopyalanan = await ensureWeekCustomized(client, hafta);
      await client.query(
        `
          INSERT INTO class_schedule (id, term, day_of_week, period, subject, class_name, room, kind, week_start)
          VALUES ($1,0,$2,$3,$4,$5,$6,$7,$8)
          ON CONFLICT (week_start, term, day_of_week, period) DO UPDATE SET
            subject = EXCLUDED.subject,
            class_name = EXCLUDED.class_name,
            room = EXCLUDED.room,
            kind = EXCLUDED.kind
        `,
        [makeId('sch'), dayOfWeek, period, subject, className, room, kind, hafta]
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    const kopyaNotu = kopyalanan
      ? ` Hafta özelleştirildi: varsayılan çizelgeden ${kopyalanan} ders kopyalandı.`
      : '';
    return adminRedirect(req, res, {
      message: `${schedule.GUN_ADLARI[dayOfWeek]} ${period}. ders kaydedildi (${haftaEtiketi(hafta)}).${kopyaNotu}`
    });
  })
);

app.post(
  '/admin/schedule/entry/:id/delete',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const silindi = await query(`DELETE FROM class_schedule WHERE id = $1`, [req.params.id]);
    if (silindi.rowCount === 0) {
      return adminRedirect(req, res, { error: 'Kayıt bulunamadı.' });
    }
    return adminRedirect(req, res, { message: 'Ders kaydı silindi.' });
  })
);

app.post(
  '/admin/schedule/clear',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    // Bosaltma YALNIZCA hedef haftayi kapsar.
    //
    // Bir HAFTA bosaltmak ayni zamanda "bu hafta ders yok" demenin yoludur:
    // hafta ozellestirilmis ama bos kalirsa o hafta icin defter gorevi
    // acilmaz ve haftalik takvimde ders gorunmez. Tatil haftalarinin kapisi
    // artik takvim degil, budur.
    const hafta = hedefHafta(req.body);
    const client = await pool.connect();
    let silindi = 0;
    try {
      await client.query('BEGIN');
      // Bosaltmadan once isaret konur: isaret olmadan bos hafta "ozellestirilmemis"
      // sayilir ve sablona geri donerdi — tam da anlatilmak isteneni siler.
      await ensureWeekCustomized(client, hafta);
      const silme = await client.query(`DELETE FROM class_schedule WHERE week_start = $1`, [hafta]);
      silindi = silme.rowCount || 0;
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    const bosNotu =
      hafta === SABLON_HAFTA
        ? ''
        : ' Bu hafta artık "ders yok" sayılır: haftalık takvimde ders görünmez, defter görevi de açılmaz.';
    return adminRedirect(req, res, {
      message: `${silindi} ders kaydı silindi; ${haftaEtiketi(hafta)} boşaltıldı.${bosNotu}`
    });
  })
);

// Bir haftayi OZELLESTIR: varsayilan sablonu o haftaya kopyalar. Kopyalama
// sarttir — bos baslasaydi "bu hafta yalnizca su ders degisti" demek icin tum
// hafta elle yeniden girilirdi.
app.post(
  '/admin/schedule/week/customize',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const ham = normalizeText(req.body.hafta);
    if (!isDateOnly(ham)) {
      return adminRedirect(req, res, { error: 'Hafta seçilmedi.' });
    }
    const hafta = startOfWeek(ham);

    const client = await pool.connect();
    let kopyalanan = 0;
    try {
      await client.query('BEGIN');
      const zaten = await client.query(
        `SELECT 1 FROM schedule_week_overrides WHERE week_start = $1`,
        [hafta]
      );
      if (zaten.rowCount) {
        await client.query('ROLLBACK');
        return adminRedirect(req, res, { error: `${hafta} haftası zaten özelleştirilmiş.` });
      }
      kopyalanan = await ensureWeekCustomized(client, hafta);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    return adminRedirect(req, res, {
      message:
        kopyalanan > 0
          ? `${hafta} haftası özelleştirildi: varsayılan çizelgeden ${kopyalanan} ders kopyalandı. Artık bu haftadaki değişiklikler diğer haftaları etkilemez.`
          : `${hafta} haftası özelleştirildi (varsayılan çizelge boş olduğu için hafta da boş başladı).`
    });
  })
);

// Haftayi VARSAYILANA DONDUR: o haftanin kendi satirlari silinir, hafta yine
// sablonu kullanmaya baslar. Gecmis defter kayitlari SILINMEZ — onlar
// `lesson_topics` icinde ders/sinif adini kendi iclerinde tasir.
app.post(
  '/admin/schedule/week/reset',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const ham = normalizeText(req.body.hafta);
    if (!isDateOnly(ham)) {
      return adminRedirect(req, res, { error: 'Hafta seçilmedi.' });
    }
    const hafta = startOfWeek(ham);

    const isaret = await query(`DELETE FROM schedule_week_overrides WHERE week_start = $1`, [hafta]);
    if (isaret.rowCount === 0) {
      return adminRedirect(req, res, { error: `${hafta} haftası zaten varsayılan çizelgeyi kullanıyor.` });
    }
    const silindi = await query(`DELETE FROM class_schedule WHERE week_start = $1`, [hafta]);
    return adminRedirect(req, res, {
      message: `${hafta} haftası varsayılan çizelgeye döndü (${silindi.rowCount} özel kayıt silindi). İşlenen konular silinmedi.`
    });
  })
);

app.post(
  '/admin/sport',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const studentId = normalizeText(req.body.studentId);
    const startInput = normalizeText(req.body.startTime);
    const endInput = normalizeText(req.body.endTime);
    const isActive = normalizeText(req.body.isActive) !== 'off';

    const studentRes = await query(`SELECT id, name FROM users WHERE id = $1 AND role = 'student'`, [
      studentId
    ]);
    if (studentRes.rowCount === 0) {
      return adminRedirect(req, res, { error: 'Öğrenci bulunamadı.' });
    }

    const start = normalizeEstimatedTimeForStorage(startInput);
    if (!start.ok || !start.value) {
      return adminRedirect(req, res, { error: 'Başlangıç saati geçersiz (ör. 06:15).' });
    }
    const end = normalizeEstimatedTimeForStorage(endInput);
    if (!end.ok || !end.value) {
      return adminRedirect(req, res, { error: 'Bitiş saati geçersiz (ör. 06:30).' });
    }
    if (hmToMinutes(end.value) <= hmToMinutes(start.value)) {
      return adminRedirect(req, res, { error: 'Bitiş saati başlangıçtan sonra olmalı.' });
    }

    await query(
      `
        INSERT INTO sport_routines (student_id, start_time, end_time, is_active)
        VALUES ($1,$2,$3,$4)
        ON CONFLICT (student_id) DO UPDATE
        SET start_time = EXCLUDED.start_time,
            end_time = EXCLUDED.end_time,
            is_active = EXCLUDED.is_active,
            updated_at = NOW()
      `,
      [studentId, start.value, end.value, isActive]
    );

    return adminRedirect(req, res, {
      message: `${studentRes.rows[0].name} için spor rutini ${start.value} - ${end.value}${isActive ? '' : ' (pasif)'} olarak kaydedildi.`
    });
  })
);

// Rutin kaldirilinca sport_logs SILINMEZ - gecmis denetim verisi durur
// (uyanma rutinindeki kararin aynisi).
app.post(
  '/admin/sport/delete',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const studentId = normalizeText(req.body.studentId);
    const sonuc = await query(`DELETE FROM sport_routines WHERE student_id = $1`, [studentId]);
    if (sonuc.rowCount === 0) {
      return adminRedirect(req, res, { error: 'Bu öğrencide spor rutini yok.' });
    }
    return adminRedirect(req, res, {
      message: 'Spor rutini kaldırıldı. Geçmiş kayıtlar duruyor.'
    });
  })
);

app.post(
  '/admin/wake',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const studentId = normalizeText(req.body.studentId);
    const targetTimeInput = normalizeText(req.body.targetTime);
    const toleranceInput = normalizeText(req.body.toleranceMinutes);
    const isActive = normalizeText(req.body.isActive) !== 'off';

    const studentRes = await query(`SELECT id, name FROM users WHERE id = $1 AND role = 'student'`, [
      studentId
    ]);
    if (studentRes.rowCount === 0) {
      return adminRedirect(req, res, { error: 'Öğrenci bulunamadı.' });
    }

    const targetValidation = normalizeEstimatedTimeForStorage(targetTimeInput);
    if (!targetValidation.ok || !targetValidation.value) {
      return adminRedirect(req, res, { error: 'Hedef uyanma saati geçersiz (ör. 06:00).' });
    }

    const tolerance = toleranceInput === '' ? 0 : Number(toleranceInput);
    if (!Number.isInteger(tolerance) || tolerance < 0 || tolerance > WAKE_MAX_TOLERANCE) {
      return adminRedirect(req, res, {
        error: `Tolerans 0 ile ${WAKE_MAX_TOLERANCE} dakika arasında olmalı.`
      });
    }

    await query(
      `
        INSERT INTO wake_routines (student_id, target_time, tolerance_minutes, is_active)
        VALUES ($1,$2,$3,$4)
        ON CONFLICT (student_id) DO UPDATE
        SET target_time = EXCLUDED.target_time,
            tolerance_minutes = EXCLUDED.tolerance_minutes,
            is_active = EXCLUDED.is_active,
            updated_at = NOW()
      `,
      [studentId, targetValidation.value, tolerance, isActive]
    );

    const toleransNotu = tolerance ? ` (+${tolerance} dk tolerans)` : '';
    return adminRedirect(req, res, {
      message: `${studentRes.rows[0].name} için uyanma rutini ${targetValidation.value}${toleransNotu} olarak ayarlandı.`
    });
  })
);

app.post(
  '/admin/wake/delete',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const studentId = normalizeText(req.body.studentId);
    // Rutin silinir ama gecmis kayitlar (wake_logs) durur: gecmis denetim
    // verisi rutin kapatildi diye yok olmamali.
    const silindi = await query(`DELETE FROM wake_routines WHERE student_id = $1`, [studentId]);
    if (silindi.rowCount === 0) {
      return adminRedirect(req, res, { error: 'Bu öğrencide tanımlı rutin yok.' });
    }
    return adminRedirect(req, res, { message: 'Uyanma rutini kaldırıldı; geçmiş kayıtlar korundu.' });
  })
);

// --- Rutin kayitlarini admin elle girer ------------------------------------
//
// Ogrenci tarafinda kural DEGISMEDI: gunde tek kayit, ilk basis gecerli,
// basilmayan gecmis gun "kacirildi/yapilmadi" muhurlenir. Ama basmayi unutan
// (ya da telefonu yaninda olmayan) bir gunun telafisi yoktu. Gorevlerdeki
// "Durum Duzelt" kapisinin rutin karsiligi: admin bir GUNUN kaydini elle
// yazar, duzeltir ya da -kalici olacaksa- siler.
//
// Kapi sessiz degil: her yazma kimin, ne zaman ve neyin uzerine yazdigiyla
// birlikte satirin icinde durur (corrected_by / corrected_at /
// previous_status / previous_time / correction_note).
const ROUTINE_LOG_ACTIONS = new Set(['set', 'missed', 'clear']);

// Uyanma ve spor tablolari bilerek ayri duruyor (bkz. CLAUDE.md); burada
// yalnizca ikisinin FARKLARI tarif edilir, govde ortaktir.
const ROUTINE_KINDS = {
  wake: {
    ad: 'Uyanma',
    tablo: 'wake_logs',
    saatSutunu: 'woke_at',
    saatEtiketi: 'Kalkış saati',
    idOneki: 'wake',
    geriyeBakisGun: WAKE_LOOKBACK_DAYS,
    durumMetni: wakeStatusText,
    rutinGetir: getWakeRoutine,
    ayarSutunlari: ['target_time', 'tolerance_minutes'],
    // Ayarlar kaydin icine kopyalanir: degerlendirme, satir zaten varsa onun
    // KENDI kopyasina gore yapilir (rutin sonradan degisse de gecmis bozulmaz).
    rutinAyarlari: (r) => [r.targetTime, r.toleranceMinutes],
    kayitAyarlari: (row) => [
      normalizeEstimatedTimeForDisplay(row.target_time),
      Number(row.tolerance_minutes) || 0
    ],
    degerlendir: (hm, [hedef, tolerans]) => evaluateWake(hm, hedef, tolerans)
  },
  sport: {
    ad: 'Spor',
    tablo: 'sport_logs',
    saatSutunu: 'done_at',
    saatEtiketi: 'Yapılan saat',
    idOneki: 'sport',
    geriyeBakisGun: SPORT_LOOKBACK_DAYS,
    durumMetni: sportStatusText,
    rutinGetir: getSportRoutine,
    ayarSutunlari: ['start_time', 'end_time'],
    rutinAyarlari: (r) => [r.startTime, r.endTime],
    kayitAyarlari: (row) => [
      normalizeEstimatedTimeForDisplay(row.start_time),
      normalizeEstimatedTimeForDisplay(row.end_time)
    ],
    degerlendir: (hm, [baslangic, bitis]) => evaluateSport(hm, baslangic, bitis)
  }
};

/**
 * Bu gunun kaydini SILMEK kalici mi?
 *
 * Muhurleyici (sealMissedWakeLogs / sealMissedSportLogs) 5 dakikada bir
 * calisir ve aktif rutinin GECMIS gunlerine kayit yoksa "kacirildi" yazar.
 * O pencereye dusen bir kaydi silmek en fazla 5 dakika yasar; "temizlendi"
 * demek yalan olurdu (gorevlerdeki wouldSealerRewriteStatus ile ayni karar).
 */
function wouldRoutineSealerRewrite(kind, routine, day, today) {
  if (!routine || !routine.isActive) return false;
  if (day >= today) return false; // muhurleyici bugune dokunmaz
  const basladi = [routine.createdDay || SYSTEM_START_DATE, SYSTEM_START_DATE].sort().pop();
  const pencereBasi = [shiftDate(today, -kind.geriyeBakisGun), basladi].sort().pop();
  return day >= pencereBasi;
}

app.post(
  '/admin/routines/:tur/log',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const kind = ROUTINE_KINDS[normalizeText(req.params.tur)];
    if (!kind) {
      return adminRedirect(req, res, { error: 'Rutin bulunamadı.' });
    }

    const studentId = normalizeText(req.body.studentId);
    const day = normalizeText(req.body.day);
    const action = normalizeText(req.body.action);

    if (!ROUTINE_LOG_ACTIONS.has(action)) {
      return adminRedirect(req, res, { error: 'Geçersiz işlem.' });
    }
    if (!isDateOnly(day)) {
      return adminRedirect(req, res, { error: 'Geçersiz gün.' });
    }

    const notDogrulama = validateTaskDescription(req.body.note);
    if (!notDogrulama.ok) {
      return adminRedirect(req, res, { error: notDogrulama.error });
    }

    const studentRes = await query(`SELECT id, name FROM users WHERE id = $1 AND role = 'student'`, [
      studentId
    ]);
    if (studentRes.rowCount === 0) {
      return adminRedirect(req, res, { error: 'Öğrenci bulunamadı.' });
    }
    const ogrenciAdi = studentRes.rows[0].name;

    const today = todayDateString();
    if (day > today) {
      return adminRedirect(req, res, { error: 'Gelecek bir güne rutin kaydı yazılamaz.' });
    }
    // Sistem taban tarihinden onceki gunler her acilista siliniyor; oraya
    // yazmak "kaydettim" deyip kaydi kaybetmek olurdu.
    if (day < SYSTEM_START_DATE) {
      return adminRedirect(req, res, {
        error: `Sistem ${SYSTEM_START_DATE} tarihinde başlıyor; daha eski günlere kayıt yazılamaz.`
      });
    }

    const routine = await kind.rutinGetir(studentId);
    const mevcutRes = await query(
      `SELECT * FROM ${kind.tablo} WHERE student_id = $1 AND day = $2::date`,
      [studentId, day]
    );
    const mevcut = mevcutRes.rowCount ? mevcutRes.rows[0] : null;
    const mevcutSaat = mevcut ? normalizeEstimatedTimeForDisplay(mevcut[kind.saatSutunu]) : '';
    const kunye = `${ogrenciAdi} · ${day}`;

    if (action === 'clear') {
      if (!mevcut) {
        return adminRedirect(req, res, { error: `${kunye} için zaten kayıt yok.` });
      }
      if (wouldRoutineSealerRewrite(kind, routine, day, today)) {
        return adminRedirect(req, res, {
          error: `${kunye} geçmiş bir gün; kayıt silinse otomatik mühürleme 5 dakika içinde yeniden "${kind.durumMetni('missed')}" yazar. Bunun yerine saat girin.`
        });
      }
      await query(`DELETE FROM ${kind.tablo} WHERE student_id = $1 AND day = $2::date`, [
        studentId,
        day
      ]);
      return adminRedirect(req, res, {
        message: `${kunye} ${kind.ad.toLowerCase()} kaydı silindi (${kind.durumMetni(mevcut.status)}${mevcutSaat ? ' ' + mevcutSaat : ''} → kayıtsız).`
      });
    }

    // Ayarlar: satir zaten varsa onun kendi kopyasi, yoksa rutinin bugunku
    // ayari. Rutin hic yoksa yazacak deger yok (sutunlar NOT NULL).
    const ayarlar = mevcut
      ? kind.kayitAyarlari(mevcut)
      : routine
        ? kind.rutinAyarlari(routine)
        : null;
    if (!ayarlar) {
      return adminRedirect(req, res, {
        error: `${ogrenciAdi} için ${kind.ad.toLowerCase()} rutini tanımlı değil; kayıt rutinin ayarlarıyla değerlendirilir.`
      });
    }

    let yeniSaat = null;
    let yeniDurum = 'missed';
    let gecikme = 0;
    if (action === 'set') {
      const saat = normalizeEstimatedTimeForStorage(req.body.time);
      if (!saat.ok || !saat.value) {
        return adminRedirect(req, res, {
          error: `${kind.saatEtiketi} HH:MM biçiminde olmalı (ör. 06:20).`
        });
      }
      const sonuc = kind.degerlendir(saat.value, ayarlar);
      if (!sonuc) {
        return adminRedirect(req, res, { error: 'Saat hesaplanamadı.' });
      }
      yeniSaat = saat.value;
      yeniDurum = sonuc.status;
      gecikme = sonuc.delayMinutes;
    }

    if (mevcut && mevcut.status === yeniDurum && mevcutSaat === (yeniSaat || '')) {
      return adminRedirect(req, res, {
        error: `${kunye} zaten "${kind.durumMetni(yeniDurum)}${yeniSaat ? ' ' + yeniSaat : ''}" olarak kayıtlı.`
      });
    }

    const ayarYerleri = ayarlar.map((_, i) => `$${4 + i}`).join(', ');
    const s = 4 + ayarlar.length;
    await query(
      `
        INSERT INTO ${kind.tablo}
          (id, student_id, day, ${kind.ayarSutunlari.join(', ')}, ${kind.saatSutunu}, status,
           delay_minutes, corrected_by, corrected_at, previous_status, previous_time, correction_note)
        VALUES ($1, $2, $3::date, ${ayarYerleri}, $${s}, $${s + 1}, $${s + 2}, $${s + 3}, NOW(), NULL, NULL, $${s + 4})
        ON CONFLICT (student_id, day) DO UPDATE
        SET ${kind.saatSutunu} = EXCLUDED.${kind.saatSutunu},
            status = EXCLUDED.status,
            delay_minutes = EXCLUDED.delay_minutes,
            corrected_by = EXCLUDED.corrected_by,
            corrected_at = NOW(),
            previous_status = ${kind.tablo}.status,
            previous_time = ${kind.tablo}.${kind.saatSutunu},
            correction_note = EXCLUDED.correction_note
      `,
      [
        makeId(kind.idOneki),
        studentId,
        day,
        ...ayarlar,
        yeniSaat,
        yeniDurum,
        gecikme,
        req.currentUser.id,
        notDogrulama.value
      ]
    );

    const onceki = mevcut
      ? `${kind.durumMetni(mevcut.status)}${mevcutSaat ? ' ' + mevcutSaat : ''}`
      : 'Kayıtsız';
    const yeni = `${kind.durumMetni(yeniDurum)}${yeniSaat ? ' ' + yeniSaat : ''}`;
    const gecikmeNotu = gecikme ? ` (${gecikme} dk gecikme)` : '';
    return adminRedirect(req, res, {
      message: `${kunye} ${kind.ad.toLowerCase()} kaydı: ${onceki} → ${yeni}${gecikmeNotu}.`
    });
  })
);

app.post(
  '/admin/yz-program/import',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const studentId = normalizeText(req.body.studentId);
    if (!studentId) {
      return adminRedirect(req, res, { error: 'Program aktarılacak öğrenciyi seçin.' });
    }

    const studentRes = await query(`SELECT id, name FROM users WHERE id = $1 AND role = 'student'`, [
      studentId
    ]);
    if (studentRes.rowCount === 0) {
      return adminRedirect(req, res, { error: 'Öğrenci bulunamadı.' });
    }

    const program = yzProgram.loadYzProgram();
    if (!program.gorevler.length) {
      return adminRedirect(req, res, { error: 'Aktarılacak program bulunamadı.' });
    }

    const sonuc = await importYzProgram(studentId, req.currentUser.id);
    const notlar = [];
    if (sonuc.categories) notlar.push(`${sonuc.categories} kategori oluşturuldu.`);
    if (sonuc.merged) {
      notlar.push(`${sonuc.merged} görev "${YZ_CATEGORY}" kategorisinde toplandı.`);
    }
    if (sonuc.removedCategories) {
      notlar.push(`${sonuc.removedCategories} boşalan kurs kategorisi silindi.`);
    }
    if (sonuc.keptCategories) {
      notlar.push(`${sonuc.keptCategories} kategori başka kayıtlar bağlı olduğu için silinmedi.`);
    }
    if (sonuc.moved) notlar.push(`${sonuc.moved} görevin tarihi programa hizalandı.`);
    if (sonuc.pinned) notlar.push(`${sonuc.pinned} görev işaretli/geçmiş olduğu için taşınmadı.`);
    const ek = notlar.length ? ' ' + notlar.join(' ') : '';

    if (sonuc.inserted === 0) {
      return adminRedirect(req, res, {
        message: `${studentRes.rows[0].name} için yeni ders yok; ${sonuc.skipped} ders zaten aktarılmış.${ek}`
      });
    }

    return adminRedirect(req, res, {
      message: `${sonuc.inserted} ders görev olarak eklendi (${sonuc.skipped} ders zaten vardı).${ek}`
    });
  })
);

app.post(
  '/admin/tasks/copy-week',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const sourceWeekInput = normalizeText(req.body.sourceWeekStart);
    const targetWeekInput = normalizeText(req.body.targetWeekStart);
    const studentId = normalizeText(req.body.studentId);

    const sourceWeekStart = normalizeWeekStart(sourceWeekInput, null);
    const targetWeekStart = normalizeWeekStart(targetWeekInput, null);

    if (!sourceWeekStart || !targetWeekStart) {
      return adminRedirect(req, res, { error: 'Kaynak ve hedef hafta tarihleri geçersiz.' });
    }

    if (sourceWeekStart === targetWeekStart) {
      return adminRedirect(req, res, { error: 'Kaynak ve hedef hafta aynı olamaz.' });
    }

    if (studentId) {
      const studentRes = await query(
        `SELECT id FROM users WHERE id = $1 AND role = 'student' LIMIT 1`,
        [studentId]
      );
      if (studentRes.rowCount === 0) {
        return adminRedirect(req, res, { error: 'Öğrenci seçimi geçersiz.' });
      }
    }

    const tasksRes = await query(
      `
        SELECT
          id,
          title,
          description,
          category_id AS "categoryId",
          student_id AS "studentId",
          repeat_type AS "repeatType",
          single_date AS "singleDate",
          weekly_day AS "weeklyDay",
          monthly_day AS "monthlyDay",
          custom_dates AS "customDates",
          start_date AS "startDate",
          end_date AS "endDate",
          estimated_time AS "estimatedTime",
          is_archived AS "isArchived",
          created_by AS "createdBy",
          created_at AS "createdAt"
        FROM tasks
        WHERE is_archived = false
          AND ($1::text = '' OR student_id = $1)
      `,
      [studentId]
    );

    const tasks = tasksRes.rows.map(mapTask);
    const targetWeekEnd = shiftDate(targetWeekStart, 6);
    const existingOnceRes = await query(
      `
        SELECT
          title,
          category_id AS "categoryId",
          student_id AS "studentId",
          single_date AS "singleDate"
        FROM tasks
        WHERE repeat_type = 'once'
          AND is_archived = false
          AND single_date BETWEEN $1 AND $2
          AND ($3::text = '' OR student_id = $3)
      `,
      [targetWeekStart, targetWeekEnd, studentId]
    );

    const makeKey = (tStudentId, tCategoryId, tTitle, tDate) =>
      JSON.stringify([tStudentId, tCategoryId, tTitle || '', tDate]);

    const existingKeys = new Set(
      existingOnceRes.rows.map((row) =>
        makeKey(row.studentId, row.categoryId, row.title, toDateOnly(row.singleDate))
      )
    );

    const planned = [];
    for (let offset = 0; offset < 7; offset += 1) {
      const sourceDay = shiftDate(sourceWeekStart, offset);
      const targetDay = shiftDate(targetWeekStart, offset);
      const sourceDateObj = new Date(`${sourceDay}T00:00:00`);
      const dueTasks = tasks.filter((task) => isTaskDueOnDate(task, sourceDateObj, sourceDay));

      dueTasks.forEach((task) => {
        planned.push({
          title: task.title,
          description: task.description || '',
          categoryId: task.categoryId,
          studentId: task.studentId,
          estimatedTime: task.estimatedTime || null,
          targetDay
        });
      });
    }

    if (!planned.length) {
      return adminRedirect(req, res, { message: 'Kaynak haftada kopyalanacak görev bulunamadı.' });
    }

    let insertedCount = 0;
    let skippedCount = 0;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const item of planned) {
        const key = makeKey(item.studentId, item.categoryId, item.title, item.targetDay);
        if (existingKeys.has(key)) {
          skippedCount += 1;
          continue;
        }

        await client.query(
          `
            INSERT INTO tasks (
              id,
              title,
              description,
              category_id,
              student_id,
              repeat_type,
              single_date,
              weekly_day,
              monthly_day,
              custom_dates,
              start_date,
              end_date,
              estimated_time,
              is_archived,
              created_by
            )
            VALUES ($1,$2,$3,$4,$5,'once',$6,NULL,NULL,'{}',NULL,NULL,$7,false,$8)
          `,
          [
            makeId('task'),
            item.title,
            item.description,
            item.categoryId,
            item.studentId,
            item.targetDay,
            item.estimatedTime,
            req.currentUser.id
          ]
        );

        existingKeys.add(key);
        insertedCount += 1;
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    return adminRedirect(req, res, {
      message: `${insertedCount} görev hedef haftaya kopyalandı. ${skippedCount} görev zaten var olduğu için atlandı.`
    });
  })
);

app.post(
  '/admin/tasks/:taskId/update',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const { taskId } = req.params;
    const title = normalizeText(req.body.title);
    const description = normalizeText(req.body.description);
    const categoryId = normalizeText(req.body.categoryId);
    const studentId = normalizeText(req.body.studentId);
    const repeatType = normalizeText(req.body.repeatType);
    const singleDate = normalizeText(req.body.singleDate);
    const weeklyDay = normalizeText(req.body.weeklyDay);
    const monthlyDay = normalizeText(req.body.monthlyDay);
    const customDates = normalizeText(req.body.customDates);
    const startDate = normalizeText(req.body.startDate);
    const endDate = normalizeText(req.body.endDate);
    const estimatedTimeInput = normalizeText(req.body.estimatedTime);
    const estimatedTimeValidation = normalizeEstimatedTimeForStorage(estimatedTimeInput);
    if (!estimatedTimeValidation.ok) {
      return adminRedirect(req, res, { error: estimatedTimeValidation.error });
    }
    const estimatedTime = estimatedTimeValidation.value;

    if (!title || !categoryId || !studentId || !repeatType) {
      return adminRedirect(req, res, { error: 'Görev güncelleme alanları eksik.' });
    }

    if (startDate && endDate && startDate > endDate) {
      return adminRedirect(req, res, { error: 'Başlangıç tarihi bitiş tarihinden büyük olamaz.' });
    }

    const [taskRes, categoryRes, studentRes] = await Promise.all([
      query(`SELECT id FROM tasks WHERE id = $1 LIMIT 1`, [taskId]),
      query(`SELECT id FROM categories WHERE id = $1 LIMIT 1`, [categoryId]),
      query(`SELECT id FROM users WHERE id = $1 AND role = 'student' LIMIT 1`, [studentId])
    ]);

    if (taskRes.rowCount === 0) {
      return adminRedirect(req, res, { error: 'Görev bulunamadı.' });
    }
    if (categoryRes.rowCount === 0 || studentRes.rowCount === 0) {
      return adminRedirect(req, res, { error: 'Kategori veya öğrenci geçersiz.' });
    }

    let singleDateVal = null;
    let weeklyDayVal = null;
    let monthlyDayVal = null;
    let customDatesVal = [];

    if (repeatType === 'once') {
      if (!singleDate) {
        return adminRedirect(req, res, { error: 'Tek seferlik görev için tarih zorunlu.' });
      }
      singleDateVal = singleDate;
    } else if (repeatType === 'daily') {
      return adminRedirect(req, res, { error: 'Her gün tipi sadece yeni görev oluşturmada kullanılır.' });
    } else if (repeatType === 'weekly') {
      if (weeklyDay === '') {
        return adminRedirect(req, res, { error: 'Haftalık görev için gün zorunlu.' });
      }
      weeklyDayVal = Number(weeklyDay);
    } else if (repeatType === 'monthly') {
      if (!monthlyDay) {
        return adminRedirect(req, res, { error: 'Aylık görev için gün zorunlu.' });
      }
      monthlyDayVal = Number(monthlyDay);
    } else if (repeatType === 'custom') {
      const parsedDates = customDates
        .split(',')
        .map((d) => d.trim())
        .filter(Boolean);

      if (!parsedDates.length) {
        return adminRedirect(req, res, { error: 'Özel tarihli görev için en az bir tarih girin.' });
      }
      customDatesVal = parsedDates;
    } else {
      return adminRedirect(req, res, { error: 'Geçersiz tekrar tipi.' });
    }

    await query(
      `
        UPDATE tasks
        SET
          title = $1,
          description = $2,
          category_id = $3,
          student_id = $4,
          repeat_type = $5,
          single_date = $6,
          weekly_day = $7,
          monthly_day = $8,
          custom_dates = $9,
          start_date = $10,
          end_date = $11,
          estimated_time = $12
        WHERE id = $13
      `,
      [
        title,
        description,
        categoryId,
        studentId,
        repeatType,
        singleDateVal,
        weeklyDayVal,
        monthlyDayVal,
        customDatesVal,
        startDate || null,
        endDate || null,
        estimatedTime,
        taskId
      ]
    );

    return adminRedirect(req, res, { message: 'Görev güncellendi.' });
  })
);

app.post(
  '/admin/tasks/:taskId/cell-update',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const { taskId } = req.params;
    const field = normalizeText(req.body.field);
    const value = normalizeText(req.body.value);

    const taskRes = await query(`SELECT id FROM tasks WHERE id = $1 LIMIT 1`, [taskId]);
    if (taskRes.rowCount === 0) {
      return res.status(404).json({ ok: false, error: 'Görev bulunamadı.' });
    }

    if (field === 'title') {
      if (!value) {
        return res.status(400).json({ ok: false, error: 'Başlık boş olamaz.' });
      }
      await query(`UPDATE tasks SET title = $1 WHERE id = $2`, [value, taskId]);
      return res.json({ ok: true, value, display: value });
    }

    if (field === 'description') {
      await query(`UPDATE tasks SET description = $1 WHERE id = $2`, [value, taskId]);
      return res.json({ ok: true, value, display: value || '-' });
    }

    if (field === 'studentId') {
      const studentRes = await query(
        `SELECT id, name FROM users WHERE id = $1 AND role = 'student' LIMIT 1`,
        [value]
      );
      if (studentRes.rowCount === 0) {
        return res.status(400).json({ ok: false, error: 'Öğrenci geçersiz.' });
      }
      await query(`UPDATE tasks SET student_id = $1 WHERE id = $2`, [value, taskId]);
      return res.json({ ok: true, value, display: studentRes.rows[0].name });
    }

    if (field === 'categoryId') {
      const categoryRes = await query(`SELECT id, name FROM categories WHERE id = $1 LIMIT 1`, [value]);
      if (categoryRes.rowCount === 0) {
        return res.status(400).json({ ok: false, error: 'Kategori geçersiz.' });
      }
      await query(`UPDATE tasks SET category_id = $1 WHERE id = $2`, [value, taskId]);
      return res.json({ ok: true, value, display: categoryRes.rows[0].name });
    }

    if (field === 'estimatedTime') {
      const estimatedTimeValidation = normalizeEstimatedTimeForStorage(value);
      if (!estimatedTimeValidation.ok) {
        return res.status(400).json({ ok: false, error: estimatedTimeValidation.error });
      }
      await query(`UPDATE tasks SET estimated_time = $1 WHERE id = $2`, [estimatedTimeValidation.value, taskId]);
      return res.json({
        ok: true,
        value: estimatedTimeValidation.value || '',
        display: estimatedTimeValidation.value || '-'
      });
    }

    return res.status(400).json({ ok: false, error: 'Güncellenebilir alan bulunamadı.' });
  })
);

app.post(
  '/admin/tasks/bulk-update',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const taskIds = normalizeIdList(req.body.taskIds);
    const categoryId = normalizeText(req.body.categoryId);
    const studentId = normalizeText(req.body.studentId);
    const repeatType = normalizeText(req.body.repeatType);
    const singleDate = normalizeText(req.body.singleDate);
    const weeklyDay = normalizeText(req.body.weeklyDay);
    const monthlyDay = normalizeText(req.body.monthlyDay);
    const customDates = normalizeText(req.body.customDates);
    const startDate = normalizeText(req.body.startDate);
    const endDate = normalizeText(req.body.endDate);
    const estimatedTime = normalizeText(req.body.estimatedTime);
    const clearTime = normalizeText(req.body.clearTime) === '1';
    const archiveAction = normalizeText(req.body.archiveAction) || 'keep';

    if (!taskIds.length) {
      return adminRedirect(req, res, { error: 'Toplu güncelleme için en az bir görev seçin.' });
    }

    if (startDate && endDate && startDate > endDate) {
      return adminRedirect(req, res, { error: 'Başlangıç tarihi bitiş tarihinden büyük olamaz.' });
    }

    if (categoryId) {
      const categoryRes = await query(`SELECT id FROM categories WHERE id = $1 LIMIT 1`, [categoryId]);
      if (categoryRes.rowCount === 0) {
        return adminRedirect(req, res, { error: 'Kategori geçersiz.' });
      }
    }

    if (studentId) {
      const studentRes = await query(
        `SELECT id FROM users WHERE id = $1 AND role = 'student' LIMIT 1`,
        [studentId]
      );
      if (studentRes.rowCount === 0) {
        return adminRedirect(req, res, { error: 'Öğrenci geçersiz.' });
      }
    }

    if (estimatedTime && clearTime) {
      return adminRedirect(req, res, {
        error: 'Aynı anda hem saat girilip hem "saati temizle" seçilemez.'
      });
    }

    const setClauses = [];
    const values = [];

    // Aktarilan gorevler (YZ, YDS, defter) saatsiz geliyor; 149 gorevi tek tek
    // girmek yerine secilenlere toplu saat yazilabilir.
    if (clearTime) {
      setClauses.push(`estimated_time = NULL`);
    } else if (estimatedTime) {
      const saatDogrulama = normalizeEstimatedTimeForStorage(estimatedTime);
      if (!saatDogrulama.ok) {
        return adminRedirect(req, res, { error: saatDogrulama.error });
      }
      values.push(saatDogrulama.value);
      setClauses.push(`estimated_time = $${values.length}`);
    }

    if (categoryId) {
      values.push(categoryId);
      setClauses.push(`category_id = $${values.length}`);
    }

    if (studentId) {
      values.push(studentId);
      setClauses.push(`student_id = $${values.length}`);
    }

    if (repeatType) {
      if (!['once', 'weekly', 'monthly', 'custom'].includes(repeatType)) {
        return adminRedirect(req, res, {
          error: 'Toplu güncellemede tekrar tipi olarak Tek Seferlik, Haftalık, Aylık veya Özel seçin.'
        });
      }

      let singleDateVal = null;
      let weeklyDayVal = null;
      let monthlyDayVal = null;
      let customDatesVal = [];

      if (repeatType === 'once') {
        if (!singleDate) {
          return adminRedirect(req, res, { error: 'Tek seferlik için tarih zorunlu.' });
        }
        singleDateVal = singleDate;
      } else if (repeatType === 'weekly') {
        if (weeklyDay === '') {
          return adminRedirect(req, res, { error: 'Haftalık için gün zorunlu.' });
        }
        weeklyDayVal = Number(weeklyDay);
      } else if (repeatType === 'monthly') {
        if (!monthlyDay) {
          return adminRedirect(req, res, { error: 'Aylık için gün zorunlu.' });
        }
        monthlyDayVal = Number(monthlyDay);
      } else if (repeatType === 'custom') {
        const parsedDates = customDates
          .split(',')
          .map((d) => d.trim())
          .filter(Boolean);

        if (!parsedDates.length) {
          return adminRedirect(req, res, { error: 'Özel tekrar için en az bir tarih girin.' });
        }
        customDatesVal = parsedDates;
      }

      values.push(repeatType);
      setClauses.push(`repeat_type = $${values.length}`);
      values.push(singleDateVal);
      setClauses.push(`single_date = $${values.length}`);
      values.push(weeklyDayVal);
      setClauses.push(`weekly_day = $${values.length}`);
      values.push(monthlyDayVal);
      setClauses.push(`monthly_day = $${values.length}`);
      values.push(customDatesVal);
      setClauses.push(`custom_dates = $${values.length}`);
    }

    if (startDate) {
      values.push(startDate);
      setClauses.push(`start_date = $${values.length}`);
    }

    if (endDate) {
      values.push(endDate);
      setClauses.push(`end_date = $${values.length}`);
    }

    if (archiveAction === 'archive' || archiveAction === 'unarchive') {
      values.push(archiveAction === 'archive');
      setClauses.push(`is_archived = $${values.length}`);
    } else if (archiveAction !== 'keep') {
      return adminRedirect(req, res, { error: 'Arşiv işlemi geçersiz.' });
    }

    if (!setClauses.length) {
      return adminRedirect(req, res, { error: 'Toplu güncelleme için en az bir alan seçin.' });
    }

    values.push(taskIds);
    const updated = await query(
      `
        UPDATE tasks
        SET ${setClauses.join(', ')}
        WHERE id = ANY($${values.length}::text[])
      `,
      values
    );

    if (updated.rowCount === 0) {
      return adminRedirect(req, res, { error: 'Seçili görevler bulunamadı.' });
    }

    return adminRedirect(req, res, {
      message: `${updated.rowCount}/${taskIds.length} görev toplu olarak güncellendi.`
    });
  })
);

app.post(
  '/admin/tasks/:taskId/archive',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const { taskId } = req.params;
    const updated = await query(`UPDATE tasks SET is_archived = true WHERE id = $1`, [taskId]);

    if (updated.rowCount === 0) {
      return adminRedirect(req, res, { error: 'Görev bulunamadı.' });
    }

    return adminRedirect(req, res, { message: 'Görev arşive alındı.' });
  })
);

app.post(
  '/admin/tasks/:taskId/unarchive',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const { taskId } = req.params;
    const updated = await query(`UPDATE tasks SET is_archived = false WHERE id = $1`, [taskId]);

    if (updated.rowCount === 0) {
      return adminRedirect(req, res, { error: 'Görev bulunamadı.' });
    }

    return adminRedirect(req, res, { message: 'Görev yeniden aktifleşti.' });
  })
);

// ISARETLEMENIN TEK GERI DONUSU. Ogrenci tarafinda isaret kalicidir; burada
// admin bir GOREV ORNEGININ (gorev + gun) durumunu duzeltebilir. Gerekce:
// ogrenci son saati kacirinca muhurleyici 'not_done' yaziyor ve yapilmis bir
// is kalici olarak "yapilmadi" gorunuyordu — telafisi veritabanina elle
// mudahaleden baska yoktu.
//
// Her duzeltme satirin icine yazilir (corrected_by / corrected_at /
// previous_status / correction_note), yani kapi sessiz degildir.
app.post(
  '/admin/tasks/:taskId/status-fix',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const { taskId } = req.params;
    const action = normalizeText(req.body.action);
    const day = normalizeText(req.body.day);

    if (!TASK_STATUS_FIX_ACTIONS.has(action)) {
      return adminRedirect(req, res, { error: 'Geçersiz işlem.' });
    }
    if (!isDateOnly(day)) {
      return adminRedirect(req, res, { error: 'Geçersiz gün.' });
    }

    const notDogrulama = validateTaskDescription(req.body.note);
    if (!notDogrulama.ok) {
      return adminRedirect(req, res, { error: notDogrulama.error });
    }

    const taskRes = await query(
      `
        SELECT
          id, title, student_id AS "studentId", repeat_type AS "repeatType",
          single_date AS "singleDate", weekly_day AS "weeklyDay",
          monthly_day AS "monthlyDay", custom_dates AS "customDates",
          start_date AS "startDate", end_date AS "endDate",
          estimated_time AS "estimatedTime", is_archived AS "isArchived"
        FROM tasks WHERE id = $1
      `,
      [taskId]
    );
    if (taskRes.rowCount === 0) {
      return adminRedirect(req, res, { error: 'Görev bulunamadı.' });
    }
    const task = mapTask(taskRes.rows[0]);

    // Formdan gelen beklenmedik bir gun kayit acmasin: durum ancak gorevin
    // GERCEKTEN vadesi geldigi gune yazilir.
    const dayObj = new Date(`${day}T00:00:00`);
    if (!isTaskDueOnDateIgnoringArchive(task, dayObj, day)) {
      return adminRedirect(req, res, {
        error: `Bu görev ${day} günü için tanımlı değil; o güne durum yazılamaz.`
      });
    }

    // Sistem taban tarihinden onceki gunler her acilista siliniyor; oraya
    // yazmak "duzelttim" deyip kaydi kaybetmek olurdu.
    if (day < SYSTEM_START_DATE) {
      return adminRedirect(req, res, {
        error: `Sistem ${SYSTEM_START_DATE} tarihinde başlıyor; daha eski günlere durum yazılamaz.`
      });
    }

    const today = todayDateString();
    const nowHm = timeStringInTimeZone();
    const mevcut = await query(
      `SELECT status FROM task_statuses WHERE task_id = $1 AND student_id = $2 AND day = $3::date`,
      [task.id, task.studentId, day]
    );
    const oncekiDurum = mevcut.rowCount ? mevcut.rows[0].status : null;
    const etiket = (durum) =>
      durum === 'done' ? 'Yapıldı' : durum === 'not_done' ? 'Yapılmadı' : 'İşaretsiz';
    const kunye = `"${task.title}" · ${day}`;

    if (action === 'clear') {
      if (!oncekiDurum) {
        return adminRedirect(req, res, { error: `${kunye} zaten işaretsiz.` });
      }
      // Muhurleyici 5 dakikada bir calisiyor: suresi dolmus bir ornegin
      // isaretini silmek kalici degil, geri gelir. "Temizlendi" demek yalan
      // olurdu.
      if (wouldSealerRewriteStatus(task, day, today, nowHm)) {
        return adminRedirect(req, res, {
          error: `${kunye} süresi dolmuş bir görev; işaret silinse otomatik mühürleme 5 dakika içinde yeniden "Yapılmadı" yazar. Bunun yerine "Yapıldı" olarak düzeltin.`
        });
      }
      await query(
        `DELETE FROM task_statuses WHERE task_id = $1 AND student_id = $2 AND day = $3::date`,
        [task.id, task.studentId, day]
      );
      return adminRedirect(req, res, {
        message: `${kunye} işareti kaldırıldı (${etiket(oncekiDurum)} → İşaretsiz).`
      });
    }

    if (oncekiDurum === action) {
      return adminRedirect(req, res, { error: `${kunye} zaten "${etiket(action)}" durumunda.` });
    }

    await query(
      `
        INSERT INTO task_statuses
          (id, task_id, student_id, day, status, note, corrected_by, corrected_at, previous_status, correction_note)
        VALUES ($1, $2, $3, $4::date, $5, '', $6, NOW(), NULL, $7)
        ON CONFLICT (task_id, student_id, day) DO UPDATE
        SET status = EXCLUDED.status,
            corrected_by = EXCLUDED.corrected_by,
            corrected_at = NOW(),
            previous_status = task_statuses.status,
            correction_note = EXCLUDED.correction_note,
            updated_at = NOW()
      `,
      [makeId('status'), task.id, task.studentId, day, action, req.currentUser.id, notDogrulama.value]
    );

    return adminRedirect(req, res, {
      message: `${kunye}: ${etiket(oncekiDurum)} → ${etiket(action)} olarak düzeltildi.`
    });
  })
);

app.post(
  '/admin/tasks/:taskId/delete',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const { taskId } = req.params;
    const deleted = await query(`DELETE FROM tasks WHERE id = $1`, [taskId]);

    if (deleted.rowCount === 0) {
      return adminRedirect(req, res, { error: 'Görev bulunamadı.' });
    }

    return adminRedirect(req, res, { message: 'Görev kalıcı olarak silindi.' });
  })
);

async function getStudentViewModel(req, currentPage) {
  const today = dateStringInTimeZone(process.env.APP_TIMEZONE || 'Europe/Istanbul');
  const nowHm = timeStringInTimeZone();

  const [tasksRes, statusesRes, latestStatusesRes, questionHistoryRes, categoriesRes] = await Promise.all([
    query(
      `
        SELECT
          id,
          title,
          description,
          category_id AS "categoryId",
          student_id AS "studentId",
          repeat_type AS "repeatType",
          single_date AS "singleDate",
          weekly_day AS "weeklyDay",
          monthly_day AS "monthlyDay",
          custom_dates AS "customDates",
          start_date AS "startDate",
          end_date AS "endDate",
          estimated_time AS "estimatedTime",
          is_archived AS "isArchived",
          created_by AS "createdBy",
          source_key AS "sourceKey",
          created_at AS "createdAt"
        FROM tasks
        WHERE student_id = $1
        ORDER BY created_at DESC
      `,
      [req.currentUser.id]
    ),
    query(
      `
        SELECT task_id AS "taskId", student_id AS "studentId", day, status, note
        FROM (
          SELECT
            task_id,
            student_id,
            day,
            status,
            note,
            ROW_NUMBER() OVER (
              PARTITION BY task_id, student_id, day
              ORDER BY updated_at DESC, id DESC
            ) AS rn
          FROM task_statuses
          WHERE student_id = $1 AND day = $2
        ) latest
        WHERE rn = 1
      `,
      [req.currentUser.id, today]
    ),
    query(
      `
        SELECT task_id AS "taskId", day, status, note
        FROM (
          SELECT
            task_id,
            day,
            status,
            note,
            ROW_NUMBER() OVER (
              PARTITION BY task_id
              ORDER BY day DESC, updated_at DESC, id DESC
            ) AS rn
          FROM task_statuses
          WHERE student_id = $1
        ) latest
        WHERE rn = 1
      `,
      [req.currentUser.id]
    ),
    query(
      `
        SELECT
          dq.id,
          dq.student_id AS "studentId",
          dq.day,
          dq.category_id AS "categoryId",
          c.name AS "categoryName",
          dq.lesson_name AS "lessonName",
          dq.correct_count AS "correctCount",
          dq.wrong_count AS "wrongCount",
          dq.duration_minutes AS "durationMinutes",
          dq.updated_at AS "updatedAt"
        FROM daily_questions dq
        LEFT JOIN categories c ON c.id = dq.category_id
        WHERE dq.student_id = $1
        ORDER BY dq.day DESC, dq.updated_at DESC
        LIMIT 20
      `,
      [req.currentUser.id]
    ),
    query(`SELECT id, name FROM categories`)
  ]);

  const categories = categoriesRes.rows;
  const statuses = statusesRes.rows;
  const latestStatusByTaskId = new Map(latestStatusesRes.rows.map((row) => [row.taskId, row]));
  const allTasks = tasksRes.rows.map(mapTask);

  // Defter gorevi ogretim yilindaki HER hafta icin acilir (37 tane). Hepsi
  // listede dursaydi gunluk gorevleri boğardi; listede yalnizca icinde
  // bulunulan haftanınki kalir. Digerleri silinmez - takvimde kendi gununde,
  // haftalik analizde ve raporlarda aynen gorunur.
  const buHaftaninDefterKeyi = lessonLogSourceKey(startOfWeek(today));
  const activeTasks = allTasks
    .filter((task) => !task.isArchived)
    .filter(
      (task) =>
        !isLessonLogTask(task.sourceKey) || task.sourceKey === buHaftaninDefterKeyi
    )
    .sort(compareTasksBySchedule)
    .map((task) => {
      const category = categories.find((c) => c.id === task.categoryId);
      const todayStatus = statuses.find((s) => s.taskId === task.id) || null;
      const latestStatus = latestStatusByTaskId.get(task.id) || null;
      const displayStatus = todayStatus || latestStatus;
      // Isaretlenmis gorev PASIF: durumu, saati, aciklamasi degistirilemez.
      // Tek seferlikte herhangi bir isaret, tekrarlida BUGUNKU isaret sayar.
      const isMarked = task.repeatType === 'once' ? Boolean(displayStatus) : Boolean(todayStatus);
      const locked = isMarked || isTaskLockedNow(task, today, nowHm);
      return {
        ...task,
        isMarked,
        categoryName: category ? category.name : 'Kategori Yok',
        scheduleText: formatTaskSchedule(task),
        todayStatus,
        displayStatus,
        displayStatusDay: displayStatus ? toDateOnly(displayStatus.day) : '',
        displayStatusIsToday: Boolean(todayStatus),
        canManage:
          task.createdBy === req.currentUser.id && task.repeatType === 'once' && !locked,
        // Saat ve aciklama aktarilan gorevlerde de girilebilir; tek kosul
        // kilitli olmamasi. Aciklama ogrencinin kendi notu icin: "3. soruda
        // takildim", "yarim kaldi" gibi. Digerleri (baslik, kategori, tarih)
        // hala yalnizca kendi actigi gorevlerde acik.
        canEditTime: !locked,
        canEditDescription: !locked,
        isLocked: locked
      };
    });

  const doneCount = activeTasks.filter((t) => t.todayStatus && t.todayStatus.status === 'done').length;
  const questionHistory = questionHistoryRes.rows.map((row) => ({
    ...row,
    date: toDateOnly(row.day),
    totalCount: Number(row.correctCount || 0) + Number(row.wrongCount || 0)
  }));

  let calendar = null;
  if (currentPage === 'calendar') {
    calendar = await buildStudentCalendar(
      req.currentUser.id,
      normalizeText(req.query.weekStart),
      today,
      allTasks
    );
  }

  // Yillik plan: ogretim yilinin tum haftalari + secili haftanin icerigi.
  const program =
    currentPage === 'program'
      ? await buildStudentProgramView(
          req.currentUser.id,
          allTasks,
          categories,
          today,
          normalizeText(req.query.hafta)
        )
      : null;

  // Uyanma karti hem kendi sayfasinda hem panonun tepesinde gorunur:
  // sabah uygulamayi acinca ilk isin ona basmak olmali.
  const wake =
    currentPage === 'wake' || currentPage === 'dashboard'
      ? await buildWakeView(req.currentUser.id, currentPage === 'wake' ? 14 : 7)
      : null;

  // Spor karti da hem kendi sayfasinda hem panonun tepesinde gorunur.
  const sport =
    currentPage === 'sport' || currentPage === 'dashboard'
      ? await buildSportView(req.currentUser.id, currentPage === 'sport' ? 14 : 7)
      : null;

  // Rutinler gorev listesinde de AYNI BICIMDE gorunur: gorev satirlarindan
  // birer sahte satir uretilir. Tek gun (bugun) gosterilir — rutin gunluktur,
  // gecmis gunleri listeye doldurmak gunluk gorevleri bogardi.
  //
  // Farklari iki sutunda: Durum rozetleri (zamaninda / gec / kacirildi) ve
  // Islem (tek "Isaretle" dugmesi, gorevlerdeki iki dugme degil).
  const rutinSatirlari = [];
  for (const [tur, gorunum, baslik, endpoint] of [
    ['wake', wake, 'Uyanma Rutini', '/student/wake'],
    ['sport', sport, 'Spor Rutini', '/student/sport']
  ]) {
    if (currentPage !== 'dashboard' || !gorunum || !gorunum.routine) continue;
    const log = gorunum.todayLog;
    // Saat hucresi 72px: tek parca metin ("06:00 (+10 dk)") oraya sigmiyor ve
    // tarayici "(+10 / dk)" gibi anlamsiz yerlerden kiriyordu. Degeri ANLAMLI
    // yerden iki satira boluyoruz: ust satir asil saat, alt satir ayrinti.
    const saatAna = tur === 'wake' ? gorunum.routine.targetTime : gorunum.routine.startTime;
    const saatAlt =
      tur === 'wake'
        ? gorunum.routine.toleranceMinutes
          ? `+${gorunum.routine.toleranceMinutes} dk`
          : ''
        : `→ ${gorunum.routine.endTime}`;
    const hedef = saatAlt ? `${saatAna} ${saatAlt}` : saatAna;
    rutinSatirlari.push({
      id: `routine-${tur}`,
      isRoutine: true,
      routineTur: tur,
      routineEndpoint: endpoint,
      // Not yazma gorev rotasina degil rutin rotasina gider.
      cellEndpoint: `/student/routines/${tur}/note`,
      title: baslik,
      categoryName: 'Rutin',
      scheduleText: `${today} · Bugün`,
      singleDate: today,
      estimatedTime: hedef,
      routineSaatAna: saatAna,
      routineSaatAlt: saatAlt,
      description: log ? log.note : '',
      // Isaretlenince not hala yazilabilir: rutin sabah basilir, not sonra
      // yazilir. Basilmadan once yazacak kayit yok.
      canEditDescription: Boolean(log),
      canEditTime: false,
      canManage: false,
      isMarked: Boolean(log),
      isLocked: Boolean(log),
      routineDoneAt: log ? (tur === 'wake' ? log.wokeAt : log.doneAt) : null,
      routineStatus: log ? log.status : null,
      routineStatusText: log ? log.statusText : 'Bekliyor',
      routineDelay: log ? log.delayMinutes : 0,
      displayStatus: log
        ? { status: log.status === 'missed' ? 'not_done' : 'done', day: today }
        : null,
      displayStatusIsToday: Boolean(log),
      displayStatusDay: today,
      todayStatus: log ? { status: log.status } : null
    });
  }

  const scheduleView = currentPage === 'schedule' ? await buildStudentScheduleView(req) : null;

  // Ogrenci hedefleri yalnizca GORUR; koyma ve degerlendirme adminde.
  const goalsView =
    currentPage === 'goals'
      ? await buildMonthlyGoalsView(req, [{ id: req.currentUser.id, name: req.currentUser.name }])
      : null;

  return {
    user: req.currentUser,
    currentPage,
    today,
    categories,
    activeTasks: [...rutinSatirlari, ...activeTasks],
    doneCount,
    questionEntry: null,
    questionHistory,
    calendar,
    program,
    wake,
    sport,
    scheduleView,
    goalsView,
    message: req.query.message || null,
    error: req.query.error || null
  };
}

app.get('/student', requireRole('student'), (req, res) => res.redirect('/student/dashboard'));

app.get(
  '/student/:page',
  requireRole('student'),
  asyncHandler(async (req, res) => {
    const allowedPages = new Set(['dashboard', 'new-task', 'questions', 'calendar', 'program', 'wake', 'schedule', 'goals', 'sport']);
    const currentPage = allowedPages.has(req.params.page) ? req.params.page : 'dashboard';
    const viewModel = await getStudentViewModel(req, currentPage);
    return res.render('student', viewModel);
  })
);

app.post(
  '/student/wake',
  requireRole('student'),
  asyncHandler(async (req, res) => {
    const routine = await getWakeRoutine(req.currentUser.id);
    if (!routine || !routine.isActive) {
      return studentRedirect(req, res, { error: 'Uyanma rutini tanımlı değil.' });
    }

    const today = dateStringInTimeZone(process.env.APP_TIMEZONE || 'Europe/Istanbul');
    const nowHm = timeStringInTimeZone();
    const sonuc = evaluateWake(nowHm, routine.targetTime, routine.toleranceMinutes);
    if (!sonuc) {
      return studentRedirect(req, res, { error: 'Uyanma saati hesaplanamadı.' });
    }

    // Gunde tek kayit: ilk basis gecerlidir, ikinci basis onu degistiremez.
    // (Aksi halde 06:30'da basip 05:55'te basmis gibi gorunmek mumkun olurdu.)
    const insert = await query(
      `
        INSERT INTO wake_logs (id, student_id, day, target_time, tolerance_minutes, woke_at, status, delay_minutes)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT (student_id, day) DO NOTHING
      `,
      [
        makeId('wake'),
        req.currentUser.id,
        today,
        routine.targetTime,
        routine.toleranceMinutes,
        nowHm,
        sonuc.status,
        sonuc.delayMinutes
      ]
    );

    if (insert.rowCount === 0) {
      return studentRedirect(req, res, { error: 'Bugün için uyanma zaten kaydedilmiş.' });
    }

    const mesaj =
      sonuc.status === 'on_time'
        ? `Günaydın! ${nowHm} — zamanında kalktın.`
        : `${nowHm} kaydedildi — hedeften ${sonuc.delayMinutes} dk geç.`;
    return studentRedirect(req, res, { message: mesaj });
  })
);

app.post(
  '/student/sport',
  requireRole('student'),
  asyncHandler(async (req, res) => {
    const routine = await getSportRoutine(req.currentUser.id);
    if (!routine || !routine.isActive) {
      return studentRedirect(req, res, { error: 'Spor rutini tanımlı değil.' });
    }

    const today = dateStringInTimeZone(process.env.APP_TIMEZONE || 'Europe/Istanbul');
    const nowHm = timeStringInTimeZone();
    const sonuc = evaluateSport(nowHm, routine.startTime, routine.endTime);
    if (!sonuc) {
      return studentRedirect(req, res, { error: 'Spor saati hesaplanamadı.' });
    }

    // Uyanmadaki kural: gunde tek kayit, ILK basis gecerli.
    const insert = await query(
      `
        INSERT INTO sport_logs (id, student_id, day, start_time, end_time, done_at, status, delay_minutes)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT (student_id, day) DO NOTHING
      `,
      [
        makeId('sport'),
        req.currentUser.id,
        today,
        routine.startTime,
        routine.endTime,
        nowHm,
        sonuc.status,
        sonuc.delayMinutes
      ]
    );

    if (insert.rowCount === 0) {
      return studentRedirect(req, res, { error: 'Bugün için spor zaten kaydedilmiş.' });
    }

    const mesajSpor =
      sonuc.status === 'on_time'
        ? `Spor kaydedildi: ${nowHm} — zamanında.`
        : `${nowHm} kaydedildi — başlangıçtan ${sonuc.delayMinutes} dk geç.`;
    return studentRedirect(req, res, { message: mesajSpor });
  })
);

app.get(
  '/student/calendar/export',
  requireRole('student'),
  asyncHandler(async (req, res) => {
    const today = todayDateString();
    const calendar = await buildStudentCalendar(
      req.currentUser.id,
      normalizeText(req.query.weekStart),
      today
    );

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Öğrenci Takip';
    workbook.created = new Date();

    const categoriesRes = await query(`SELECT id, name FROM categories`);
    const categoryNameById = new Map(categoriesRes.rows.map((c) => [c.id, c.name]));
    const statusLabel = (status) => {
      if (status === 'done') return 'Yapıldı';
      if (status === 'not_done') return 'Yapılmadı';
      return 'İşaretlenmedi';
    };

    const sheet = workbook.addWorksheet('Görevler');
    sheet.columns = [
      { header: 'Tarih', key: 'date', width: 13 },
      { header: 'Gün', key: 'dayName', width: 14 },
      { header: 'Takvim', key: 'dayTypeText', width: 20 },
      { header: 'Görev', key: 'title', width: 46 },
      { header: 'Kategori', key: 'categoryName', width: 20 },
      { header: 'Saat', key: 'estimatedTime', width: 10 },
      { header: 'Durum', key: 'statusText', width: 16 }
    ];

    sheet.getRow(1).font = { bold: true };
    sheet.views = [{ state: 'frozen', ySplit: 1 }];

    // Liste formatı: her görev için ayrı satır (tek hücreye toplama yok)
    calendar.days.forEach((day) => {
      const dayTypeText = day.isSchoolDay ? 'Ders günü' : day.dayLabel;

      // Gorevsiz gun de satir alir: tatil gunleri raporda gorunur olsun.
      if (!day.tasks.length) {
        sheet.addRow({
          date: day.date,
          dayName: day.dayName,
          dayTypeText,
          title: '-',
          categoryName: '',
          estimatedTime: '',
          statusText: ''
        });
        return;
      }

      day.tasks.forEach((task) => {
        sheet.addRow({
          date: day.date,
          dayName: day.dayName,
          dayTypeText,
          title: task.title || '',
          categoryName: categoryNameById.get(task.categoryId) || 'Kategori yok',
          estimatedTime: task.estimatedTime || '-',
          statusText: statusLabel(task.status)
        });
      });
    });

    sheet.addRow({});
    const totalDue = calendar.days.reduce((sum, day) => sum + day.dueCount, 0);
    const totalDone = calendar.days.reduce((sum, day) => sum + day.doneCount, 0);
    const totalQuestions = calendar.days.reduce((sum, day) => sum + day.questionTotal, 0);
    const totalDuration = calendar.days.reduce((sum, day) => sum + day.durationMinutes, 0);
    const summaryLabelRow = sheet.addRow({
      date: `${calendar.weekStart} - ${calendar.weekEnd}`,
      dayName: 'Hafta Özeti',
      dayTypeText: [
        `${calendar.academic.yearLabel}`,
        calendar.academic.termLabel,
        calendar.academic.weekNo ? `${calendar.academic.weekNo}. Hafta` : ''
      ]
        .filter(Boolean)
        .join(' · '),
      title: `Toplam Görev: ${totalDue} | Tamamlanan: ${totalDone} | Tamamlanmayan: ${Math.max(totalDue - totalDone, 0)}`,
      categoryName: '',
      estimatedTime: '',
      statusText: `Soru: ${totalQuestions} | Süre: ${totalDuration} dk`
    });
    summaryLabelRow.font = { bold: true };

    sheet.eachRow((row) => {
      row.alignment = { vertical: 'top', wrapText: true };
    });

    const fileName = `haftalik-gorevler-${calendar.weekStart}.xlsx`;
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);

    await workbook.xlsx.write(res);
    return res.end();
  })
);

app.post(
  '/student/tasks',
  requireRole('student'),
  asyncHandler(async (req, res) => {
    const titleValidation = validateTaskTitle(req.body.title);
    if (!titleValidation.ok) {
      return studentRedirect(req, res, { error: titleValidation.error });
    }
    const descriptionValidation = validateTaskDescription(req.body.description);
    if (!descriptionValidation.ok) {
      return studentRedirect(req, res, { error: descriptionValidation.error });
    }
    const title = titleValidation.value;
    const description = descriptionValidation.value;
    const categoryId = normalizeText(req.body.categoryId);
    const planningMode = normalizeText(req.body.planningMode) || 'single';
    const singleDate = normalizeText(req.body.singleDate) || dateStringInTimeZone(process.env.APP_TIMEZONE || 'Europe/Istanbul');
    const rangeStartDate = normalizeText(req.body.rangeStartDate) || singleDate;
    const rangeDayCount = Number(req.body.rangeDayCount);
    const estimatedTimeInput = normalizeText(req.body.estimatedTime);
    const estimatedTimeValidation = normalizeEstimatedTimeForStorage(estimatedTimeInput);
    if (!estimatedTimeValidation.ok) {
      return studentRedirect(req, res, { error: estimatedTimeValidation.error });
    }
    const estimatedTime = estimatedTimeValidation.value;

    if (!categoryId) {
      return studentRedirect(req, res, { error: 'Kategori zorunlu.' });
    }

    if (!['single', 'multi_daily'].includes(planningMode)) {
      return studentRedirect(req, res, { error: 'Plan tipi geçersiz.' });
    }

    if (planningMode === 'single' && !isDateOnly(singleDate)) {
      return studentRedirect(req, res, { error: 'Görev tarihi geçersiz.' });
    }

    if (planningMode === 'multi_daily') {
      if (!isDateOnly(rangeStartDate)) {
        return studentRedirect(req, res, { error: 'Başlangıç tarihi geçersiz.' });
      }
      if (!Number.isInteger(rangeDayCount) || rangeDayCount < 1 || rangeDayCount > 180) {
        return studentRedirect(req, res, { error: 'Gün sayısı 1 ile 180 arasında olmalı.' });
      }
    }

    const categoryRes = await query(`SELECT id FROM categories WHERE id = $1 LIMIT 1`, [categoryId]);
    if (categoryRes.rowCount === 0) {
      return studentRedirect(req, res, { error: 'Kategori bulunamadı.' });
    }

    if (planningMode === 'single') {
      const duplicateTaskRes = await query(
        `
          SELECT id
          FROM tasks
          WHERE student_id = $1
            AND category_id = $2
            AND title = $3
            AND repeat_type = 'once'
            AND single_date = $4
            AND is_archived = false
          LIMIT 1
        `,
        [req.currentUser.id, categoryId, title, singleDate]
      );
      if (duplicateTaskRes.rowCount > 0) {
        return studentRedirect(req, res, { error: 'Aynı gün için aynı başlıkta görev zaten mevcut.' });
      }

      await query(
        `
          INSERT INTO tasks (
            id,
            title,
            description,
            category_id,
            student_id,
            repeat_type,
            single_date,
            weekly_day,
            monthly_day,
            custom_dates,
            start_date,
            end_date,
            estimated_time,
            is_archived,
            created_by
          )
          VALUES ($1,$2,$3,$4,$5,'once',$6,NULL,NULL,'{}',NULL,NULL,$7,false,$8)
        `,
        [
          makeId('task'),
          title,
          description,
          categoryId,
          req.currentUser.id,
          singleDate,
          estimatedTime,
          req.currentUser.id
        ]
      );

      return studentRedirect(req, res, { message: 'Günlük görev eklendi.' });
    }

    const rangeEndDate = shiftDate(rangeStartDate, rangeDayCount - 1);
    const dayList = getDateRangeInclusive(rangeStartDate, rangeEndDate, 200);
    if (!dayList || !dayList.length) {
      return studentRedirect(req, res, { error: 'Toplu plan tarih aralığı geçersiz.' });
    }

    const existingRes = await query(
      `
        SELECT single_date::text AS day
        FROM tasks
        WHERE student_id = $1
          AND category_id = $2
          AND title = $3
          AND repeat_type = 'once'
          AND is_archived = false
          AND single_date BETWEEN $4 AND $5
      `,
      [req.currentUser.id, categoryId, title, rangeStartDate, rangeEndDate]
    );
    const existingDays = new Set(existingRes.rows.map((row) => row.day));
    const daysToInsert = dayList.filter((day) => !existingDays.has(day));

    if (!daysToInsert.length) {
      return studentRedirect(req, res, { error: 'Seçilen aralıktaki görevlerin tamamı zaten mevcut.' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const day of daysToInsert) {
        await client.query(
          `
            INSERT INTO tasks (
              id,
              title,
              description,
              category_id,
              student_id,
              repeat_type,
              single_date,
              weekly_day,
              monthly_day,
              custom_dates,
              start_date,
              end_date,
              estimated_time,
              is_archived,
              created_by
            )
            VALUES ($1,$2,$3,$4,$5,'once',$6,NULL,NULL,'{}',NULL,NULL,$7,false,$8)
          `,
          [
            makeId('task'),
            title,
            description,
            categoryId,
            req.currentUser.id,
            day,
            estimatedTime,
            req.currentUser.id
          ]
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    const skippedCount = dayList.length - daysToInsert.length;
    const infoText = skippedCount > 0
      ? `${daysToInsert.length} adet görev eklendi, ${skippedCount} adet mevcut olduğu için atlandı.`
      : `${daysToInsert.length} adet görev eklendi.`;
    return studentRedirect(req, res, { message: infoText });
  })
);

app.post(
  '/student/tasks/:taskId/cell-update',
  requireRole('student'),
  asyncHandler(async (req, res) => {
    const { taskId } = req.params;
    const field = normalizeText(req.body.field);
    const value = normalizeText(req.body.value);

    // Saat ve aciklama, kendi actigi gorevlerle sinirli DEGIL: aktarilan
    // gorevler (YZ, YDS, defter) saatsiz geliyor ve ogrenci o gun ne
    // yaptigini yazabilmeli. Bu bir yetki gevsetmesi degil: saat girmek son
    // teslimi one ceker (erteleyemez), aciklama ise gorevin kimligini
    // degistirmez. Baslik, kategori ve tarih eskisi gibi yalnizca ogrencinin
    // kendi actigi tek seferlik gorevlerde acik.
    // Aciklama da saat gibi: aktarilan gorevde de yazilabilir. Ogrenci o gun
    // ne yaptigini/nerede takildigini yazabilmeli; bu gorevin KIMLIGINI
    // degistirmez (baslik, kategori, tarih hala kapali).
    const gevsekAlan = field === 'estimatedTime' || field === 'description';
    const taskRes = await query(
      gevsekAlan
        ? `
        SELECT id
        FROM tasks
        WHERE id = $1
          AND student_id = $2
          AND is_archived = false
        LIMIT 1
      `
        : `
        SELECT id
        FROM tasks
        WHERE id = $1
          AND student_id = $2
          AND created_by = $2
          AND repeat_type = 'once'
          AND is_archived = false
        LIMIT 1
      `,
      [taskId, req.currentUser.id]
    );

    if (taskRes.rowCount === 0) {
      return res.status(404).json({ ok: false, error: 'Bu görev güncellenemez.' });
    }

    const { locked: cellLocked, kilitMesaji: cellMesaj } = await findStudentTaskIfEditable(taskId, req.currentUser.id);
    if (cellLocked) {
      return res.status(403).json({ ok: false, error: cellMesaj });
    }

    if (field === 'title') {
      const titleValidation = validateTaskTitle(value);
      if (!titleValidation.ok) {
        return res.status(400).json({ ok: false, error: titleValidation.error });
      }
      await query(`UPDATE tasks SET title = $1 WHERE id = $2`, [titleValidation.value, taskId]);
      return res.json({ ok: true, value: titleValidation.value, display: titleValidation.value });
    }

    if (field === 'description') {
      const descriptionValidation = validateTaskDescription(value);
      if (!descriptionValidation.ok) {
        return res.status(400).json({ ok: false, error: descriptionValidation.error });
      }
      // Bayrak: bundan sonra aktarim bu aciklamayi tazelemesin.
      await query(`UPDATE tasks SET description = $1, description_edited = TRUE WHERE id = $2`, [
        descriptionValidation.value,
        taskId
      ]);
      return res.json({ ok: true, value: descriptionValidation.value, display: descriptionValidation.value || '-' });
    }

    if (field === 'categoryId') {
      const categoryRes = await query(`SELECT id, name FROM categories WHERE id = $1 LIMIT 1`, [value]);
      if (categoryRes.rowCount === 0) {
        return res.status(400).json({ ok: false, error: 'Kategori geçersiz.' });
      }
      await query(`UPDATE tasks SET category_id = $1 WHERE id = $2`, [value, taskId]);
      return res.json({ ok: true, value, display: categoryRes.rows[0].name });
    }

    if (field === 'singleDate') {
      if (!isDateOnly(value)) {
        return res.status(400).json({ ok: false, error: 'Tarih formatı geçersiz.' });
      }
      await query(`UPDATE tasks SET single_date = $1 WHERE id = $2`, [value, taskId]);
      return res.json({ ok: true, value, display: value });
    }

    if (field === 'estimatedTime') {
      const estimatedTimeValidation = normalizeEstimatedTimeForStorage(value);
      if (!estimatedTimeValidation.ok) {
        return res.status(400).json({ ok: false, error: estimatedTimeValidation.error });
      }
      await query(`UPDATE tasks SET estimated_time = $1 WHERE id = $2`, [estimatedTimeValidation.value, taskId]);
      return res.json({
        ok: true,
        value: estimatedTimeValidation.value || '',
        display: estimatedTimeValidation.value || '-'
      });
    }

    return res.status(400).json({ ok: false, error: 'Güncellenebilir alan bulunamadı.' });
  })
);

app.post(
  '/student/tasks/:taskId/update',
  requireRole('student'),
  asyncHandler(async (req, res) => {
    const { taskId } = req.params;
    const titleValidation = validateTaskTitle(req.body.title);
    if (!titleValidation.ok) {
      return studentRedirect(req, res, { error: titleValidation.error });
    }
    const descriptionValidation = validateTaskDescription(req.body.description);
    if (!descriptionValidation.ok) {
      return studentRedirect(req, res, { error: descriptionValidation.error });
    }
    const title = titleValidation.value;
    const description = descriptionValidation.value;
    const categoryId = normalizeText(req.body.categoryId);
    const singleDate = normalizeText(req.body.singleDate);
    const estimatedTimeInput = normalizeText(req.body.estimatedTime);
    const estimatedTimeValidation = normalizeEstimatedTimeForStorage(estimatedTimeInput);
    if (!estimatedTimeValidation.ok) {
      return studentRedirect(req, res, { error: estimatedTimeValidation.error });
    }
    const estimatedTime = estimatedTimeValidation.value;

    if (!categoryId || !isDateOnly(singleDate)) {
      return studentRedirect(req, res, { error: 'Görev güncelleme alanları geçersiz.' });
    }

    const [taskRes, categoryRes] = await Promise.all([
      query(
        `
          SELECT id
          FROM tasks
          WHERE id = $1
            AND student_id = $2
            AND created_by = $2
            AND repeat_type = 'once'
            AND is_archived = false
          LIMIT 1
        `,
        [taskId, req.currentUser.id]
      ),
      query(`SELECT id FROM categories WHERE id = $1 LIMIT 1`, [categoryId])
    ]);

    if (taskRes.rowCount === 0) {
      return studentRedirect(req, res, { error: 'Bu görev güncellenemez.' });
    }

    const { locked: updateLocked, kilitMesaji: updateMesaj } = await findStudentTaskIfEditable(taskId, req.currentUser.id);
    if (updateLocked) {
      return studentRedirect(req, res, { error: updateMesaj });
    }

    if (categoryRes.rowCount === 0) {
      return studentRedirect(req, res, { error: 'Kategori bulunamadı.' });
    }

    await query(
      `
        UPDATE tasks
        SET title = $1, description = $2, category_id = $3, single_date = $4, estimated_time = $5
        WHERE id = $6
      `,
      [title, description, categoryId, singleDate, estimatedTime, taskId]
    );

    return studentRedirect(req, res, { message: 'Görev güncellendi.' });
  })
);

app.post(
  '/student/tasks/:taskId/delete',
  requireRole('student'),
  asyncHandler(async (req, res) => {
    const { taskId } = req.params;

    const { locked, kilitMesaji } = await findStudentTaskIfEditable(taskId, req.currentUser.id);
    if (locked) {
      return studentRedirect(req, res, { error: kilitMesaji });
    }

    const deleted = await query(
      `
        DELETE FROM tasks
        WHERE id = $1
          AND student_id = $2
          AND created_by = $2
          AND repeat_type = 'once'
          AND is_archived = false
      `,
      [taskId, req.currentUser.id]
    );

    if (deleted.rowCount === 0) {
      return studentRedirect(req, res, { error: 'Bu görev silinemedi.' });
    }

    return studentRedirect(req, res, { message: 'Görev silindi.' });
  })
);

app.post(
  '/student/tasks/:taskId/status',
  requireRole('student'),
  asyncHandler(async (req, res) => {
    const { taskId } = req.params;
    const status = normalizeText(req.body.status);
    const note = normalizeText(req.body.note);
    const day = dateStringInTimeZone(process.env.APP_TIMEZONE || 'Europe/Istanbul');

    if (!['done', 'not_done'].includes(status)) {
      return res.redirect(`/student/dashboard?error=${encodeURIComponent('Geçersiz durum.')}`);
    }

    const taskRes = await query(
      `
        SELECT
          id,
          repeat_type AS "repeatType",
          single_date AS "singleDate",
          weekly_day AS "weeklyDay",
          monthly_day AS "monthlyDay",
          custom_dates AS "customDates",
          start_date AS "startDate",
          end_date AS "endDate",
          estimated_time AS "estimatedTime",
          is_archived AS "isArchived"
        FROM tasks
        WHERE id = $1 AND student_id = $2 AND is_archived = false
        LIMIT 1
      `,
      [taskId, req.currentUser.id]
    );

    if (taskRes.rowCount === 0) {
      return res.redirect(`/student/dashboard?error=${encodeURIComponent('Görev bulunamadı.')}`);
    }

    // Zaten isaretlenmis bir gorev PASIFTIR: ilk isaret gecerli, degistirilemez.
    // Uyanma/spor rutinindeki kuralin aynisi.
    const task = mapTask(taskRes.rows[0]);
    if (await isTaskInstanceMarked(task.id, req.currentUser.id, task.repeatType, day)) {
      return res.redirect(
        `/student/dashboard?error=${encodeURIComponent(
          'Bu görev zaten işaretlendi; işareti değiştirilemez.'
        )}`
      );
    }

    // Suresi dolan gorev orneginin isareti degistirilemez.
    if (isTaskLockedNow(task, day, timeStringInTimeZone())) {
      return res.redirect(
        `/student/dashboard?error=${encodeURIComponent(
          'Bu görevin süresi doldu, işareti değiştirilemez.'
        )}`
      );
    }

    const yazma = await query(
      `
        INSERT INTO task_statuses (id, task_id, student_id, day, status, note)
        VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT (task_id, student_id, day) DO NOTHING
      `,
      [makeId('status'), taskId, req.currentUser.id, day, status, note]
    );

    // Yukaridaki kontrolle ayni anda iki istek gelirse ikincisi buraya duser;
    // DO NOTHING sayesinde ilk isaret yine korunur.
    if (yazma.rowCount === 0) {
      return res.redirect(
        `/student/dashboard?error=${encodeURIComponent(
          'Bu görev zaten işaretlendi; işareti değiştirilemez.'
        )}`
      );
    }

    return res.redirect(`/student/dashboard?message=${encodeURIComponent('Görev işaretlendi.')}`);
  })
);

app.post(
  '/student/routines/:tur/note',
  requireRole('student'),
  asyncHandler(async (req, res) => {
    const tur = normalizeText(req.params.tur);
    if (!['wake', 'sport'].includes(tur)) {
      return res.status(404).json({ ok: false, error: 'Rutin bulunamadı.' });
    }

    const dogrulama = validateTaskDescription(normalizeText(req.body.value));
    if (!dogrulama.ok) {
      return res.status(400).json({ ok: false, error: dogrulama.error });
    }

    // Yalnizca BUGUNUN satiri yazilabilir; gecmis gunler muhurludur.
    // Not gorevlerdeki gibi isaretlemeyle KILITLENMEZ: rutin sabah basilir,
    // not ise cogu zaman sonra yazilir ("3 km kostum"). Isaretle kilitlemek
    // alani kullanilamaz hale getirirdi.
    const gun = todayDateString();
    const tablo = tur === 'wake' ? 'wake_logs' : 'sport_logs';
    const sonuc = await query(
      `UPDATE ${tablo} SET note = $1 WHERE student_id = $2 AND day = $3::date`,
      [dogrulama.value, req.currentUser.id, gun]
    );

    if (sonuc.rowCount === 0) {
      return res.status(409).json({
        ok: false,
        error: 'Önce rutini işaretle; not o günün kaydına yazılır.'
      });
    }

    return res.json({ ok: true, value: dogrulama.value, display: dogrulama.value || '-' });
  })
);

app.post(
  '/student/questions',
  requireRole('student'),
  asyncHandler(async (req, res) => {
    const categoryId = normalizeText(req.body.categoryId);
    const lessonName = normalizeText(req.body.lessonName);
    const day = normalizeText(req.body.day) || dateStringInTimeZone(process.env.APP_TIMEZONE || 'Europe/Istanbul');
    const correctCount = Number(req.body.correctCount);
    const wrongCount = Number(req.body.wrongCount);
    const durationMinutes = Number(req.body.durationMinutes);

    if (!categoryId || !lessonName) {
      return res.redirect(`/student/questions?error=${encodeURIComponent('Kategori ve ders adı zorunlu.')}`);
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      return res.redirect(`/student/questions?error=${encodeURIComponent('Tarih formatı geçersiz.')}`);
    }

    if (!Number.isInteger(correctCount) || correctCount < 0) {
      return res.redirect(`/student/questions?error=${encodeURIComponent('Doğru sayısı geçersiz.')}`);
    }

    if (!Number.isInteger(wrongCount) || wrongCount < 0) {
      return res.redirect(`/student/questions?error=${encodeURIComponent('Yanlış sayısı geçersiz.')}`);
    }

    if (!Number.isInteger(durationMinutes) || durationMinutes < 0) {
      return res.redirect(`/student/questions?error=${encodeURIComponent('Süre geçersiz.')}`);
    }

    const categoryRes = await query(`SELECT id FROM categories WHERE id = $1 LIMIT 1`, [categoryId]);
    if (categoryRes.rowCount === 0) {
      return res.redirect(`/student/questions?error=${encodeURIComponent('Kategori bulunamadı.')}`);
    }

    await query(
      `
        INSERT INTO daily_questions (
          id, student_id, day, category_id, lesson_name, correct_count, wrong_count, duration_minutes, count, note
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'')
      `,
      [makeId('q'), req.currentUser.id, day, categoryId, lessonName, correctCount, wrongCount, durationMinutes, correctCount + wrongCount]
    );

    return res.redirect(`/student/questions?message=${encodeURIComponent('Soru kaydı kaydedildi.')}`);
  })
);

app.get(
  '/healthz',
  asyncHandler(async (_req, res) => {
    await query('SELECT 1');
    return res.json({
      ok: true,
      service: 'öğrenci-takip-app',
      time: new Date().toISOString()
    });
  })
);

app.use((req, res) => {
  res.status(404).send('Sayfa bulunamadı.');
});

app.use((err, req, res, _next) => {
  console.error('Uygulama hatası:', err);

  if (req.path.startsWith('/admin')) {
    return adminRedirect(req, res, { error: 'Beklenmeyen bir hata oluştu.' });
  }

  if (req.path.startsWith('/student')) {
    return res.redirect(`/student/dashboard?error=${encodeURIComponent('Beklenmeyen bir hata oluştu.')}`);
  }

  if (req.path === '/login') {
    return res.status(500).render('login', { error: 'Beklenmeyen bir hata oluştu.' });
  }

  return res.status(500).send('Sunucu hatası.');
});

// Muhurleme yalnizca sayfa acildiginda degil, arka planda da calisir; boylece
// kimse giris yapmasa bile suresi dolan gorevler isaretlenir.
const AUTO_LOCK_INTERVAL_MS = 5 * 60 * 1000;

/**
 * SISTEM_START_DATE oncesindeki kayitlari siler.
 *
 * Sistem ogretim yilindan once kurulup denendi; oncesinde kalan gorevler,
 * durumlar, rutin kayitlari ve defter satirlari gercek bir gecmis degil
 * kurulum artigi. Kullanici bunlarin tamamen kaldirilmasini istedi.
 *
 * DOKUNULMAYANLAR (bilincli):
 *   - yds_days ve source_key LIKE 'yds:%' olan daily_questions — bunlar
 *     yds.obs'un GERCEK calisma gecmisinin aynasi, bu uygulamanin kaydi degil.
 *     Silinseler senkron 5 dakika icinde geri yazardi; ustelik baska bir
 *     uygulamanin verisini yok etmek olurdu.
 *   - Tekrarli gorevler (repeat_type <> 'once'): start_date'i eski olan aktif
 *     bir gorev silinmemeli. Onlarin taban oncesi ORNEKLERI zaten
 *     task_statuses ile gidiyor.
 *   - users, categories, class_schedule, ayarlar — tarihe bagli degiller.
 *
 * Tek islemde calisir (hepsi ya da hicbiri) ve idempotenttir: ikinci calisma
 * hicbir sey silmez.
 */
async function purgeBeforeSystemStart() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const sil = async (etiket, sql, params = [SYSTEM_START_DATE]) => {
      const r = await client.query(sql, params);
      return [etiket, r.rowCount || 0];
    };

    // SIRALI calisir: tek bir pg baglantisinda es zamanli sorgu yasak
    // (client.query kuyruga alinir ama surum 9'da kaldirilacak).
    const isler = [
      ['uyanma', `DELETE FROM wake_logs WHERE day < $1::date`],
      ['spor', `DELETE FROM sport_logs WHERE day < $1::date`],
      ['görev durumu', `DELETE FROM task_statuses WHERE day < $1::date`],
      ['görev notu', `DELETE FROM task_detail_notes WHERE day < $1::date`],
      // YDS aynasi haric: yalnizca elle girilen / baska kaynakli satirlar.
      [
        'soru kaydı',
        `DELETE FROM daily_questions
           WHERE day < $1::date
             AND (source_key IS NULL OR source_key NOT LIKE 'yds:%')`
      ],
      ['defter satırı', `DELETE FROM lesson_topics WHERE week_start < $1::date`],
      // Ayin tamami taban ayindan onceyse silinir; icinde bulunulan ay durur.
      [
        'aylık hedef',
        `DELETE FROM monthly_goals WHERE month_start < date_trunc('month', $1::date)`
      ],
      // Tek seferlik gorevler; durum ve notlari ON DELETE CASCADE ile gider.
      ['görev', `DELETE FROM tasks WHERE repeat_type = 'once' AND single_date < $1::date`]
    ];

    const sonuc = {};
    for (const [etiket, sql] of isler) {
      const [, adet] = await sil(etiket, sql);
      sonuc[etiket] = adet;
    }

    await client.query('COMMIT');
    return sonuc;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function runSealSafely() {
  // Taban tarih oncesi kayitlar, muhurlemeden ONCE temizlenir; yoksa
  // muhurleyici sildigimiz gunlere yeniden satir yazardi.
  if (SYSTEM_PURGE_ENABLED) {
    try {
      const sonuc = await purgeBeforeSystemStart();
      const ozet = Object.entries(sonuc)
        .filter(([, n]) => n > 0)
        .map(([ad, n]) => `${n} ${ad}`)
        .join(', ');
      if (ozet) {
        console.log(
          `${SYSTEM_START_DATE} öncesi silindi: ${ozet}. ` +
            `(YDS aynası korundu.)`
        );
      }
    } catch (err) {
      console.error('Taban tarih öncesi temizleme hatası:', err);
    }
  }

  // Defter tamamlamasi otomatik kilitten ONCE calisir: kilit once calissa
  // pazar gunu tamamlanan bir defter "yapilmadi" muhurlenmis olurdu.
  try {
    const { completed } = await completeLessonLogTasks();
    if (completed > 0) {
      console.log(`${completed} haftanın ders defteri tamamlandı, görev işaretlendi.`);
    }
  } catch (err) {
    console.error('Ders defteri tamamlama hatası:', err);
  }

  try {
    const { inserted } = await sealOverdueTaskStatuses();
    if (inserted > 0) {
      console.log(`Süresi dolan ${inserted} görev otomatik "yapılmadı" olarak işaretlendi.`);
    }
  } catch (err) {
    console.error('Otomatik işaretleme hatası:', err);
  }

  try {
    const { sealed } = await sealMissedWakeLogs();
    if (sealed > 0) {
      console.log(`${sealed} gün için uyanma kaydı "kaçırıldı" olarak mühürlendi.`);
    }
  } catch (err) {
    console.error('Uyanma rutini mühürleme hatası:', err);
  }

  try {
    const { sealed } = await sealMissedSportLogs();
    if (sealed > 0) {
      console.log(`${sealed} gün için spor kaydı "yapılmadı" olarak mühürlendi.`);
    }
  } catch (err) {
    console.error('Spor rutini mühürleme hatası:', err);
  }

  // YDS ilerlemesi: dosya yoksa (lokal gelistirme) sessizce gecilir, log
  // kirletmez; gercek bir hata olursa yds_sync.last_error'a da yazilir.
  try {
    const sonuc = await syncYdsProgress();
    if (sonuc.ok && sonuc.reset) {
      console.log(
        `YDS sıfırlaması yansıtıldı: ${sonuc.removedDays} gün, ${sonuc.removedQuestionRows} soru kaydı silindi.`
      );
    }
    if (sonuc.ok && sonuc.days > 0) {
      console.log(`YDS ilerlemesi yansıtıldı: ${sonuc.days} gün.`);
    }
  } catch (err) {
    console.error('YDS senkron hatası:', err);
  }
}

async function bootstrap() {
  await initDb();
  await seedAdmin();

  // YZ kategorilerini acilista topla. Aktarim dugmesine basmak gerekmesin
  // diye: kullanici deploy sonrasi ekranda hala eski kurs kategorilerini
  // gorunce ozelligin calismadigini dusunuyordu. Idempotent - toplanacak
  // gorev yoksa sessizce gecer. Hata uygulamayi durdurmaz.
  for (const [prefix, ad, etiket] of [
    [yzProgram.SOURCE_PREFIX, YZ_CATEGORY, 'YZ'],
    [ydsProgram.SOURCE_PREFIX, YDS_CATEGORY, 'YDS']
  ]) {
    try {
      const sonuc = await consolidateCategory(prefix, ad);
      if (sonuc.merged > 0) {
        console.log(
          `${sonuc.merged} ${etiket} görevi "${ad}" kategorisinde toplandı` +
            (sonuc.removedCategories ? `, ${sonuc.removedCategories} boşalan kategori silindi` : '') +
            (sonuc.keptCategories ? `, ${sonuc.keptCategories} kategori başka kayıtlar bağlı olduğu için silinmedi` : '') +
            '.'
        );
      }
    } catch (err) {
      console.error(`${etiket} kategori toplama hatası:`, err);
    }
  }

  await runSealSafely();
  setInterval(runSealSafely, AUTO_LOCK_INTERVAL_MS).unref();

  const port = Number(process.env.PORT || 3000);
  app.listen(port, () => {
    console.log(`Sunucu çalışıyor: http://localhost:${port}`);
  });
}

bootstrap().catch((err) => {
  console.error('Başlatma hatası:', err);
  process.exit(1);
});
