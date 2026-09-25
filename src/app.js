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
const schedule = require('./schedule');
// Kenar cubugu menusundeki cizgi ikonlari (bkz. src/menuIcons.js).
const { menuIcons } = require('./menuIcons');
const menu = require('./menu');

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
    // Rutinler okul yılı başından (SYSTEM_START_DATE = 14 Eylül) itibaren
    // takip edilir; gerçek oluşturma günü tabanı DARALTMAZ (kullanıcı tüm
    // rutinleri 14 Eylül'den başlattı). created_at yalnızca kayıt için durur.
    createdDay: SYSTEM_START_DATE
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
    // Rutinler okul yılı başından (SYSTEM_START_DATE = 14 Eylül) itibaren
    // takip edilir; gerçek oluşturma günü tabanı DARALTMAZ (kullanıcı tüm
    // rutinleri 14 Eylül'den başlattı). created_at yalnızca kayıt için durur.
    createdDay: SYSTEM_START_DATE
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
    // Rutinler 14 Eylül'den (SYSTEM_START_DATE) itibaren mühürlenir; rutinin
    // gerçek oluşturma günü tabanı daraltmaz.
    const basladi = SYSTEM_START_DATE;
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
    // Rutinler 14 Eylül'den (SYSTEM_START_DATE) itibaren mühürlenir; rutinin
    // gerçek oluşturma günü tabanı daraltmaz.
    const basladi = SYSTEM_START_DATE;
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
  const [scheduleSettings, scheduleEntries, scheduleTimes] = await Promise.all([
    getScheduleSettings(),
    getScheduleEntries(weekStart),
    getPeriodTimes(weekStart)
  ]);

  const days = getWeekDates(weekStart).map((day) => {
    const dayDateObj = new Date(`${day}T00:00:00`);
    const dueTasks = tasks.filter((task) => isTaskDueOnDate(task, dayDateObj, day));
    const doneCount = dueTasks.filter(
      (task) => statusByTaskAndDay.get(`${task.id}:${day}`) === 'done'
    ).length;
    const dayQuestion = questionByDay.get(day);

    const dayInfo = academicCalendar.getDayInfo(day);

    // Haftalik takvim 7 gun kartini gosterir ama ders programi Pzt-Cum
    // (bkz. schedule.GUNLER): hafta sonu gunlerine ders dusmez. Boylece DB'de
    // kalan eski Cmt/Paz kayitlari takvimde de lesson olarak gorunmez.
    const haftaninGunu = schedule.dayOfWeek(day);
    const dersler = schedule.GUNLER.includes(haftaninGunu)
      ? schedule.lessonsForDay(scheduleEntries, haftaninGunu, scheduleSettings, scheduleTimes)
      : [];

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

  const [
    studentsRes,
    categoriesRes,
    tasksRes,
    statusesRes,
    questionsRes,
    wakeRes,
    sportRes,
    prayerRes,
    ...studyRes
  ] = await Promise.all([
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
    ),
    // Namaz gun basina BES satir: satirlari tasimak yerine gun bazinda
    // saydirip getiriyoruz (hafta x ogrenci x 5 satir yerine gun basina tek
    // satir).
    query(
      `
        SELECT student_id AS "studentId", day,
               count(*)::int AS "tracked",
               count(*) FILTER (WHERE status = 'on_time')::int AS "onTime",
               count(*) FILTER (WHERE status = 'qada')::int AS "qada",
               count(*) FILTER (WHERE status = 'missed')::int AS "missed"
        FROM prayer_logs
        WHERE day BETWEEN $1 AND $2
        GROUP BY student_id, day
      `,
      [prevWeekStart, weekEnd]
    ),
    // Planli calisma rutinleri gunde tek kayit tutar; ikisi de ayni turda
    // cekilir (tablo adi sabit haritadan gelir, istekten degil).
    ...Object.values(STUDY_KINDS).map((kind) =>
      query(
        `
          SELECT student_id AS "studentId", day, status, minutes,
                 actual_minutes AS "actualMinutes"
          FROM ${kind.logsTable}
          WHERE day BETWEEN $1 AND $2
        `,
        [prevWeekStart, weekEnd]
      )
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

  const prayerRows = prayerRes.rows.map((row) => ({
    studentId: row.studentId,
    date: toDateOnly(row.day),
    tracked: Number(row.tracked || 0),
    onTime: Number(row.onTime || 0),
    qada: Number(row.qada || 0),
    missed: Number(row.missed || 0)
  }));
  const prayerByStudentDay = new Map(prayerRows.map((r) => [`${r.studentId}:${r.date}`, r]));

  // Tur basina ayri harita: `studyByKind.get('yds').get('ogrId:gun')`
  const studyKindList = Object.values(STUDY_KINDS);
  const studyByKind = new Map(
    studyKindList.map((kind, i) => [
      kind.key,
      new Map(
        studyRes[i].rows.map((row) => {
          const satir = {
            studentId: row.studentId,
            date: toDateOnly(row.day),
            status: row.status,
            minutes: Number(row.minutes || 0),
            actualMinutes:
              row.actualMinutes === null || row.actualMinutes === undefined
                ? null
                : Number(row.actualMinutes)
          };
          return [`${satir.studentId}:${satir.date}`, satir];
        })
      )
    ])
  );

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
    sportDelaySum: 0,
    // Namaz: payda GUN degil VAKIT sayisi (gunde bes). tracked = kaydi olan
    // vakit sayisi; kaza ayri sayilir cunku "kilindi" ama "vaktinde" degil.
    prayerTracked: 0,
    prayerOnTime: 0,
    prayerQada: 0,
    prayerMissed: 0,
    // Planli calisma rutinleri tur basina ayri sayilir. `minutes` gercek
    // girildiyse onu, girilmediyse plani sayar; `actualDays` sayinin ne
    // kadarinin olculdugunu gosterir.
    study: Object.fromEntries(
      Object.keys(STUDY_KINDS).map((k) => [
        k,
        { tracked: 0, done: 0, makeup: 0, notDone: 0, minutes: 0, actualDays: 0 }
      ])
    )
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

  /** Bir gunun namaz ozetini metrige ekler (gun basina bes vakit). */
  function addPrayer(metrik, gun) {
    if (!gun) return;
    metrik.prayerTracked += gun.tracked;
    metrik.prayerOnTime += gun.onTime;
    metrik.prayerQada += gun.qada;
    metrik.prayerMissed += gun.missed;
  }

  /** Bir gunun planli calisma kaydini metrige ekler. */
  function addStudy(metrik, kindKey, log) {
    if (!log) return;
    const m = metrik.study[kindKey];
    m.tracked += 1;
    if (log.status === 'done') m.done += 1;
    else if (log.status === 'makeup') m.makeup += 1;
    else if (log.status === 'not_done') m.notDone += 1;
    m.minutes += studyEffectiveMinutes(log);
    if (log.actualMinutes !== null) m.actualDays += 1;
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
      addPrayer(metrik, prayerByStudentDay.get(`${studentId}:${day}`));
      for (const kind of studyKindList) {
        addStudy(metrik, kind.key, studyByKind.get(kind.key).get(`${studentId}:${day}`));
      }
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
      averageSport: metrik.sportDone ? minutesToHm(metrik.sportMinutesSum / metrik.sportDone) : null,
      // Iki ayri oran bilerek: "vaktinde" asil olcu, "kaza ile birlikte"
      // kilinan vakitleri gosterir. Tek orana indirmek kazayi ya gorunmez
      // yapardi ya da vaktinde kilmisla esitlerdi.
      prayerOnTimeRate: oran(metrik.prayerOnTime, metrik.prayerTracked),
      prayerDoneRate: oran(metrik.prayerOnTime + metrik.prayerQada, metrik.prayerTracked),
      // Namazdaki ikili oranin aynisi: "yapildi" asil olcu, telafi ayri.
      study: Object.fromEntries(
        Object.entries(metrik.study).map(([k, m]) => [
          k,
          {
            ...m,
            doneRate: oran(m.done, m.tracked),
            withMakeupRate: oran(m.done + m.makeup, m.tracked)
          }
        ])
      )
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
            : null,
        prayerOnTimeRate:
          current.prayerOnTimeRate !== null && previous.prayerOnTimeRate !== null
            ? Math.round((current.prayerOnTimeRate - previous.prayerOnTimeRate) * 10) / 10
            : null,
        study: Object.fromEntries(
          Object.keys(STUDY_KINDS).map((k) => {
            const c = current.study[k].doneRate;
            const o = previous.study[k].doneRate;
            return [k, c !== null && o !== null ? Math.round((c - o) * 10) / 10 : null];
          })
        )
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
      // Spor alanlari bu toplamda hic birikmiyordu (toplam spor oranı her
      // zaman bos donerdi); namaz KPI'si eklenirken birlikte tamamlandi.
      acc.sportTracked += row.current.sportTracked;
      acc.sportOnTime += row.current.sportOnTime;
      acc.sportLate += row.current.sportLate;
      acc.sportMissed += row.current.sportMissed;
      acc.sportDone += row.current.sportDone;
      acc.sportMinutesSum += row.current.sportMinutesSum;
      acc.sportDelaySum += row.current.sportDelaySum;
      acc.prayerTracked += row.current.prayerTracked;
      acc.prayerOnTime += row.current.prayerOnTime;
      acc.prayerQada += row.current.prayerQada;
      acc.prayerMissed += row.current.prayerMissed;
      for (const k of Object.keys(STUDY_KINDS)) {
        acc.study[k].tracked += row.current.study[k].tracked;
        acc.study[k].done += row.current.study[k].done;
        acc.study[k].makeup += row.current.study[k].makeup;
        acc.study[k].notDone += row.current.study[k].notDone;
        acc.study[k].minutes += row.current.study[k].minutes;
        acc.study[k].actualDays += row.current.study[k].actualDays;
      }
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
      const prayerGun = prayerByStudentDay.get(`${selected.id}:${day}`) || null;
      addPrayer(gun, prayerGun);
      const gunStudy = {};
      for (const kind of studyKindList) {
        const log = studyByKind.get(kind.key).get(`${selected.id}:${day}`) || null;
        addStudy(gun, kind.key, log);
        gunStudy[kind.key] = log
          ? { ...log, label: kind.label, statusText: studyStatusText(log.status) }
          : null;
      }

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
        prayer: prayerGun,
        // Ad bilerek `study` degil: `ozetle(gun)` kendi `study` METRIK
        // nesnesini donduruyor ve uzerine yazardi (hucreler bos kalirdi).
        studyLogs: gunStudy,
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
 * GUNE OZEL ZIL SAATLERI.
 *
 * Varsayilan duzen hala hesaplanir; burasi yalnizca istisnalari getirir.
 * Tablo bos oldugunda harita bos doner ve butun cagiranlar eskisi gibi
 * hesaplanan saatleri kullanir.
 */
async function getPeriodTimes(weekStart = null) {
  // Zil saatleri artik HAFTAYA OZEL: her hafta kendi elle girilmis saatlerini
  // tasir (period_times.week_start). Hafta verilmezse bos harita doner —
  // varsayilan sablon kalktigi icin "hafta yok" = elle saat yok demektir.
  const hafta = isDateOnly(weekStart) ? startOfWeek(weekStart) : null;
  if (!hafta) return schedule.buildPeriodTimeMap([]);
  const res = await query(
    `
      SELECT day_of_week AS "dayOfWeek", period,
             start_time AS "startTime", end_time AS "endTime"
      FROM period_times
      WHERE week_start = $1
      ORDER BY day_of_week ASC, period ASC
    `,
    [hafta]
  );
  return schedule.buildPeriodTimeMap(
    res.rows.map((r) => ({
      dayOfWeek: r.dayOfWeek,
      period: r.period,
      start: normalizeEstimatedTimeForDisplay(r.startTime),
      end: normalizeEstimatedTimeForDisplay(r.endTime)
    }))
  );
}

/**
 * Ogretim yilindaki TUM haftalarin elle girilmis zil saatleri:
 * weekStart -> (gun:saat -> {start,end}) haritasi. Ders gorevleri tum yili
 * hafta hafta gezdigi icin her haftanin kendi saatlerine tek sorguda ulasir.
 */
async function getAllPeriodTimes() {
  const res = await query(
    `
      SELECT week_start AS "weekStart", day_of_week AS "dayOfWeek", period,
             start_time AS "startTime", end_time AS "endTime"
      FROM period_times
      ORDER BY week_start ASC, day_of_week ASC, period ASC
    `
  );
  const satirlarByWeek = new Map();
  for (const r of res.rows) {
    const hafta = toDateOnly(r.weekStart);
    if (!satirlarByWeek.has(hafta)) satirlarByWeek.set(hafta, []);
    satirlarByWeek.get(hafta).push({
      dayOfWeek: r.dayOfWeek,
      period: r.period,
      start: normalizeEstimatedTimeForDisplay(r.startTime),
      end: normalizeEstimatedTimeForDisplay(r.endTime)
    });
  }
  const out = new Map();
  for (const [hafta, satirlar] of satirlarByWeek) {
    out.set(hafta, schedule.buildPeriodTimeMap(satirlar));
  }
  return out;
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
 * Bir haftanin cizelgesi: YALNIZCA o haftanin kendi satirlari.
 *
 * Varsayilan sablon KALDIRILDI: her hafta bagimsizdir, admin o hafta gelince
 * girer, girilmemis hafta BOSTUR (gelecek haftalar onceden belli degil).
 * Hafta verilmezse yine bos doner — cagiranlar artik somut bir hafta gecer.
 */
async function getScheduleEntries(weekStart = null) {
  const hafta = isDateOnly(weekStart) ? startOfWeek(weekStart) : null;
  if (!hafta) return [];
  const ozel = await query(SCHEDULE_SELECT, [hafta]);
  return ozel.rows.map(mapScheduleEntry);
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
 * Ders Programi sayfasinin hangi izgarayi hesaplayacagi: secili BOLUM.
 *
 * Defter alanlari (islenen konular, ders gorevleri, defter yetkisi, Excel)
 * konular gorunumunu; digerleri cizelgeyi kullanir. Eski `?gorunum=konular`
 * baglantilari da calismaya devam eder.
 */
const DEFTER_BOLUMLERI = new Set(['konular', 'gorevler', 'defter', 'excel']);

function scheduleGorunum(req) {
  const bolum = normalizeText(req.query.bolum);
  if (DEFTER_BOLUMLERI.has(bolum)) return 'konular';
  if (bolum) return 'cizelge';
  return normalizeText(req.query.gorunum) === 'konular' ? 'konular' : 'cizelge';
}

/**
 * "İşlenen Konular" gorunumu: cizelgeyle AYNI izgara, ama secili haftada her
 * dolu ders saatine konu yazilir. Tatil/bayrama denk gelen gunlerde giris
 * alani acilmaz — o gun ders islenmedi.
 */
async function buildTopicWeekView(req, ayar, ozelSaatler = null) {
  const today = todayDateString();
  const weekStart = normalizeWeekStart(normalizeText(req.query.hafta), today) || startOfWeek(today);
  const weekEnd = shiftDate(weekStart, 6);

  const [konular, oncekiKonular] = await Promise.all([
    getLessonTopics(weekStart),
    getLessonTopics(shiftDate(weekStart, -7))
  ]);

  // O HAFTANIN cizelgesi: hafta ozellestirilmisse kendi satirlari, degilse
  // sablon. Defter, o hafta gercekten ne okutulduguna gore acilir.
  // Hafta sonu ders programindan cikarildi (bkz. schedule.GUNLER): DB'de kalan
  // Cmt/Paz kayitlari defterde de gorunmesin diye elenir (silinmez).
  const kayitlar = (await getScheduleEntries(weekStart)).filter((k) =>
    schedule.GUNLER.includes(Number(k.dayOfWeek))
  );
  const haftaBilgi = await getWeekScheduleInfo(weekStart);

  const saatler = schedule.buildPeriods(ayar);
  // Defter izgarasinda da saat HUCREYE aittir: ayni ders saati gunden gune
  // farkli olabilir.
  const gunSaatleri = new Map(
    schedule.GUNLER.map((gun) => [
      gun,
      new Map(schedule.periodsForDay(ayar, gun, ozelSaatler).map((sa) => [sa.period, sa]))
    ])
  );
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
        saat: (gunSaatleri.get(g.dayOfWeek) || new Map()).get(saat.period) || {
          ...saat,
          ozel: false
        },
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

  // Bu haftanin ders gorevleri OGRENCI OGRENCI: gorevler yalnizca aktarim
  // yapilan ogrenciye yazilir; "olusturdum ama gorunmuyor" vakalarinin en
  // olasi sebebi yanlis ogrenci. Panel bunu acikca gostersin diye her
  // ogrencinin o haftaki gorev/isaret sayisi ayri ayri doner.
  const buHaftaGorev = await query(
    `
      SELECT u.id AS "studentId", u.name AS "studentName",
             count(t.id)::int AS toplam,
             count(st.id) FILTER (WHERE st.status = 'done')::int AS isaretli
      FROM users u
      LEFT JOIN tasks t
        ON t.student_id = u.id
       AND t.source_key LIKE $1
       AND t.single_date BETWEEN $2::date AND $3::date
      LEFT JOIN task_statuses st ON st.task_id = t.id
      WHERE u.role = 'student'
      GROUP BY u.id, u.name
      ORDER BY u.name
    `,
    [`${LESSON_PREFIX}:%`, weekStart, weekEnd]
  );

  return {
    weekStart,
    weekEnd,
    prevWeekStart: shiftDate(weekStart, -7),
    nextWeekStart: shiftDate(weekStart, 7),
    thisWeekStart: startOfWeek(today),
    haftaGorevleri: buHaftaGorev.rows.map((r) => ({
      studentId: r.studentId,
      studentName: r.studentName,
      toplam: Number(r.toplam) || 0,
      isaretli: Number(r.isaretli) || 0
    })),
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

// --- Ders gorevleri --------------------------------------------------------
//
// HER DERS SAATI KENDI GOREVIDIR: cizelgedeki her ders kendi gunune bir gorev
// olarak yazilir ("3. ders · Matematik"), konusu yazilinca gorev otomatik
// "yapildi" isaretlenir.
//
// Once haftada TEK gorev vardi ("Ders defterini doldur") ve ancak haftanin
// butun hucreleri dolunca tamamlaniyordu. Kullanici bir dersi isleyip haftayi
// kaydettiginde "Gorevlerim"de hicbir sey degismiyordu — gorev listesi
// yapilan isi gostermiyordu. Model ders basina goreve cevrildi.

const LESSON_PREFIX = 'ders';
// Ders gorevlerinin kategorisi. Kullanici "Ders Programi" adini "GAP MTAL"
// yapti; db.js'teki idempotent goc mevcut kategoriyi de yeniden adlandirir.
const LESSON_CATEGORY = 'GAP MTAL';

function lessonSourceKey(tarih, saat) {
  return `${LESSON_PREFIX}:${tarih}:${saat}`;
}

function isLessonTask(sourceKey) {
  return typeof sourceKey === 'string' && sourceKey.startsWith(`${LESSON_PREFIX}:`);
}

/**
 * Ogretim yilindaki TUM ders saatleri, gorev satirina cevrilmis hali.
 *
 * Her hafta KENDI cizelgesiyle hesaplanir; varsayilan sablon KALKTI, o yuzden
 * girilmemis hafta ders URETMEZ (gelecek onceden belli degil). Zil saatleri de
 * haftaya ozeldir: `tumSaatler` weekStart -> (gun:saat -> saat) haritasidir.
 */
function buildLessonTaskRows(ozelHaftalar, ayar, tumSaatler = new Map()) {
  const { start, end } = academicCalendar.ACADEMIC_YEAR;
  const satirlar = [];

  let weekStart = startOfWeek(start);
  while (weekStart <= end) {
    const haftaninKayitlari = ozelHaftalar.get(weekStart) || [];
    // Zil saati gune VE haftaya bagli: gorev aciklamasinda yazan saat, o
    // haftanin o gununun gercek saati olmali.
    const ozelSaatler = tumSaatler.get(weekStart) || null;
    const gunSaatleri = new Map(
      schedule.GUNLER.map((gun) => [
        gun,
        new Map(schedule.periodsForDay(ayar, gun, ozelSaatler).map((sa) => [sa.period, sa]))
      ])
    );
    for (const gun of schedule.GUNLER) {
      const tarih = shiftDate(weekStart, gun - 1);
      if (tarih < start || tarih > end) continue;
      for (const kayit of haftaninKayitlari.filter((e) => e.dayOfWeek === gun)) {
        const zil = (gunSaatleri.get(gun) || new Map()).get(kayit.period) || null;
        satirlar.push({
          tarih,
          weekStart,
          dayOfWeek: gun,
          period: kayit.period,
          subject: kayit.subject,
          className: kayit.className || '',
          room: kayit.room || '',
          kind: kayit.kind,
          zil
        });
      }
    }
    weekStart = shiftDate(weekStart, 7);
  }

  return satirlar;
}

function lessonTaskTitle(satir) {
  return `${satir.period}. ders · ${satir.subject}`;
}

// Gorevin kendi kunyesi: zil saati, sinif, derslik. "Islenen konuyu yaz" gibi
// kalip bir metin EKLENMEZ — ogrenci listesinde aciklama sutununda artik
// YAZILAN KONU duruyor, kunye baslik altinda kucuk satirda.
function lessonTaskDescription(satir) {
  const parcalar = [];
  if (satir.zil) parcalar.push(`${satir.zil.start}-${satir.zil.end}`);
  if (satir.className) parcalar.push(satir.className);
  if (satir.room) parcalar.push(satir.room);
  return parcalar.join(' · ');
}

/**
 * Ders gorevlerini olusturur/tazeler. Onceki aktarimlarla ayni desen: yeni
 * dersleri ekler, degisen baslik/aciklamayi yalnizca ISARETLENMEMIS ve GUNU
 * GELMEMIS gorevlerde tazeler, cizelgeden kalkan derslerin (yine yalnizca
 * isaretlenmemis + gelecek) gorevlerini siler.
 *
 * Son saat (estimated_time) YAZILMAZ: gunun sonu (23:59) son teslimdir.
 * Dersin bitis saatine baglansaydi, aksam deftere yazan ogretmenin gorevi
 * ogleden sonra "yapilmadi" muhurlenmis olurdu.
 */
async function importLessonTasks(studentId, createdBy) {
  const [ayar, ozelHaftalar, tumSaatler] = await Promise.all([
    getScheduleSettings(),
    getCustomScheduleWeeks(),
    getAllPeriodTimes()
  ]);
  const satirlar = buildLessonTaskRows(ozelHaftalar, ayar, tumSaatler);
  if (!satirlar.length) {
    return { inserted: 0, updated: 0, removed: 0, skipped: 0, categories: 0, lessons: 0 };
  }

  const today = todayDateString();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let createdCategories = 0;
    const mevcut = await client.query(`SELECT id FROM categories WHERE name = $1`, [
      LESSON_CATEGORY
    ]);
    let categoryId;
    if (mevcut.rowCount > 0) {
      categoryId = mevcut.rows[0].id;
    } else {
      categoryId = makeId('cat');
      await client.query(`INSERT INTO categories (id, name) VALUES ($1, $2)`, [
        categoryId,
        LESSON_CATEGORY
      ]);
      createdCategories = 1;
    }

    let inserted = 0;
    let updated = 0;
    for (const satir of satirlar) {
      const sourceKey = lessonSourceKey(satir.tarih, satir.period);
      const baslik = lessonTaskTitle(satir);
      const aciklama = lessonTaskDescription(satir);

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
        [makeId('task'), baslik, aciklama, categoryId, studentId, satir.tarih, createdBy, sourceKey]
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
              category_id = $3
          WHERE t.student_id = $4
            AND t.source_key = $5
            AND t.single_date >= $6::date
            AND (t.title IS DISTINCT FROM $1
                 OR (NOT t.description_edited AND t.description IS DISTINCT FROM $2)
                 OR t.category_id IS DISTINCT FROM $3)
            AND NOT EXISTS (SELECT 1 FROM task_statuses st WHERE st.task_id = t.id)
        `,
        [baslik, aciklama, categoryId, studentId, sourceKey, today]
      );
      updated += guncelleme.rowCount || 0;
    }

    const gecerli = satirlar.map((satir) => lessonSourceKey(satir.tarih, satir.period));
    const silme = await client.query(
      `
        DELETE FROM tasks t
        WHERE t.student_id = $1
          AND t.source_key LIKE $2
          AND NOT (t.source_key = ANY($3::text[]))
          AND t.single_date >= $4::date
          AND NOT EXISTS (SELECT 1 FROM task_statuses st WHERE st.task_id = t.id)
      `,
      [studentId, `${LESSON_PREFIX}:%`, gecerli, today]
    );

    await client.query('COMMIT');
    return {
      inserted,
      updated,
      removed: silme.rowCount || 0,
      skipped: satirlar.length - inserted,
      categories: createdCategories,
      lessons: satirlar.length
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Konusu yazilmis ders gorevlerini otomatik "yapildi" isaretler.
 *
 * Otomatik kilitten ONCE calismali (bkz. runSealSafely): kilit once calissa
 * aksam yazilan bir konunun gorevi "yapilmadi" muhurlenmis olurdu.
 * Idempotenttir; zaten isaretli gorev ON CONFLICT ile atlanir.
 */
async function completeLessonTasks() {
  const today = todayDateString();

  // Isaretlenmemis VE otomatik "yapilmadi" muhurlenmis ders gorevleri.
  // Ikincisi de taranir: gecmis bir dersin konusu sonradan yazilabilir
  // (bkz. asagidaki upsert).
  const gorevler = await query(
    `
      SELECT t.id, t.student_id AS "studentId", t.source_key AS "sourceKey",
             t.single_date AS "singleDate"
      FROM tasks t
      LEFT JOIN task_statuses st ON st.task_id = t.id
      WHERE t.source_key LIKE $1
        AND (st.id IS NULL OR (st.status = 'not_done' AND st.corrected_by IS NULL))
    `,
    [`${LESSON_PREFIX}:%`]
  );
  if (gorevler.rowCount === 0) return { completed: 0 };

  // Konular hafta hafta okunur; ayni hafta birden fazla gorevde gectigi icin
  // tek sorguya indirgenir.
  const konuOnbellek = new Map();
  const haftaKonulari = async (weekStart) => {
    if (!konuOnbellek.has(weekStart)) konuOnbellek.set(weekStart, await getLessonTopics(weekStart));
    return konuOnbellek.get(weekStart);
  };

  let completed = 0;
  for (const gorev of gorevler.rows) {
    const parcalar = String(gorev.sourceKey).split(':');
    const tarih = parcalar[1];
    const saat = Number(parcalar[2]);
    if (!isDateOnly(tarih) || !Number.isInteger(saat)) continue;

    const konular = await haftaKonulari(startOfWeek(tarih));
    const kayit = konular.get(`${schedule.dayOfWeek(tarih)}:${saat}`);
    if (!kayit || !normalizeText(kayit.topic)) continue;

    // Konu yazmak, MUHURLEYICININ yazdigi "yapilmadi"yi da duzeltir.
    //
    // Gerekce: defterin dogru kaydi `lesson_topics`tir ve oraya yalnizca admin
    // (ya da ogretmen isaretli hesap) yazabilir — yani bu, Durum Duzelt ile
    // ayni yetkidir. Aksi halde gecmis derslerin gorevi aksam muhurlenir ve
    // ertesi gun konuyu yazan ogretmen gorevi bir turlu "yapildi" yapamazdi.
    //
    // ADMININ ELLE yazdigi karar (corrected_by dolu) ezilmez; yalnizca
    // otomatik muhurun uzerine yazilir ve izi birakilir.
    const yazma = await query(
      `
        INSERT INTO task_statuses (id, task_id, student_id, day, status, note)
        VALUES ($1,$2,$3,$4,'done','İşlenen konu yazıldığı için otomatik işaretlendi.')
        ON CONFLICT (task_id, student_id, day) DO UPDATE
        SET status = 'done',
            note = EXCLUDED.note,
            previous_status = task_statuses.status,
            corrected_at = NOW(),
            updated_at = NOW()
        WHERE task_statuses.status = 'not_done'
          AND task_statuses.corrected_by IS NULL
      `,
      [makeId('status'), gorev.id, gorev.studentId, toDateOnly(gorev.singleDate)]
    );
    completed += yazma.rowCount || 0;
  }

  return { completed, today };
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

  const [ayar, kayitlarHam, ozelSaatler] = await Promise.all([
    getScheduleSettings(),
    getScheduleEntries(hafta),
    getPeriodTimes(hafta)
  ]);
  // Hafta sonu ders programindan cikarildi (bkz. schedule.GUNLER): DB'de kalan
  // Cmt/Paz kayitlari izgarada, sayaclarda ve defterde gorunmesin diye elenir
  // (silinmez).
  const kayitlar = kayitlarHam.filter((k) => schedule.GUNLER.includes(Number(k.dayOfWeek)));
  const haftaBilgi = await getWeekScheduleInfo(hafta);
  // Gorunum artik ayri bir parametre degil, SECILI BOLUMDEN turer: defter
  // alanlari (konular/gorevler/defter/excel) konular gorunumunu kullanir.
  // `gorunum` parametresi geriye donuk kabul edilir (eski baglantilar).
  const gorunum = scheduleGorunum(req);

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
    izgara: schedule.buildGrid(kayitlar, ayar, ozelSaatler),
    // Cizelge panosunun sutun basliklari: tek kaynak GUNLER (Pzt-Cum). Sablona
    // gomulu 1-7 yerine bu listeden gelir ki hafta sonu cikinca sutunlar da
    // kendiliginden azalsin.
    gunler: schedule.GUNLER.map((gun) => ({ dayOfWeek: gun, gunAdi: schedule.GUN_ADLARI[gun] })),
    bitisSaati: schedule.endOfDay(ayar),
    ozelSaatVar: ozelSaatler.size > 0,
    toplamDers: kayitlar.filter((k) => k.kind === 'lesson').length,
    varMi: kayitlar.length > 0,
    gunSayilari: schedule.GUNLER.map((gun) => ({
      dayOfWeek: gun,
      gunAdi: schedule.GUN_ADLARI[gun],
      dersSayisi: kayitlar.filter((k) => k.dayOfWeek === gun && k.kind === 'lesson').length,
      bosSaat: ayar.periodCount - kayitlar.filter((k) => k.dayOfWeek === gun).length,
      aralik: schedule.dayRange(ayar, gun, ozelSaatler)
    })),
    topicWeek: gorunum === 'konular' ? await buildTopicWeekView(req, ayar, ozelSaatler) : null
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
  // Cizelge HAFTAYA OZEL: varsayilan sablon KALKTI. `?hafta=` verilmezse
  // ICINDE BULUNULAN HAFTA acilir (admin her hafta o haftayi girer); girilmemis
  // hafta bostur, gelecek onceden belli degil.
  const bugun = todayDateString();
  const haftaParam = normalizeText(req.query.hafta);
  const hafta = isDateOnly(haftaParam) ? startOfWeek(haftaParam) : startOfWeek(bugun);

  const [ayar, kayitlarHam, ozelSaatler] = await Promise.all([
    getScheduleSettings(),
    getScheduleEntries(hafta),
    getPeriodTimes(hafta)
  ]);
  // Hafta sonu ders programindan cikarildi (bkz. schedule.GUNLER): DB'de kalan
  // Cmt/Paz kayitlari izgarada, sayaclarda ve defterde gorunmesin diye elenir
  // (silinmez).
  const kayitlar = kayitlarHam.filter((k) => schedule.GUNLER.includes(Number(k.dayOfWeek)));
  const haftaBilgi = await getWeekScheduleInfo(hafta);
  const saatler = schedule.buildPeriods(ayar);
  const izgara = schedule.buildGrid(kayitlar, ayar, ozelSaatler);
  // Gorunum artik ayri bir parametre degil, SECILI BOLUMDEN turer: defter
  // alanlari (konular/gorevler/defter/excel) konular gorunumunu kullanir.
  // `gorunum` parametresi geriye donuk kabul edilir (eski baglantilar).
  const gorunum = scheduleGorunum(req);
  const topicWeek = gorunum === 'konular' ? await buildTopicWeekView(req, ayar, ozelSaatler) : null;

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
    bosSaat: ayar.periodCount - kayitlar.filter((k) => k.dayOfWeek === gun).length,
    // Gunun gercek penceresi: elle girilen saatler varsayilan duzeni
    // bozabildigi icin en erken baslangic - en gec bitis olarak hesaplanir.
    aralik: schedule.dayRange(ayar, gun, ozelSaatler),
    ozelSayisi: schedule
      .periodsForDay(ayar, gun, ozelSaatler)
      .filter((sa) => sa.ozel).length
  }));

  // ZIL SAATLERI paneli: secili gunun her ders saati icin varsayilan ve
  // (varsa) o HAFTAYA ozel elle girilmis saat. Gun secilmezse ilk ders gunu
  // (Sali) acilir — Pazartesi artik ders gunu degil.
  const saatGunu = schedule.GUNLER.includes(Number(normalizeText(req.query.saatGun)))
    ? Number(normalizeText(req.query.saatGun))
    : schedule.GUNLER[0];
  const saatSatirlari = schedule.periodsForDay(ayar, saatGunu, ozelSaatler).map((sa) => {
    const varsayilanSaat = saatler.find((v) => v.period === sa.period) || sa;
    return {
      period: sa.period,
      start: sa.start,
      end: sa.end,
      ozel: sa.ozel,
      varsayilanStart: varsayilanSaat.start,
      varsayilanEnd: varsayilanSaat.end
    };
  });

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
    // Cizelge panosunun sutun basliklari: tek kaynak GUNLER (Pzt-Cum). Sablona
    // gomulu 1-7 yerine bu listeden gelir ki hafta sonu cikinca sutunlar da
    // kendiliginden azalsin.
    gunler: schedule.GUNLER.map((gun) => ({ dayOfWeek: gun, gunAdi: schedule.GUN_ADLARI[gun] })),
    // Varsayilan sablon kalkti; her zaman somut bir hafta duzenlenir.
    sablonModu: false,
    hafta,
    haftaSonu: shiftDate(hafta, 6),
    oncekiHafta: shiftDate(hafta, -7),
    sonrakiHafta: shiftDate(hafta, 7),
    buHafta: startOfWeek(bugun),
    ozelHafta: haftaBilgi.ozel,
    haftaAkademik: academicCalendar.describeWeek(hafta, shiftDate(hafta, 6)),
    ogrenciler: ogrenciler.rows,
    bitisSaati: schedule.endOfDay(ayar),
    saatGunu,
    saatGunAdi: schedule.GUN_ADLARI[saatGunu],
    saatSatirlari,
    ozelSaatSayisi: ozelSaatler.size,
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
  const nextPath = /^\/admin\/(dashboard|students|users|categories|reports|analysis|wake|sport|prayer|ai|yds|goals|schedule|tasks(?:\/(?:active|status))?)(\?.*)?$/.test(requestedNext)
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
  const nextPath = /^\/student\/(dashboard|questions|calendar|program|wake|schedule|goals|sport|prayer|ai|yds)(\?.*)?$/.test(requestedNext)
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
        -- Ders gorevini tanimak ve yazilan konuyu eslestirmek icin gerekli.
        source_key AS "sourceKey",
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

  const goalsView = currentPage === 'goals' ? await buildMonthlyGoalsView(req, students) : null;

  const taskStatusFixView =
    currentPage === 'tasks-status' ? await buildTaskStatusFixView(req, students, tasks, today) : null;

  const scheduleView = currentPage === 'schedule' ? await buildScheduleView(req) : null;

  // Admin günlük kayıt paneli 14 Eylül'den (SYSTEM_START_DATE) bugüne KADAR tüm
  // günleri göstersin ki admin hepsini düzeltebilsin (rutinler 14 Eylül'den
  // takip edilir). En az 14 gün.
  const routineDetayGun = Math.max(
    14,
    Math.round((Date.parse(today) - Date.parse(SYSTEM_START_DATE)) / 86400000) + 1
  );

  let sportAdmin = null;
  // Planli calisma rutinleri (yapay zeka · YDS) ayni sekli paylastigi icin
  // tek gorunum modeli uretilir; sablon hangi turde oldugunu bilmek zorunda
  // degil.
  let studyAdmin = null;
  const studyKind = STUDY_KINDS[currentPage] || null;
  if (studyKind) {
    const secilenIdRaw = normalizeText(req.query[studyKind.studentIdParam]);
    const secilen = students.find((st) => st.id === secilenIdRaw) || students[0] || null;
    const detay = secilen ? await buildStudyView(studyKind, secilen.id, routineDetayGun) : null;

    const routinesRes = await query(
      `
        SELECT student_id AS "studentId", start_time AS "startTime", minutes,
               is_active AS "isActive"
        FROM ${studyKind.routinesTable}
      `
    );
    const routineByStudent = new Map(
      routinesRes.rows.map((r) => {
        const startTime = normalizeEstimatedTimeForDisplay(r.startTime);
        const minutes = Number(r.minutes) || studyKind.defaultMinutes;
        return [
          r.studentId,
          {
            startTime,
            minutes,
            endTime: studyWindowEnd(startTime, minutes),
            isActive: r.isActive
          }
        ];
      })
    );

    studyAdmin = {
      kind: studyKind.key,
      label: studyKind.label,
      adminPath: studyKind.adminPath,
      studentIdParam: studyKind.studentIdParam,
      defaultStart: studyKind.defaultStart,
      defaultMinutes: studyKind.defaultMinutes,
      selected: secilen,
      detail: detay,
      today,
      systemStartDate: SYSTEM_START_DATE,
      rows: students.map((st) => ({ student: st, routine: routineByStudent.get(st.id) || null }))
    };
  }

  let prayerAdmin = null;
  if (currentPage === 'prayer') {
    const secilenIdRaw = normalizeText(req.query.prayerStudentId);
    const secilen = students.find((st) => st.id === secilenIdRaw) || students[0] || null;
    const detay = secilen ? await buildPrayerView(secilen.id, routineDetayGun) : null;

    // Tum ogrencilerin rutinlerini tek sorguda cek (liste tablosu icin).
    const routinesRes = await query(
      `SELECT student_id AS "studentId", is_active AS "isActive" FROM prayer_routines`
    );
    const routineByStudent = new Map(
      routinesRes.rows.map((r) => [r.studentId, { isActive: r.isActive }])
    );

    prayerAdmin = {
      selected: secilen,
      detail: detay,
      today,
      systemStartDate: SYSTEM_START_DATE,
      prayers: PRAYERS,
      rows: students.map((st) => ({
        student: st,
        routine: routineByStudent.get(st.id) || null
      }))
    };
  }

  if (currentPage === 'sport') {
    const secilenIdRaw = normalizeText(req.query.sportStudentId);
    const secilen = students.find((s) => s.id === secilenIdRaw) || students[0] || null;
    const detay = secilen ? await buildSportView(secilen.id, routineDetayGun) : null;
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
    const detay = secilen ? await buildWakeView(secilen.id, routineDetayGun) : null;

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

  // Gorev olusturma/duzenleme formu kaldirildi; listede yalnizca ogrenci
  // suzgeci kaldi.
  const activeTaskStudentIdRaw = normalizeText(req.query.activeTaskStudentId);
  const activeTaskStudentId = students.some((s) => s.id === activeTaskStudentIdRaw) ? activeTaskStudentIdRaw : '';

  // Ders gorevlerinde listede YAZILAN KONU gorunsun (ogrenci panelindeki ile
  // ayni duzen). Konular tek sorguda haritaya alinir: tablo ogretim yilinin
  // tamamini gosterdigi icin gorev basina sorgu atilamaz.
  const tumKonularRes = await query(
    `
      SELECT week_start AS "weekStart", day_of_week AS "dayOfWeek", period, topic
      FROM lesson_topics
      WHERE topic <> ''
    `
  );
  const konuHaritasi = new Map(
    tumKonularRes.rows.map((r) => [`${toDateOnly(r.weekStart)}:${r.dayOfWeek}:${r.period}`, r.topic])
  );
  const dersGorevAyrinti = (task) => {
    if (!isLessonTask(task.sourceKey) || !task.singleDate) return {};
    const saat = Number(String(task.sourceKey).split(':')[2]);
    const anahtar = `${startOfWeek(task.singleDate)}:${schedule.dayOfWeek(task.singleDate)}:${saat}`;
    return {
      lessonTopic: konuHaritasi.get(anahtar) || '',
      // Eski gorevlerde aciklamanin sonunda kalip metin kalmis olabilir.
      lessonMeta: String(task.description || '').replace(/\s*·\s*işlenen konuyu yaz$/, '')
    };
  };

  const sortedAllTasks = [...tasks]
    .sort(compareTasksBySchedule)
    .map((task) => ({ ...task, ...dersGorevAyrinti(task) }));
  // Gorev listesinde YALNIZCA okul gunleri (Sal/Per/Cum — schedule.GUNLER) ve
  // YALNIZCA BUGUNE KADAR (ileri tarihler gizli — cizelge hafta hafta kurulur)
  // gorunur. Tarihi olmayan (tekrarli) gorevler elenmez. Not: gizlenen ileri
  // ders gorevleri DB'de durur; hepsini "Tum Ders Gorevlerini Sil" temizler.
  const okulGunu = (t) =>
    !t.singleDate ||
    (schedule.GUNLER.includes(schedule.dayOfWeek(t.singleDate)) && t.singleDate <= today);
  const taskTableTasks = (activeTaskStudentId
    ? sortedAllTasks.filter((t) => t.studentId === activeTaskStudentId)
    : sortedAllTasks
  ).filter(okulGunu);
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

  // Her sayfa TEK ALAN gosterir; sayfanin diger alanlari menude o satirin
  // altinda acilir. Gecersiz/eksik `bolum` ilk alana duser, boylece bolumsuz
  // eski baglantilar kirilmaz.
  const currentSection = menu.resolveSection(
    menu.ADMIN_MENU,
    currentPage,
    normalizeText(req.query.bolum)
  );

  return {
    user: req.currentUser,
    currentPage,
    currentSection,
    menuTree: menu.buildMenuTree(menu.ADMIN_MENU, currentPage, currentSection),
    currentSectionLabel: menu.sectionLabel(menu.ADMIN_MENU, currentPage, currentSection),
    menuIcons,
    users,
    adminCount: users.filter((u) => u.role === 'admin').length,
    students,
    categories,
    tasks,
    activeTasks,
    archivedTasks,
    taskTableTasks,
    taskStatusFixView,
    activeTaskFilters: {
      studentId: activeTaskStudentId
    },
    weeklyAnalysis,
    // Sablon analiz sutunlarini tur basina dongude basar.
    studyKinds: Object.values(STUDY_KINDS).map((k) => ({
      key: k.key,
      label: k.label,
      icon: k.key === 'ai' ? 'ai' : 'yds'
    })),
    goalsView,
    scheduleView,
    wakeAdmin,
    sportAdmin,
    prayerAdmin,
    studyAdmin,
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
    // Gorev OLUSTURMA/GUNCELLEME sayfalari kaldirildi: gorevler artik yalnizca
    // ders defterinden (haftalik) uretiliyor, elle gorev acilmiyor.
    const allowedSections = new Set(['active', 'status']);
    const section = allowedSections.has(req.params.section) ? req.params.section : 'active';
    const pageMap = {
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
    const allowedPages = new Set(['dashboard', 'students', 'users', 'categories', 'reports', 'analysis', 'wake', 'schedule', 'goals', 'sport', 'prayer', 'ai', 'yds']);
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

  const [ayar, tumSaatler] = await Promise.all([getScheduleSettings(), getAllPeriodTimes()]);
  // Zil saati gune VE haftaya bagli: her haftanin kendi elle saatleri olabilir,
  // o yuzden hafta basina bir gun->saat haritasi tutulur (talep uzerine).
  const gunSaatleriByWeek = new Map();
  const gunSaatleriIcin = (haftaBasi) => {
    if (!gunSaatleriByWeek.has(haftaBasi)) {
      const ozelSaatler = tumSaatler.get(haftaBasi) || null;
      gunSaatleriByWeek.set(
        haftaBasi,
        new Map(
          schedule.GUNLER.map((gun) => [
            gun,
            new Map(schedule.periodsForDay(ayar, gun, ozelSaatler).map((sa) => [sa.period, sa]))
          ])
        )
      );
    }
    return gunSaatleriByWeek.get(haftaBasi);
  };

  const satirlar = res_.rows
    .map((row) => {
      const haftaBasi = toDateOnly(row.weekStart);
      const tarih = shiftDate(haftaBasi, Number(row.dayOfWeek) - 1);
      const gunSaatleri = gunSaatleriIcin(haftaBasi);
      const saat =
        (gunSaatleri.get(Number(row.dayOfWeek)) || new Map()).get(Number(row.period)) || null;
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

    const sonuc = await importLessonTasks(studentId, req.currentUser.id);

    // Konusu ZATEN yazilmis dersler aktarimdan hemen sonra isaretlensin;
    // yoksa yeni acilan gorevler muhurleyici turuna kadar (5 dk) "bekliyor"
    // gorunuyordu.
    let isaretlenen = 0;
    try {
      ({ completed: isaretlenen } = await completeLessonTasks());
    } catch (err) {
      console.error('Aktarım sonrası ders görevi tamamlama hatası:', err);
    }

    const notlar = [];
    if (isaretlenen) notlar.push(`${isaretlenen} görev, konusu yazılı olduğu için "Yapıldı" işaretlendi.`);
    if (sonuc.categories) notlar.push(`"${LESSON_CATEGORY}" kategorisi oluşturuldu.`);
    if (sonuc.updated) notlar.push(`${sonuc.updated} görev güncellendi.`);
    if (sonuc.removed) notlar.push(`${sonuc.removed} bayat görev kaldırıldı.`);

    if (sonuc.inserted === 0 && !notlar.length) {
      return adminRedirect(req, res, {
        message: `${studentRes.rows[0].name} için yeni ders yok; ${sonuc.skipped} ders görevi zaten var.`
      });
    }
    return adminRedirect(req, res, {
      message: `${sonuc.inserted} ders görevi eklendi (${sonuc.lessons} ders saati).${notlar.length ? ' ' + notlar.join(' ') : ''}`
    });
  })
);

// TUM ders gorevlerini sil: tarih/ogrenci ayrimi yapmadan butun `ders:%`
// gorevlerini (ve durumlarini CASCADE ile) temizler. Kullanici cizelgeyi
// hafta hafta kurup "Ders Gorevlerini Olustur" ile yeniden uretecek.
app.post(
  '/admin/schedule/tasks/delete-all',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const deleted = await query(`DELETE FROM tasks WHERE source_key LIKE $1`, [
      `${LESSON_PREFIX}:%`
    ]);
    return adminRedirect(req, res, {
      message: `${deleted.rowCount} ders görevi silindi. Çizelgeyi kurup "Ders Görevlerini Oluştur" ile yeniden oluşturabilirsiniz.`
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

/**
 * Konular kaydedildikten sonra defter gorevini HEMEN denetler.
 *
 * `completeLessonTasks` zaten muhurleyici turunda (acilista + 5 dakikada
 * bir) calisiyordu; ama kullanici konulari doldurup "Gorevlerim"e bakinca
 * gorev hala isaretsiz gorunuyordu ve ozellik calismiyor sanildi. Kayit aninda
 * da calistirmak beklemeyi kaldiriyor. Idempotenttir: tamamlanmamis hafta
 * varsa hicbir sey yazmaz.
 */
async function saveLessonTopicsAndComplete(body) {
  const sonuc = await saveLessonTopics(body);
  if (!sonuc.ok) return sonuc;

  try {
    const { completed } = await completeLessonTasks();
    if (completed > 0) {
      return {
        ...sonuc,
        message: `${sonuc.message} ${completed} ders görevi "Yapıldı" işaretlendi.`
      };
    }
  } catch (err) {
    // Kayit basarili; isaretleme denetimi patlarsa kullaniciya hata
    // gostermeyiz - muhurleyici 5 dakika icinde ayni isi yapar.
    console.error('Defter görevi tamamlama denetimi hatası:', err);
  }
  return sonuc;
}

app.post(
  '/admin/schedule/topics',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const sonuc = await saveLessonTopicsAndComplete(req.body || {});
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
    const sonuc = await saveLessonTopicsAndComplete(req.body || {});
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
    // Gune ozel zil saatleri de ayni kapsama tabidir.
    await query(`DELETE FROM period_times WHERE period > $1`, [periodCount]);

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
 * GUNE OZEL ZIL SAATLERI — bir gunun ders saatlerini elle yaz.
 *
 * Varsayilan duzen (baslangic + sureler) yerinde kalir; burada girilen saat
 * yalnizca O GUNUN o dersini degistirir ve sonraki saatleri KAYDIRMAZ.
 *
 * Bos birakilan satir "varsayilana don" demektir ve kaydi SILER. Varsayilanla
 * birebir ayni saat de saklanmaz: saklansaydi sonradan sureler degistiginde
 * o hucre eski saatte donar ve kimse neden oldugunu bilemezdi.
 */
app.post(
  '/admin/schedule/period-times',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const gun = Number(normalizeText(req.body.gun));
    if (!schedule.GUNLER.includes(gun)) {
      return adminRedirect(req, res, { error: 'Gün seçilmedi.' });
    }
    // Zil saatleri HAFTAYA OZEL: hangi haftaya yazildigi form ile gelir.
    const hafta = hedefHafta(req.body);

    const ayar = await getScheduleSettings();
    const varsayilan = new Map(schedule.buildPeriods(ayar).map((sa) => [sa.period, sa]));

    // "Bu günü varsayilana dondur": o HAFTANIN o gunundeki tum istisnalari siler.
    if (normalizeText(req.body.islem) === 'sifirla') {
      const silinen = await query(
        `DELETE FROM period_times WHERE week_start = $1 AND day_of_week = $2`,
        [hafta, gun]
      );
      if (silinen.rowCount === 0) {
        return adminRedirect(req, res, {
          error: `${schedule.GUN_ADLARI[gun]} (${hafta} haftası) zaten hesaplanan zil çizelgesini kullanıyor.`
        });
      }
      return adminRedirect(req, res, {
        message: `${schedule.GUN_ADLARI[gun]} (${hafta} haftası): ${silinen.rowCount} elle girilmiş saat kaldırıldı, gün hesaplanan çizelgeye döndü.`
      });
    }

    const yazilacak = [];
    const silinecek = [];
    for (const [period, sa] of varsayilan) {
      const basHam = normalizeText(req.body[`bas${period}`]);
      const bitHam = normalizeText(req.body[`bit${period}`]);

      if (basHam === '' && bitHam === '') {
        silinecek.push(period);
        continue;
      }
      // Tek alanin doldurulmasi sessizce yok sayilmaz: girilen saatin
      // kaydedilmedigini fark etmemek en kotu sonuc olurdu.
      if (basHam === '' || bitHam === '') {
        return adminRedirect(req, res, {
          error: `${period}. ders: başlangıç ve bitiş saatinin ikisi de girilmeli (ikisini de boş bırakırsan varsayılana döner).`
        });
      }

      const bas = normalizeEstimatedTimeForStorage(basHam);
      const bit = normalizeEstimatedTimeForStorage(bitHam);
      if (!bas.ok || !bas.value || !bit.ok || !bit.value) {
        return adminRedirect(req, res, { error: `${period}. ders: saat geçersiz (ör. 08:00).` });
      }
      if (schedule.hmToMinutes(bit.value) <= schedule.hmToMinutes(bas.value)) {
        return adminRedirect(req, res, {
          error: `${period}. ders: bitiş saati başlangıçtan sonra olmalı.`
        });
      }

      if (bas.value === sa.start && bit.value === sa.end) {
        silinecek.push(period);
        continue;
      }
      yazilacak.push({ period, start: bas.value, end: bit.value });
    }

    const client = await pool.connect();
    let eklenen = 0;
    try {
      await client.query('BEGIN');
      if (silinecek.length) {
        await client.query(
          `DELETE FROM period_times WHERE week_start = $1 AND day_of_week = $2 AND period = ANY($3::int[])`,
          [hafta, gun, silinecek]
        );
      }
      for (const satir of yazilacak) {
        await client.query(
          `
            INSERT INTO period_times (week_start, day_of_week, period, start_time, end_time, updated_at)
            VALUES ($1,$2,$3,$4,$5,NOW())
            ON CONFLICT (week_start, day_of_week, period) DO UPDATE SET
              start_time = EXCLUDED.start_time,
              end_time = EXCLUDED.end_time,
              updated_at = NOW()
          `,
          [hafta, gun, satir.period, satir.start, satir.end]
        );
        eklenen += 1;
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    const aralik = schedule.dayRange(ayar, gun, await getPeriodTimes(hafta));
    const varsayilanNotu = eklenen === 0 ? ' Gün tamamen hesaplanan çizelgede.' : '';
    return adminRedirect(req, res, {
      message: `${schedule.GUN_ADLARI[gun]} (${hafta} haftası) zil saatleri kaydedildi: ${eklenen} saat elle girildi.${varsayilanNotu} Gün ${aralik ? `${aralik.start} - ${aralik.end}` : '-'} arası.`
    });
  })
);

/**
 * Yazma rotalarinin hedef haftasi. Varsayilan sablon KALKTI: `hafta` verilmezse
 * ICINDE BULUNULAN HAFTA hedeflenir (admin her hafta o haftayi girer).
 */
function hedefHafta(body) {
  const ham = normalizeText(body && body.hafta);
  return isDateOnly(ham) ? startOfWeek(ham) : startOfWeek(todayDateString());
}

function haftaEtiketi(weekStart) {
  return `${weekStart} haftası`;
}

/**
 * Bir haftayi "girildi" olarak isaretler (schedule_week_overrides). Varsayilan
 * sablon kalktigi icin KOPYALANACAK bir sey yok — isaret yalnizca "bu hafta
 * bilerek bos" (ders yok) ile "hic girilmedi" ayrimini korur (ogrenci sayfasi
 * bu ayrimla dogru mesaji gosterir). Her zaman 0 kopya doner.
 */
async function ensureWeekCustomized(client, hafta) {
  await client.query(
    `INSERT INTO schedule_week_overrides (week_start) VALUES ($1) ON CONFLICT DO NOTHING`,
    [hafta]
  );
  return 0;
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
      // Bosaltmadan once isaret konur: isaret "bu hafta bilerek bos (ders yok)"
      // ile "hic girilmedi" ayrimini korur; ogrenci sayfasi buna gore mesaj verir.
      await ensureWeekCustomized(client, hafta);
      const silme = await client.query(`DELETE FROM class_schedule WHERE week_start = $1`, [hafta]);
      silindi = silme.rowCount || 0;
      // Haftaya ozel zil saatleri de temizlenir: ders yoksa saatin anlami kalmaz.
      await client.query(`DELETE FROM period_times WHERE week_start = $1`, [hafta]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    return adminRedirect(req, res, {
      message: `${silindi} ders kaydı silindi; ${haftaEtiketi(hafta)} boşaltıldı. Bu hafta artık "ders yok" sayılır: haftalık takvimde ders görünmez, defter görevi de açılmaz.`
    });
  })
);

// Toplu sil (cizelge): izgarada isaretlenen ders kayitlarini tek seferde siler.
// Tek kayit silmeyle ayni (DELETE by id), yalnizca coklu.
app.post(
  '/admin/schedule/entries/bulk-delete',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    let ids = req.body.entryIds;
    if (!Array.isArray(ids)) ids = ids ? [ids] : [];
    ids = ids.map((x) => normalizeText(x)).filter(Boolean);
    if (!ids.length) {
      return adminRedirect(req, res, { error: 'Silinecek ders kaydı seçilmedi.' });
    }
    const silindi = await query(`DELETE FROM class_schedule WHERE id = ANY($1)`, [ids]);
    return adminRedirect(req, res, { message: `${silindi.rowCount} ders kaydı silindi.` });
  })
);

// Toplu sil (islenen konular): bir TARIH ARALIGINDAKI islenen konu kayitlarini
// siler. lesson_topics (week_start, day_of_week) -> gercek tarih
// week_start + (day_of_week - 1); aralik o tarihe gore.
app.post(
  '/admin/schedule/topics/bulk-delete',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const from = normalizeText(req.body.from);
    const to = normalizeText(req.body.to);
    if (!isDateOnly(from) || !isDateOnly(to)) {
      return adminRedirect(req, res, { error: 'Geçerli bir tarih aralığı girin.' });
    }
    if (from > to) {
      return adminRedirect(req, res, { error: 'Başlangıç tarihi bitişten sonra olamaz.' });
    }
    const silindi = await query(
      `DELETE FROM lesson_topics
       WHERE (week_start + (day_of_week - 1)) BETWEEN $1::date AND $2::date`,
      [from, to]
    );
    return adminRedirect(req, res, {
      message: `${from} – ${to} aralığında ${silindi.rowCount} işlenen konu kaydı silindi.`
    });
  })
);

// (Varsayilan sablon kaldirildigi icin "haftayi ozellestir" ve "varsayilana
// dondur" rotalari da kalkti: her hafta zaten bagimsizdir, sablona donus yoktur.
// Bir haftayi bosaltmak icin /admin/schedule/clear kullanilir.)

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

/* --------------------------------------------------------------------------
   Namaz rutini rotalari
   -------------------------------------------------------------------------- */

// Rutinin tek ayari var: acik/kapali. Hedef saat YOK — vakit saatleri gune ve
// konuma gore kayar, uygulama onlari bilmiyor ve uydurmamali.
app.post(
  '/admin/prayer',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const studentId = normalizeText(req.body.studentId);
    const isActive = normalizeText(req.body.isActive) !== 'off';

    const studentRes = await query(`SELECT id, name FROM users WHERE id = $1 AND role = 'student'`, [
      studentId
    ]);
    if (studentRes.rowCount === 0) {
      return adminRedirect(req, res, { error: 'Öğrenci bulunamadı.' });
    }

    await query(
      `
        INSERT INTO prayer_routines (student_id, is_active)
        VALUES ($1,$2)
        ON CONFLICT (student_id) DO UPDATE
        SET is_active = EXCLUDED.is_active, updated_at = NOW()
      `,
      [studentId, isActive]
    );

    return adminRedirect(req, res, {
      message: `${studentRes.rows[0].name} için namaz rutini ${isActive ? 'açıldı' : 'pasife alındı'}.`
    });
  })
);

// Uyanma/spordaki kararin aynisi: rutin kaldirilinca prayer_logs SILINMEZ.
app.post(
  '/admin/prayer/delete',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const studentId = normalizeText(req.body.studentId);
    const sonuc = await query(`DELETE FROM prayer_routines WHERE student_id = $1`, [studentId]);
    if (sonuc.rowCount === 0) {
      return adminRedirect(req, res, { error: 'Bu öğrencide namaz rutini yok.' });
    }
    return adminRedirect(req, res, {
      message: 'Namaz rutini kaldırıldı. Geçmiş kayıtlar duruyor.'
    });
  })
);

/**
 * Ogrenci bir vakti isaretler.
 *
 * Uc durum da ogrencinin BEYANIDIR; uygulama saatten hesaplamaz. Tek
 * hesapladigi sey basilan saattir ve o yalnizca bilgi olarak saklanir.
 *
 * Gun kurali:
 * - BUGUN: uc secenek de acik (vaktinde / kilinmadi / kaza).
 * - GECMIS: yalnizca KAZA. Kazanin tanimi bu; gecmise "vaktinde kildim"
 *   yazmak ise kaydin degerini bitirirdi.
 * - GELECEK: hicbiri.
 */
app.post(
  '/student/prayer',
  requireRole('student'),
  asyncHandler(async (req, res) => {
    const routine = await getPrayerRoutine(req.currentUser.id);
    if (!routine || !routine.isActive) {
      return studentRedirect(req, res, { error: 'Namaz rutini tanımlı değil.' });
    }

    const vakit = normalizeText(req.body.vakit);
    const durum = normalizeText(req.body.durum);
    const today = dateStringInTimeZone(process.env.APP_TIMEZONE || 'Europe/Istanbul');
    const gunGirdi = normalizeText(req.body.gun);
    const gun = isDateOnly(gunGirdi) ? gunGirdi : today;

    if (!PRAYER_KEYS.has(vakit)) {
      return studentRedirect(req, res, { error: 'Vakit seçilmedi.' });
    }
    if (!['on_time', 'missed', 'qada'].includes(durum)) {
      return studentRedirect(req, res, { error: 'Geçersiz durum.' });
    }
    if (gun > today) {
      return studentRedirect(req, res, { error: 'Gelecek bir güne kayıt yazılamaz.' });
    }
    // Taban tarihten oncesi acilistaki temizlikte zaten siliniyor.
    if (gun < SYSTEM_START_DATE) {
      return studentRedirect(req, res, { error: `${SYSTEM_START_DATE} öncesine kayıt yazılamaz.` });
    }
    if (gun < today && durum !== 'qada') {
      return studentRedirect(req, res, {
        error: 'Geçmiş bir vakte yalnızca "Kazası kılındı" yazılabilir.'
      });
    }
    // Rutin kurulmadan onceki gunler hic takip edilmedi; muhurleyici de
    // oraya inmiyor. Oraya tek basina bir kaza satiri yazmak, diger dort
    // vaktin hic kaydi olmadigi bir gunde yanilticiydi.
    if (routine.createdDay && gun < routine.createdDay) {
      return studentRedirect(req, res, {
        error: `Namaz rutini ${routine.createdDay} tarihinde açıldı; öncesine kayıt yazılamaz.`
      });
    }

    const nowHm = timeStringInTimeZone();
    const etiket = PRAYER_LABELS.get(vakit);

    const mevcutRes = await query(
      `SELECT status FROM prayer_logs WHERE student_id = $1 AND day = $2 AND prayer = $3`,
      [req.currentUser.id, gun, vakit]
    );
    const mevcut = mevcutRes.rowCount ? mevcutRes.rows[0].status : null;

    if (!canChangePrayerStatus(mevcut, durum)) {
      // "Kilinmadi" KAPANMIS degil: kazasi hala isaretlenebilir. Mesaj bunu
      // ayirt etmeli, yoksa kullanici vakti kapali sanip pes ederdi.
      let neden;
      if (mevcut === durum) {
        neden = `${etiket} zaten "${prayerStatusText(durum)}" olarak kayıtlı.`;
      } else if (mevcut === 'missed') {
        neden = `${etiket} "Kılınmadı" olarak kayıtlı; buradan yalnızca kazası işaretlenebilir.`;
      } else {
        neden = `${etiket} "${prayerStatusText(mevcut)}" olarak kapandı; değiştirilemez.`;
      }
      return studentRedirect(req, res, { error: neden });
    }

    if (mevcut === null) {
      // Yarista ikinci istek DO NOTHING'e duser ve ilk kayit korunur
      // (uyanma/spordaki "ilk basis gecerli" kuralinin karsiligi).
      const insert = await query(
        `
          INSERT INTO prayer_logs (id, student_id, day, prayer, status, marked_at, qada_day, qada_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
          ON CONFLICT (student_id, day, prayer) DO NOTHING
        `,
        [
          makeId('pray'),
          req.currentUser.id,
          gun,
          vakit,
          durum,
          durum === 'qada' ? null : nowHm,
          durum === 'qada' ? today : null,
          durum === 'qada' ? nowHm : null
        ]
      );
      if (insert.rowCount === 0) {
        return studentRedirect(req, res, { error: `${etiket} için kayıt zaten girilmiş.` });
      }
    } else {
      // Tek izinli gecis: kilinmadi -> kazasi kilindi. WHERE kosulu yarista
      // da kurali korur.
      const guncelle = await query(
        `
          UPDATE prayer_logs
          SET status = 'qada', qada_day = $4, qada_at = $5,
              corrected_by = NULL, corrected_at = NULL,
              previous_status = NULL, correction_note = ''
          WHERE student_id = $1 AND day = $2 AND prayer = $3 AND status = 'missed'
        `,
        [req.currentUser.id, gun, vakit, today, nowHm]
      );
      if (guncelle.rowCount === 0) {
        return studentRedirect(req, res, { error: `${etiket} kaydı değişmedi.` });
      }
    }

    const gunNotu = gun === today ? '' : ` (${gun})`;
    return studentRedirect(req, res, {
      message: `${etiket}${gunNotu}: ${prayerStatusText(durum)}.`
    });
  })
);

/**
 * Elle kayit (admin) — namaz rutininin tek geri donusu.
 *
 * Gorevlerdeki "Durum Duzelt" ve rutinlerdeki elle kaydin karsiligi: ogrenci
 * tarafi kapali (yanlis basilan dugme geri alinamaz), admin duzeltir ve her
 * duzeltme satirin icine yazilir.
 */
app.post(
  '/admin/prayer/log',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const studentId = normalizeText(req.body.studentId);
    const day = normalizeText(req.body.day);
    const vakit = normalizeText(req.body.vakit);
    const durum = normalizeText(req.body.durum);

    if (!isDateOnly(day)) {
      return adminRedirect(req, res, { error: 'Geçersiz gün.' });
    }
    if (!PRAYER_KEYS.has(vakit)) {
      return adminRedirect(req, res, { error: 'Geçersiz vakit.' });
    }
    if (!['on_time', 'missed', 'qada', 'clear'].includes(durum)) {
      return adminRedirect(req, res, { error: 'Geçersiz işlem.' });
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

    const today = dateStringInTimeZone(process.env.APP_TIMEZONE || 'Europe/Istanbul');
    if (day > today) {
      return adminRedirect(req, res, { error: 'Gelecek bir güne kayıt yazılamaz.' });
    }
    if (day < SYSTEM_START_DATE) {
      return adminRedirect(req, res, {
        error: `${SYSTEM_START_DATE} öncesine yazılamaz (açılışta silinir).`
      });
    }

    const routine = await getPrayerRoutine(studentId);
    if (!routine) {
      return adminRedirect(req, res, { error: 'Bu öğrencide namaz rutini tanımlı değil.' });
    }

    const mevcutRes = await query(
      `SELECT status FROM prayer_logs WHERE student_id = $1 AND day = $2 AND prayer = $3`,
      [studentId, day, vakit]
    );
    const mevcut = mevcutRes.rowCount ? mevcutRes.rows[0].status : null;
    const etiket = PRAYER_LABELS.get(vakit);
    const ad = studentRes.rows[0].name;

    if (durum === 'clear') {
      if (mevcut === null) {
        return adminRedirect(req, res, { error: `${etiket} için silinecek kayıt yok.` });
      }
      // Muhurleyici penceresindeki gecmis bir gunu SILMEK kalici degildir:
      // 5 dakika icinde yeniden "kilinmadi" yazilir. "Temizlendi" demek
      // yalan olurdu (rutinlerdeki wouldRoutineSealerRewrite ile ayni karar).
      if (wouldPrayerSealerRewrite(routine, day, today)) {
        return adminRedirect(req, res, {
          error: 'Bu gün otomatik mühürleme penceresinde; silmek kalıcı olmaz. Bunun yerine bir durum yazın.'
        });
      }
      await query(
        `DELETE FROM prayer_logs WHERE student_id = $1 AND day = $2 AND prayer = $3`,
        [studentId, day, vakit]
      );
      return adminRedirect(req, res, { message: `${ad} · ${day} ${etiket} kaydı silindi.` });
    }

    if (mevcut === durum) {
      return adminRedirect(req, res, {
        error: `${etiket} zaten "${prayerStatusText(durum)}" durumunda.`
      });
    }

    await query(
      `
        INSERT INTO prayer_logs (
          id, student_id, day, prayer, status, qada_day,
          corrected_by, corrected_at, previous_status, correction_note
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,NOW(),NULL,$8)
        ON CONFLICT (student_id, day, prayer) DO UPDATE
        SET status = EXCLUDED.status,
            qada_day = EXCLUDED.qada_day,
            corrected_by = EXCLUDED.corrected_by,
            corrected_at = NOW(),
            previous_status = prayer_logs.status,
            correction_note = EXCLUDED.correction_note
      `,
      [
        makeId('pray'),
        studentId,
        day,
        vakit,
        durum,
        durum === 'qada' ? today : null,
        req.currentUser.id,
        notDogrulama.value || ''
      ]
    );

    const oncekiNotu = mevcut ? ` (${prayerStatusText(mevcut)} → ${prayerStatusText(durum)})` : '';
    return adminRedirect(req, res, {
      message: `${ad} · ${day} ${etiket}: ${prayerStatusText(durum)}${oncekiNotu}.`
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
/* --------------------------------------------------------------------------
   Gunluk 5 vakit namaz rutini

   Uyanma/spor rutinlerinin ucuncusu DEGIL, baska bir seklidir:

   - Gunde TEK degil BES kayit var; her vakit ayri degerlendirilir.
   - Durum saatten HESAPLANMAZ. Vakit saatleri gune ve konuma gore kayar;
     uygulama onlari bilmiyor ve uydurmamali. Durumu kullanici beyan eder,
     uygulama yalnizca basilan saati bilgi olarak saklar.
   - Ucuncu bir durum var: KAZA. "Kilinmadi" kalici bir son degil.

   Bu yuzden ROUTINE_KINDS soyutlamasina sokulmadi: o soyutlama "gun basina
   tek satir + saat sutunu + ayardan hesaplanan durum" varsayiyor.
   -------------------------------------------------------------------------- */

const PRAYER_LOOKBACK_DAYS = 30;

// Sira EKRANDAKI siradir; gun icindeki gercek sira.
const PRAYERS = [
  { key: 'sabah', label: 'Sabah' },
  { key: 'ogle', label: 'Öğle' },
  { key: 'ikindi', label: 'İkindi' },
  { key: 'aksam', label: 'Akşam' },
  { key: 'yatsi', label: 'Yatsı' }
];
const PRAYER_KEYS = new Set(PRAYERS.map((v) => v.key));
const PRAYER_LABELS = new Map(PRAYERS.map((v) => [v.key, v.label]));

const PRAYER_STATUS_TEXT = {
  on_time: 'Vaktinde kılındı',
  qada: 'Kazası kılındı',
  missed: 'Kılınmadı',
  pending: 'Bekliyor'
};

function prayerStatusText(status) {
  return PRAYER_STATUS_TEXT[status] || '-';
}

/* --------------------------------------------------------------------------
   UC DURUMLU BEYAN RUTINLERININ ORTAK CEKIRDEGI

   Namaz ve yapay zeka rutinleri ayni sekli paylasir:

   - durum saatten HESAPLANMAZ, kullanici BEYAN eder;
   - uc durum vardir: yapildi / yapilmadi / sonradan telafi edildi
     (namazda: vaktinde kilindi / kilinmadi / kazasi kilindi);
   - "yapilmadi" kapanmis bir son DEGILDIR: tek bir ileri gecise izin verilir.

   Uyanma/spordaki "ilk basis kalicidir" kurali bu sekilde tek bir gecisle
   esnetilir. Yasaklar ve sebepleri:

   - `yapilmadi -> yapildi`: gecmise donuk "aslinda yapmistim" beyani. Kaydin
     degeri durustlugunden geliyor; duzeltmesi adminde.
   - `yapildi -> *` ve `telafi -> *`: is bitti, kayit kapandi.

   Ortak olan YALNIZCA bu kural ve kelime dagarcigidir. Tablolar ve gorunum
   kurucular ayri durur: namaz gunde BES kayit tutar, yapay zeka BIR; namazin
   ayari yok, yapay zekanin gunluk penceresi var. Ikisini tek bir motora
   sokmak o farklari bayrak enflasyonuna cevirirdi.
   -------------------------------------------------------------------------- */

/**
 * @param {string|null} mevcut  kayitli durum (yoksa null)
 * @param {string} yeni         yazilmak istenen durum
 * @param {{yapilmadi: string, telafi: string}} sozluk  o rutinin anahtarlari
 */
function canAdvanceDeclaredStatus(mevcut, yeni, sozluk) {
  if (!mevcut) return true;
  return mevcut === sozluk.yapilmadi && yeni === sozluk.telafi;
}

/** Namazin sozlugu: "kilinmadi" -> "kazasi kilindi". */
const PRAYER_VOCAB = { yapilmadi: 'missed', telafi: 'qada' };

function canChangePrayerStatus(mevcut, yeni) {
  return canAdvanceDeclaredStatus(mevcut, yeni, PRAYER_VOCAB);
}

async function getPrayerRoutine(studentId) {
  const res = await query(
    `
      SELECT student_id AS "studentId", is_active AS "isActive", created_at AS "createdAt"
      FROM prayer_routines
      WHERE student_id = $1
    `,
    [studentId]
  );
  if (res.rowCount === 0) return null;
  const row = res.rows[0];
  return {
    studentId: row.studentId,
    isActive: row.isActive,
    // Muhurleyici rutin kurulmadan onceki gunlere inmez.
    // Rutinler okul yılı başından (SYSTEM_START_DATE = 14 Eylül) itibaren
    // takip edilir; gerçek oluşturma günü tabanı DARALTMAZ (kullanıcı tüm
    // rutinleri 14 Eylül'den başlattı). created_at yalnızca kayıt için durur.
    createdDay: SYSTEM_START_DATE
  };
}

/**
 * Uyanma/spordaki kuralin aynisi: yalnizca GECMIS gunler muhurlenir.
 * Fark, gun basina BES satir yazilmasi — her vakit ayri bir kayittir.
 *
 * Muhurlenen kayit "kilinmadi"dir ve KAPANMIS degildir: sonradan kazasi
 * isaretlenebilir (canChangePrayerStatus).
 */
async function sealMissedPrayerLogs() {
  const today = dateStringInTimeZone(process.env.APP_TIMEZONE || 'Europe/Istanbul');
  const routines = await query(
    `
      SELECT student_id AS "studentId", created_at AS "createdAt"
      FROM prayer_routines
      WHERE is_active = TRUE
    `
  );

  let sealed = 0;
  for (const routine of routines.rows) {
    // Rutinler 14 Eylül'den (SYSTEM_START_DATE) itibaren mühürlenir; rutinin
    // gerçek oluşturma günü tabanı daraltmaz.
    const basladi = SYSTEM_START_DATE;
    for (let i = 1; i <= PRAYER_LOOKBACK_DAYS; i += 1) {
      const gun = shiftDate(today, -i);
      if (gun < basladi) break;
      for (const vakit of PRAYERS) {
        const res = await query(
          `
            INSERT INTO prayer_logs (id, student_id, day, prayer, status)
            VALUES ($1,$2,$3,$4,'missed')
            ON CONFLICT (student_id, day, prayer) DO NOTHING
          `,
          [makeId('pray'), routine.studentId, gun, vakit.key]
        );
        sealed += res.rowCount || 0;
      }
    }
  }
  return { sealed };
}

/**
 * Bu gunun kaydini SILMEK kalici mi? (rutinlerdeki
 * wouldRoutineSealerRewrite ile ayni karar, namaz penceresine uyarlanmis.)
 */
function wouldPrayerSealerRewrite(routine, day, today) {
  if (!routine || !routine.isActive) return false;
  if (day >= today) return false; // muhurleyici bugune dokunmaz
  const basladi = [routine.createdDay || SYSTEM_START_DATE, SYSTEM_START_DATE].sort().pop();
  const pencereBasi = [shiftDate(today, -PRAYER_LOOKBACK_DAYS), basladi].sort().pop();
  return day >= pencereBasi;
}

function mapPrayerLog(row) {
  return {
    day: toDateOnly(row.day),
    prayer: row.prayer,
    prayerLabel: PRAYER_LABELS.get(row.prayer) || row.prayer,
    status: row.status,
    statusText: prayerStatusText(row.status),
    markedAt: normalizeEstimatedTimeForDisplay(row.markedAt),
    qadaDay: toDateOnly(row.qadaDay),
    qadaAt: normalizeEstimatedTimeForDisplay(row.qadaAt),
    note: row.note || '',
    correctedAt: row.correctedAt || null,
    correctedByName: row.correctedByName || null,
    previousStatus: row.previousStatus || null,
    previousStatusText: row.previousStatus ? prayerStatusText(row.previousStatus) : null,
    correctionNote: row.correctionNote || ''
  };
}

/**
 * Namaz gorunumu: bugunun bes vakti + son N gunun gun gun ozeti.
 *
 * Gecmis gunler salt okunur DEGILDIR: kilinmamis bir vaktin kazasi her zaman
 * isaretlenebilir. Satirlar bu yuzden `kazaYazilabilir` bayragini tasir.
 */
async function buildPrayerView(studentId, gunSayisi = 14) {
  const routine = await getPrayerRoutine(studentId);
  const today = dateStringInTimeZone(process.env.APP_TIMEZONE || 'Europe/Istanbul');
  const nowHm = timeStringInTimeZone();

  if (!routine) {
    return { routine: null, today, nowHm, bugun: [], rows: [], summary: null, streak: 0 };
  }

  const res = await query(
    `
      SELECT pl.day, pl.prayer, pl.status, pl.marked_at AS "markedAt",
             pl.qada_day AS "qadaDay", pl.qada_at AS "qadaAt", pl.note,
             pl.corrected_at AS "correctedAt", pl.previous_status AS "previousStatus",
             pl.correction_note AS "correctionNote", u.name AS "correctedByName"
      FROM prayer_logs pl
      LEFT JOIN users u ON u.id = pl.corrected_by
      WHERE pl.student_id = $1 AND pl.day >= $2
      ORDER BY pl.day DESC
    `,
    [studentId, shiftDate(today, -(gunSayisi - 1))]
  );

  const logs = res.rows.map(mapPrayerLog);
  const logByKey = new Map(logs.map((l) => [`${l.day}:${l.prayer}`, l]));

  const vakitSatiri = (gun, vakit) =>
    logByKey.get(`${gun}:${vakit.key}`) || {
      day: gun,
      prayer: vakit.key,
      prayerLabel: vakit.label,
      status: 'pending',
      statusText: prayerStatusText('pending'),
      markedAt: null,
      qadaDay: null,
      qadaAt: null,
      note: ''
    };

  // Bugunun bes vakti: isaretsizler "bekliyor", her biri kendi dugmelerini
  // tasir.
  const bugun = PRAYERS.map((vakit) => {
    const satir = vakitSatiri(today, vakit);
    // Kayit yoksa "mevcut durum" YOK demektir (satirdaki 'pending' yalnizca
    // ekran etiketi); uc secenek de acik olmali.
    const mevcut = logByKey.has(`${today}:${vakit.key}`) ? satir.status : null;
    return {
      ...satir,
      vaktindeYazilabilir: canChangePrayerStatus(mevcut, 'on_time'),
      kilinmadiYazilabilir: canChangePrayerStatus(mevcut, 'missed'),
      kazaYazilabilir: canChangePrayerStatus(mevcut, 'qada')
    };
  });

  // Liste RUTININ KURULDUGU gunde biter (ve taban tarihte). Oncesi hic takip
  // edilmedi: muhurleyici oraya inmiyor, yazma da reddediliyor; "Bekliyor"
  // gostermek olmayan bir borcu varmis gibi okunurdu.
  const listeTabani = [routine.createdDay || SYSTEM_START_DATE, SYSTEM_START_DATE].sort().pop();
  const rows = [];
  for (let i = 0; i < gunSayisi; i += 1) {
    const gun = shiftDate(today, -i);
    if (gun < listeTabani) break;
    const vakitler = PRAYERS.map((vakit) => {
      const satir = vakitSatiri(gun, vakit);
      return {
        ...satir,
        // GECMIS gunde tek acik islem kazadir; bugun uc secenek de acik.
        kazaYazilabilir: satir.status === 'missed',
        vaktindeYazilabilir: gun === today && satir.status === 'pending',
        kilinmadiYazilabilir: gun === today && satir.status === 'pending'
      };
    });
    rows.push({
      day: gun,
      gunAdi: getDayName(gun),
      bugunMu: gun === today,
      vakitler,
      onTime: vakitler.filter((v) => v.status === 'on_time').length,
      qada: vakitler.filter((v) => v.status === 'qada').length,
      missed: vakitler.filter((v) => v.status === 'missed').length,
      pending: vakitler.filter((v) => v.status === 'pending').length
    });
  }

  // Seri: bes vaktin de VAKTINDE kilindigi kesintisiz gun sayisi. Kaza
  // seriyi kurtarmaz — kurtarsaydi "vaktinde" olcusu anlamini yitirirdi.
  const tamGun = (gun) =>
    PRAYERS.every((v) => (logByKey.get(`${gun}:${v.key}`) || {}).status === 'on_time');
  let streak = 0;
  const baslangic = tamGun(today) ? 0 : 1;
  for (let i = baslangic; i < PRAYER_LOOKBACK_DAYS; i += 1) {
    if (!tamGun(shiftDate(today, -i))) break;
    streak += 1;
  }

  const degerlendirilen = logs.filter((l) => l.status !== 'pending');
  const onTime = degerlendirilen.filter((l) => l.status === 'on_time').length;
  const qada = degerlendirilen.filter((l) => l.status === 'qada').length;
  const missed = degerlendirilen.filter((l) => l.status === 'missed').length;
  const toplam = degerlendirilen.length;

  return {
    routine,
    today,
    nowHm,
    bugun,
    rows,
    streak,
    summary: {
      gunSayisi: rows.length,
      toplam,
      onTime,
      qada,
      missed,
      // Veri yokken oran null doner ve ekranda "-" gosterilir; %0 ile
      // karistirilmamali (uygulama genelindeki kural).
      onTimeRate: toplam ? Math.round((onTime / toplam) * 100) : null,
      kilinanRate: toplam ? Math.round(((onTime + qada) / toplam) * 100) : null
    }
  };
}

/* --------------------------------------------------------------------------
   PLANLI GUNLUK CALISMA RUTINLERI (yapay zeka · YDS)

   Namaz rutiniyle ayni UC DURUMLU BEYAN seklini paylasirlar (bkz.
   canAdvanceDeclaredStatus); farklari gunde BIR kayit tutmalari ve bir
   PLANLARININ olmasi: gunluk pencere + dakika.

   Yapay zeka ve YDS BIREBIR ayni sekildir — farklari yalnizca tablo adlari,
   etiketler ve varsayilan saat. Ucuncu bir kopya yazmak yerine motor burada
   `kind` ile parametrelendi (CLAUDE.md: "ayni seklin ucuncusu gelirse once
   soyutlama"). Namaz bu motora girmez: gunde bes kayit tutar ve plani yoktur.

   Plan degerlendirmeyi BELIRLEMEZ — saat gecti diye "yapilmadi" yazilmaz,
   cunku ucuncu durum (telafi) tam da bunun icin var.
   -------------------------------------------------------------------------- */

const STUDY_LOOKBACK_DAYS = 30;
const STUDY_VOCAB = { yapilmadi: 'not_done', telafi: 'makeup' };

const STUDY_STATUS_TEXT = {
  done: 'Yapıldı',
  makeup: 'Telafi edildi',
  not_done: 'Yapılmadı',
  pending: 'Bekliyor'
};

function studyStatusText(status) {
  return STUDY_STATUS_TEXT[status] || '-';
}

function canChangeStudyStatus(mevcut, yeni) {
  return canAdvanceDeclaredStatus(mevcut, yeni, STUDY_VOCAB);
}

/**
 * Rutin turleri. `routinesTable` / `logsTable` SQL'e dogrudan gomulur —
 * parametre olamazlar (tablo adi $1 ile verilemez). Guvenli, cunku degerler
 * YALNIZCA bu sabit haritadan gelir; istekten gelen `tur` once bu haritada
 * aranir, bulunamazsa 404'e duser.
 */
const STUDY_KINDS = {
  ai: {
    key: 'ai',
    label: 'Yapay Zeka',
    isim: 'Yapay zeka çalışması',
    routinesTable: 'ai_routines',
    logsTable: 'ai_logs',
    idPrefix: 'ai',
    defaultStart: '06:30',
    defaultMinutes: 60,
    studentPath: '/student/ai',
    adminPath: '/admin/ai',
    studentIdParam: 'aiStudentId'
  },
  yds: {
    key: 'yds',
    label: 'YDS',
    isim: 'YDS çalışması',
    routinesTable: 'yds_routines',
    logsTable: 'yds_logs',
    idPrefix: 'yds',
    // Aksam penceresi: sabahki yapay zeka saatiyle carpismasin.
    defaultStart: '20:00',
    defaultMinutes: 60,
    studentPath: '/student/yds',
    adminPath: '/admin/yds',
    studentIdParam: 'ydsStudentId'
  }
};

/** Planin bitis saati: baslangic + dakika (saklanmaz, hesaplanir). */
function studyWindowEnd(startTime, minutes) {
  const bas = hmToMinutes(startTime);
  if (bas === null) return null;
  return minutesToHm(bas + (Number(minutes) || 0));
}

async function getStudyRoutine(kind, studentId) {
  const res = await query(
    `
      SELECT student_id AS "studentId", start_time AS "startTime", minutes,
             is_active AS "isActive", created_at AS "createdAt"
      FROM ${kind.routinesTable}
      WHERE student_id = $1
    `,
    [studentId]
  );
  if (res.rowCount === 0) return null;
  const row = res.rows[0];
  const startTime = normalizeEstimatedTimeForDisplay(row.startTime);
  const minutes = Number(row.minutes) || kind.defaultMinutes;
  return {
    kind: kind.key,
    studentId: row.studentId,
    startTime,
    minutes,
    endTime: studyWindowEnd(startTime, minutes),
    isActive: row.isActive,
    // Rutinler okul yılı başından (SYSTEM_START_DATE = 14 Eylül) itibaren
    // takip edilir; gerçek oluşturma günü tabanı DARALTMAZ (kullanıcı tüm
    // rutinleri 14 Eylül'den başlattı). created_at yalnızca kayıt için durur.
    createdDay: SYSTEM_START_DATE
  };
}

/**
 * Yalnizca GECMIS gunler muhurlenir — bugun gun boyu acik kalir.
 *
 * Planli saat gecti diye gun icinde muhurlemek yanlis olurdu: saat 22:00'de
 * yapilan calisma da o gunun calismasidir. Gunun kapanmasi yeter.
 */
async function sealMissedStudyLogs(kind) {
  const today = dateStringInTimeZone(process.env.APP_TIMEZONE || 'Europe/Istanbul');
  const routines = await query(
    `
      SELECT student_id AS "studentId", start_time AS "startTime", minutes,
             created_at AS "createdAt"
      FROM ${kind.routinesTable}
      WHERE is_active = TRUE
    `
  );

  let sealed = 0;
  for (const routine of routines.rows) {
    // Rutinler 14 Eylül'den (SYSTEM_START_DATE) itibaren mühürlenir; rutinin
    // gerçek oluşturma günü tabanı daraltmaz.
    const basladi = SYSTEM_START_DATE;
    for (let i = 1; i <= STUDY_LOOKBACK_DAYS; i += 1) {
      const gun = shiftDate(today, -i);
      if (gun < basladi) break;
      const res = await query(
        `
          INSERT INTO ${kind.logsTable} (id, student_id, day, status, start_time, minutes)
          VALUES ($1,$2,$3,'not_done',$4,$5)
          ON CONFLICT (student_id, day) DO NOTHING
        `,
        [
          makeId(kind.idPrefix),
          routine.studentId,
          gun,
          normalizeEstimatedTimeForDisplay(routine.startTime),
          Number(routine.minutes) || kind.defaultMinutes
        ]
      );
      sealed += res.rowCount || 0;
    }
  }
  return { sealed };
}

/**
 * Bir gunun SAYILAN dakikasi: gercek girildiyse o, girilmediyse plan.
 *
 * "Yapildi" isaretlenmis ama dakika girilmemis bir gunu 0 saymak yanlis
 * olurdu (is yapildi); plan degerini "gercek" diye sunmak da yanlis olurdu.
 * Bu yuzden rapor plana DUSER ve kac gunde gercek girdi oldugunu ayrica
 * soyler — sayinin nereden geldigi gorunur kalsin diye.
 */
function studyEffectiveMinutes(log) {
  if (!log) return 0;
  if (log.status !== 'done' && log.status !== 'makeup') return 0;
  return log.actualMinutes === null ? log.minutes : log.actualMinutes;
}

function mapStudyLog(row) {
  const startTime = normalizeEstimatedTimeForDisplay(row.startTime);
  const minutes = Number(row.minutes) || 0;
  const actualMinutes =
    row.actualMinutes === null || row.actualMinutes === undefined
      ? null
      : Number(row.actualMinutes);
  return {
    day: toDateOnly(row.day),
    status: row.status,
    statusText: studyStatusText(row.status),
    startTime,
    minutes,
    actualMinutes,
    endTime: studyWindowEnd(startTime, minutes),
    doneAt: normalizeEstimatedTimeForDisplay(row.doneAt),
    makeupDay: toDateOnly(row.makeupDay),
    makeupAt: normalizeEstimatedTimeForDisplay(row.makeupAt),
    note: row.note || '',
    correctedAt: row.correctedAt || null,
    correctedByName: row.correctedByName || null,
    previousStatus: row.previousStatus || null,
    previousStatusText: row.previousStatus ? studyStatusText(row.previousStatus) : null,
    correctionNote: row.correctionNote || ''
  };
}

/** Namaz gorunumuyle ayni desen: bugunun karti + son N gunun listesi. */
async function buildStudyView(kind, studentId, gunSayisi = 14) {
  const routine = await getStudyRoutine(kind, studentId);
  const today = dateStringInTimeZone(process.env.APP_TIMEZONE || 'Europe/Istanbul');
  const nowHm = timeStringInTimeZone();

  if (!routine) {
    return {
      kind: kind.key,
      label: kind.label,
      studentPath: kind.studentPath,
      adminPath: kind.adminPath,
      routine: null,
      today,
      nowHm,
      todayLog: null,
      bugun: null,
      rows: [],
      summary: null,
      streak: 0
    };
  }

  const res = await query(
    `
      SELECT l.day, l.status, l.start_time AS "startTime", l.minutes,
             l.actual_minutes AS "actualMinutes",
             l.done_at AS "doneAt", l.makeup_day AS "makeupDay",
             l.makeup_at AS "makeupAt", l.note,
             l.corrected_at AS "correctedAt", l.previous_status AS "previousStatus",
             l.correction_note AS "correctionNote", u.name AS "correctedByName"
      FROM ${kind.logsTable} l
      LEFT JOIN users u ON u.id = l.corrected_by
      WHERE l.student_id = $1 AND l.day >= $2
      ORDER BY l.day DESC
    `,
    [studentId, shiftDate(today, -(gunSayisi - 1))]
  );

  const logs = res.rows.map(mapStudyLog);
  const logByDay = new Map(logs.map((l) => [l.day, l]));
  const todayLog = logByDay.get(today) || null;

  const bosSatir = (gun) => ({
    day: gun,
    status: 'pending',
    statusText: studyStatusText('pending'),
    startTime: routine.startTime,
    minutes: routine.minutes,
    actualMinutes: null,
    endTime: routine.endTime,
    doneAt: null,
    makeupDay: null,
    makeupAt: null,
    note: ''
  });

  const bugunSatir = todayLog || bosSatir(today);
  const bugun = {
    ...bugunSatir,
    yapildiYazilabilir: canChangeStudyStatus(todayLog ? todayLog.status : null, 'done'),
    yapilmadiYazilabilir: canChangeStudyStatus(todayLog ? todayLog.status : null, 'not_done'),
    telafiYazilabilir: canChangeStudyStatus(todayLog ? todayLog.status : null, 'makeup'),
    dakikaYazilabilir: bugunSatir.status === 'done' || bugunSatir.status === 'makeup'
  };

  // Liste rutinin kuruldugu gunde biter: oncesi hic takip edilmedi.
  const listeTabani = [routine.createdDay || SYSTEM_START_DATE, SYSTEM_START_DATE].sort().pop();
  const rows = [];
  for (let i = 0; i < gunSayisi; i += 1) {
    const gun = shiftDate(today, -i);
    if (gun < listeTabani) break;
    const satir = logByDay.get(gun) || bosSatir(gun);
    rows.push({
      ...satir,
      gunAdi: getDayName(gun),
      bugunMu: gun === today,
      // GECMIS gunde tek acik islem telafidir; bugun uc secenek de acik.
      telafiYazilabilir: satir.status === 'not_done',
      yapildiYazilabilir: gun === today && satir.status === 'pending',
      yapilmadiYazilabilir: gun === today && satir.status === 'pending',
      // Dakika DURUM gibi kilitlenmez: uyanma/spor notundaki kararin aynisi
      // — is sabah isaretlenir, suresi cogu zaman sonra yazilir. Yapilmamis
      // bir gunde yazilacak dakika yoktur.
      dakikaYazilabilir: satir.status === 'done' || satir.status === 'makeup'
    });
  }

  // Seri: kesintisiz "yapildi" gun sayisi. Telafi seriyi kurtarmaz —
  // kurtarsaydi "o gun yapildi" olcusu anlamini yitirirdi.
  let streak = 0;
  const baslangic = todayLog && todayLog.status === 'done' ? 0 : 1;
  for (let i = baslangic; i < STUDY_LOOKBACK_DAYS; i += 1) {
    const log = logByDay.get(shiftDate(today, -i));
    if (!log || log.status !== 'done') break;
    streak += 1;
  }

  const done = logs.filter((l) => l.status === 'done').length;
  const makeup = logs.filter((l) => l.status === 'makeup').length;
  const notDone = logs.filter((l) => l.status === 'not_done').length;
  const toplam = logs.length;

  return {
    kind: kind.key,
    label: kind.label,
    studentPath: kind.studentPath,
    adminPath: kind.adminPath,
    routine,
    today,
    nowHm,
    todayLog,
    bugun,
    rows,
    streak,
    summary: {
      gunSayisi: rows.length,
      toplam,
      done,
      makeup,
      notDone,
      planlananDakika: routine.minutes * rows.length,
      // Gercek girildiyse o, girilmediyse plan (bkz. studyEffectiveMinutes).
      yapilanDakika: logs.reduce((t, l) => t + studyEffectiveMinutes(l), 0),
      // Sayinin ne kadarinin olculdugu gorunur kalsin.
      gercekGirilenGun: logs.filter((l) => l.actualMinutes !== null).length,
      gercekDakika: logs.reduce((t, l) => t + (l.actualMinutes || 0), 0),
      // Veri yokken null doner ve ekranda "-" gosterilir.
      doneRate: toplam ? Math.round((done / toplam) * 100) : null,
      withMakeupRate: toplam ? Math.round(((done + makeup) / toplam) * 100) : null
    }
  };
}

/**
 * Gercek calisilan dakika girdisi. Bos birakmak GECERLIDIR ve "girilmedi"
 * demektir (NULL) — sifir degil.
 */
function parseActualMinutes(deger) {
  const ham = normalizeText(deger);
  if (ham === '') return { ok: true, value: null };
  const n = Number(ham);
  if (!Number.isInteger(n) || n < 1 || n > 1440) {
    return { ok: false, error: 'Çalışılan süre 1 ile 1440 dakika arasında olmalı.' };
  }
  return { ok: true, value: n };
}

/** Rutinlerdeki wouldRoutineSealerRewrite ile ayni karar. */
function wouldStudySealerRewrite(routine, day, today) {
  if (!routine || !routine.isActive) return false;
  if (day >= today) return false;
  const basladi = [routine.createdDay || SYSTEM_START_DATE, SYSTEM_START_DATE].sort().pop();
  const pencereBasi = [shiftDate(today, -STUDY_LOOKBACK_DAYS), basladi].sort().pop();
  return day >= pencereBasi;
}

/* --------------------------------------------------------------------------
   Planli gunluk calisma rutini rotalari (yapay zeka · YDS)

   Iki tur BIREBIR ayni davranir; rotalar bu yuzden tur uzerinde bir dongude
   kurulur. Yollar sabit (`/admin/ai`, `/admin/yds` …) — tur adi istekten
   GELMEZ, dongude baglanir; boylece tablo adlarinin SQL'e gomulmesi guvenli
   kalir.
   -------------------------------------------------------------------------- */

for (const kind of Object.values(STUDY_KINDS)) {
  // Plan: gunluk baslangic saati + dakika. Bitis saati saklanmaz,
  // hesaplanir — "kacta biter" sorusunun tek dogru cevabi olsun diye.
  app.post(
    kind.adminPath,
    requireRole('admin'),
    asyncHandler(async (req, res) => {
      const studentId = normalizeText(req.body.studentId);
      const isActive = normalizeText(req.body.isActive) !== 'off';

      const studentRes = await query(
        `SELECT id, name FROM users WHERE id = $1 AND role = 'student'`,
        [studentId]
      );
      if (studentRes.rowCount === 0) {
        return adminRedirect(req, res, { error: 'Öğrenci bulunamadı.' });
      }

      const start = normalizeEstimatedTimeForStorage(normalizeText(req.body.startTime));
      if (!start.ok || !start.value) {
        return adminRedirect(req, res, {
          error: `Başlangıç saati geçersiz (ör. ${kind.defaultStart}).`
        });
      }

      const dakika = Number(normalizeText(req.body.minutes));
      if (!Number.isInteger(dakika) || dakika < 15 || dakika > 600) {
        return adminRedirect(req, res, { error: 'Günlük süre 15 ile 600 dakika arasında olmalı.' });
      }

      await query(
        `
          INSERT INTO ${kind.routinesTable} (student_id, start_time, minutes, is_active)
          VALUES ($1,$2,$3,$4)
          ON CONFLICT (student_id) DO UPDATE
          SET start_time = EXCLUDED.start_time,
              minutes = EXCLUDED.minutes,
              is_active = EXCLUDED.is_active,
              updated_at = NOW()
        `,
        [studentId, start.value, dakika, isActive]
      );

      const bitis = studyWindowEnd(start.value, dakika);
      return adminRedirect(req, res, {
        message: `${studentRes.rows[0].name} için ${kind.label} rutini ${start.value} - ${bitis} (${dakika} dk)${isActive ? '' : ' (pasif)'} olarak kaydedildi.`
      });
    })
  );

  // Uyanma/spor/namazdaki kararin aynisi: rutin kaldirilinca kayitlar SILINMEZ.
  app.post(
    `${kind.adminPath}/delete`,
    requireRole('admin'),
    asyncHandler(async (req, res) => {
      const studentId = normalizeText(req.body.studentId);
      const sonuc = await query(`DELETE FROM ${kind.routinesTable} WHERE student_id = $1`, [
        studentId
      ]);
      if (sonuc.rowCount === 0) {
        return adminRedirect(req, res, { error: `Bu öğrencide ${kind.label} rutini yok.` });
      }
      return adminRedirect(req, res, {
        message: `${kind.label} rutini kaldırıldı. Geçmiş kayıtlar duruyor.`
      });
    })
  );

  /**
   * Ogrenci gunu isaretler. Namaz rotasiyla AYNI gun kurallari:
   * - BUGUN: uc secenek de acik.
   * - GECMIS: yalnizca TELAFI (telafinin tanimi bu).
   * - GELECEK ve rutin oncesi: hicbiri.
   */
  app.post(
    kind.studentPath,
    requireRole('student'),
    asyncHandler(async (req, res) => {
      const routine = await getStudyRoutine(kind, req.currentUser.id);
      if (!routine || !routine.isActive) {
        return studentRedirect(req, res, { error: `${kind.label} rutini tanımlı değil.` });
      }

      const durum = normalizeText(req.body.durum);
      const today = dateStringInTimeZone(process.env.APP_TIMEZONE || 'Europe/Istanbul');
      const gunGirdi = normalizeText(req.body.gun);
      const gun = isDateOnly(gunGirdi) ? gunGirdi : today;

      if (!['done', 'not_done', 'makeup'].includes(durum)) {
        return studentRedirect(req, res, { error: 'Geçersiz durum.' });
      }
      if (gun > today) {
        return studentRedirect(req, res, { error: 'Gelecek bir güne kayıt yazılamaz.' });
      }
      if (gun < SYSTEM_START_DATE) {
        return studentRedirect(req, res, {
          error: `${SYSTEM_START_DATE} öncesine kayıt yazılamaz.`
        });
      }
      if (gun < today && durum !== 'makeup') {
        return studentRedirect(req, res, {
          error: 'Geçmiş bir güne yalnızca "Telafi edildi" yazılabilir.'
        });
      }
      if (routine.createdDay && gun < routine.createdDay) {
        return studentRedirect(req, res, {
          error: `${kind.label} rutini ${routine.createdDay} tarihinde açıldı; öncesine kayıt yazılamaz.`
        });
      }

      // Isaretlerken dakika girmek OPSIYONEL; bos birakilirsa NULL kalir ve
      // raporlar o gun icin plana duser.
      const dakika = parseActualMinutes(req.body.dakika);
      if (!dakika.ok) {
        return studentRedirect(req, res, { error: dakika.error });
      }
      if (dakika.value !== null && durum === 'not_done') {
        return studentRedirect(req, res, {
          error: 'Yapılmamış bir güne çalışma süresi yazılamaz.'
        });
      }

      const nowHm = timeStringInTimeZone();
      const mevcutRes = await query(
        `SELECT status FROM ${kind.logsTable} WHERE student_id = $1 AND day = $2`,
        [req.currentUser.id, gun]
      );
      const mevcut = mevcutRes.rowCount ? mevcutRes.rows[0].status : null;

      if (!canChangeStudyStatus(mevcut, durum)) {
        // "Yapilmadi" KAPANMIS degil: telafisi hala isaretlenebilir. Mesaj
        // bunu ayirt etmeli, yoksa kullanici gunu kapali sanip pes ederdi.
        // Gun bugun degilse tarihi yazilir; "Bugun zaten..." yanlis gunu
        // isaret ederdi.
        const gunAdi = gun === today ? 'Bugün' : gun;
        let neden;
        if (mevcut === durum) {
          neden = `${gunAdi} zaten "${studyStatusText(durum)}" olarak kayıtlı.`;
        } else if (mevcut === 'not_done') {
          neden = `${gunAdi} "Yapılmadı" olarak kayıtlı; buradan yalnızca telafisi işaretlenebilir.`;
        } else {
          neden = `${gunAdi} kaydı "${studyStatusText(mevcut)}" olarak kapandı; değiştirilemez.`;
        }
        return studentRedirect(req, res, { error: neden });
      }

      if (mevcut === null) {
        const insert = await query(
          `
            INSERT INTO ${kind.logsTable} (
              id, student_id, day, status, start_time, minutes, actual_minutes,
              done_at, makeup_day, makeup_at
            )
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
            ON CONFLICT (student_id, day) DO NOTHING
          `,
          [
            makeId(kind.idPrefix),
            req.currentUser.id,
            gun,
            durum,
            routine.startTime,
            routine.minutes,
            dakika.value,
            durum === 'makeup' ? null : nowHm,
            durum === 'makeup' ? today : null,
            durum === 'makeup' ? nowHm : null
          ]
        );
        if (insert.rowCount === 0) {
          return studentRedirect(req, res, { error: 'Bu gün için kayıt zaten girilmiş.' });
        }
      } else {
        // Tek izinli gecis: yapilmadi -> telafi edildi. Duzeltme izi
        // temizlenir: o iz "satir SU ANKI durumunu nasil aldi"yi anlatir ve
        // yalnizca admin yazar; birakilsaydi ekranda "Telafi edildi ->
        // Telafi edildi" gibi kendisiyle celisen bir satir cikardi.
        const guncelle = await query(
          `
            UPDATE ${kind.logsTable}
            SET status = 'makeup', makeup_day = $3, makeup_at = $4,
                actual_minutes = COALESCE($5, actual_minutes),
                corrected_by = NULL, corrected_at = NULL,
                previous_status = NULL, correction_note = ''
            WHERE student_id = $1 AND day = $2 AND status = 'not_done'
          `,
          [req.currentUser.id, gun, today, nowHm, dakika.value]
        );
        if (guncelle.rowCount === 0) {
          return studentRedirect(req, res, { error: 'Kayıt değişmedi.' });
        }
      }

      const gunNotu = gun === today ? '' : ` (${gun})`;
      const sureNotu = dakika.value === null ? '' : ` · ${dakika.value} dk`;
      return studentRedirect(req, res, {
        message: `${kind.isim}${gunNotu}: ${studyStatusText(durum)}${sureNotu}.`
      });
    })
  );

  /**
   * Gercek calisilan dakikayi sonradan yaz / degistir / temizle.
   *
   * DURUM kilitlidir ama dakika DEGILDIR — uyanma/spor notundaki kararin
   * aynisi: is sabah isaretlenir, suresi cogu zaman sonra yazilir.
   */
  app.post(
    `${kind.studentPath}/minutes`,
    requireRole('student'),
    asyncHandler(async (req, res) => {
      const routine = await getStudyRoutine(kind, req.currentUser.id);
      if (!routine || !routine.isActive) {
        return studentRedirect(req, res, { error: `${kind.label} rutini tanımlı değil.` });
      }

      const today = dateStringInTimeZone(process.env.APP_TIMEZONE || 'Europe/Istanbul');
      const gunGirdi = normalizeText(req.body.gun);
      const gun = isDateOnly(gunGirdi) ? gunGirdi : today;
      if (gun > today) {
        return studentRedirect(req, res, { error: 'Gelecek bir güne kayıt yazılamaz.' });
      }

      const dakika = parseActualMinutes(req.body.dakika);
      if (!dakika.ok) {
        return studentRedirect(req, res, { error: dakika.error });
      }

      const guncelle = await query(
        `
          UPDATE ${kind.logsTable}
          SET actual_minutes = $3
          WHERE student_id = $1 AND day = $2 AND status IN ('done', 'makeup')
        `,
        [req.currentUser.id, gun, dakika.value]
      );

      if (guncelle.rowCount === 0) {
        return studentRedirect(req, res, {
          error: 'Süre yazmak için gün önce "Yapıldı" ya da "Telafi edildi" işaretlenmeli.'
        });
      }

      return studentRedirect(req, res, {
        message:
          dakika.value === null
            ? `${gun} için çalışma süresi temizlendi; rapor plana düşer.`
            : `${gun} için çalışma süresi ${dakika.value} dk olarak kaydedildi.`
      });
    })
  );

  /** Elle kayit (admin) — bu rutinin tek geri donusu. */
  app.post(
    `${kind.adminPath}/log`,
    requireRole('admin'),
    asyncHandler(async (req, res) => {
      const studentId = normalizeText(req.body.studentId);
      const day = normalizeText(req.body.day);
      const durum = normalizeText(req.body.durum);

      if (!isDateOnly(day)) {
        return adminRedirect(req, res, { error: 'Geçersiz gün.' });
      }
      if (!['done', 'not_done', 'makeup', 'clear'].includes(durum)) {
        return adminRedirect(req, res, { error: 'Geçersiz işlem.' });
      }

      const notDogrulama = validateTaskDescription(req.body.note);
      if (!notDogrulama.ok) {
        return adminRedirect(req, res, { error: notDogrulama.error });
      }

      const dakika = parseActualMinutes(req.body.dakika);
      if (!dakika.ok) {
        return adminRedirect(req, res, { error: dakika.error });
      }
      if (dakika.value !== null && (durum === 'not_done' || durum === 'clear')) {
        return adminRedirect(req, res, {
          error: 'Yapılmamış (ya da silinen) bir güne çalışma süresi yazılamaz.'
        });
      }

      const studentRes = await query(
        `SELECT id, name FROM users WHERE id = $1 AND role = 'student'`,
        [studentId]
      );
      if (studentRes.rowCount === 0) {
        return adminRedirect(req, res, { error: 'Öğrenci bulunamadı.' });
      }

      const today = dateStringInTimeZone(process.env.APP_TIMEZONE || 'Europe/Istanbul');
      if (day > today) {
        return adminRedirect(req, res, { error: 'Gelecek bir güne kayıt yazılamaz.' });
      }
      if (day < SYSTEM_START_DATE) {
        return adminRedirect(req, res, {
          error: `${SYSTEM_START_DATE} öncesine yazılamaz (açılışta silinir).`
        });
      }

      const routine = await getStudyRoutine(kind, studentId);
      if (!routine) {
        return adminRedirect(req, res, {
          error: `Bu öğrencide ${kind.label} rutini tanımlı değil.`
        });
      }

      const mevcutRes = await query(
        `SELECT status FROM ${kind.logsTable} WHERE student_id = $1 AND day = $2`,
        [studentId, day]
      );
      const mevcut = mevcutRes.rowCount ? mevcutRes.rows[0].status : null;
      const ad = studentRes.rows[0].name;

      if (durum === 'clear') {
        if (mevcut === null) {
          return adminRedirect(req, res, { error: 'Silinecek kayıt yok.' });
        }
        if (wouldStudySealerRewrite(routine, day, today)) {
          return adminRedirect(req, res, {
            error:
              'Bu gün otomatik mühürleme penceresinde; silmek kalıcı olmaz. Bunun yerine bir durum yazın.'
          });
        }
        await query(`DELETE FROM ${kind.logsTable} WHERE student_id = $1 AND day = $2`, [
          studentId,
          day
        ]);
        return adminRedirect(req, res, { message: `${ad} · ${day} kaydı silindi.` });
      }

      if (mevcut === durum) {
        // Durum ayni ama dakika yazilmak isteniyorsa bu gecerli bir istektir;
        // yoksa "zaten o durumda" deyip sureyi yutardik.
        if (dakika.value === null) {
          return adminRedirect(req, res, {
            error: `Gün zaten "${studyStatusText(durum)}" durumunda.`
          });
        }
        await query(
          `UPDATE ${kind.logsTable} SET actual_minutes = $3 WHERE student_id = $1 AND day = $2`,
          [studentId, day, dakika.value]
        );
        return adminRedirect(req, res, {
          message: `${ad} · ${day}: çalışma süresi ${dakika.value} dk olarak yazıldı.`
        });
      }

      await query(
        `
          INSERT INTO ${kind.logsTable} (
            id, student_id, day, status, start_time, minutes, actual_minutes, makeup_day,
            corrected_by, corrected_at, previous_status, correction_note
          )
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW(),NULL,$10)
          ON CONFLICT (student_id, day) DO UPDATE
          SET status = EXCLUDED.status,
              makeup_day = EXCLUDED.makeup_day,
              -- Dakika girilmediyse mevcut deger korunur; "yapilmadi"ya
              -- cevrilen gunde ise temizlenir (yazilacak sure kalmadi).
              actual_minutes = CASE
                WHEN EXCLUDED.status = 'not_done' THEN NULL
                ELSE COALESCE(EXCLUDED.actual_minutes, ${kind.logsTable}.actual_minutes)
              END,
              corrected_by = EXCLUDED.corrected_by,
              corrected_at = NOW(),
              previous_status = ${kind.logsTable}.status,
              correction_note = EXCLUDED.correction_note
        `,
        [
          makeId(kind.idPrefix),
          studentId,
          day,
          durum,
          routine.startTime,
          routine.minutes,
          dakika.value,
          durum === 'makeup' ? today : null,
          req.currentUser.id,
          notDogrulama.value || ''
        ]
      );

      const oncekiNotu = mevcut
        ? ` (${studyStatusText(mevcut)} → ${studyStatusText(durum)})`
        : '';
      const sureNotu = dakika.value === null ? '' : ` · ${dakika.value} dk`;
      return adminRedirect(req, res, {
        message: `${ad} · ${day}: ${studyStatusText(durum)}${sureNotu}${oncekiNotu}.`
      });
    })
  );
}


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

// GUNUN TAMAMINI ONAYLA. Tek tek duzeltmenin toplu hali: gecmis bir gunde
// muhurleyici butun gorevleri "Yapilmadi" yazdigi icin, o gun gercekten
// calisilmissa 4-5 gorevi tek tek duzeltmek gerekiyordu.
//
// Tek gorev rotasiyla ayni kurallar gecerli: yalnizca o gun VADESI GELEN
// gorevlere yazilir, taban tarihten oncesine yazilmaz ve her satir kendi
// duzeltme izini tasir. Zaten istenen durumda olan gorevler atlanir.
app.post(
  '/admin/tasks/status-fix-bulk',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const studentId = normalizeText(req.body.studentId);
    const day = normalizeText(req.body.day);
    const action = normalizeText(req.body.action);

    if (action !== 'done' && action !== 'not_done') {
      return adminRedirect(req, res, { error: 'Geçersiz işlem.' });
    }
    if (!isDateOnly(day)) {
      return adminRedirect(req, res, { error: 'Geçersiz gün.' });
    }
    if (day < SYSTEM_START_DATE) {
      return adminRedirect(req, res, {
        error: `Sistem ${SYSTEM_START_DATE} tarihinde başlıyor; daha eski günlere durum yazılamaz.`
      });
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

    const tasksRes = await query(
      `
        SELECT
          id, title, student_id AS "studentId", repeat_type AS "repeatType",
          single_date AS "singleDate", weekly_day AS "weeklyDay",
          monthly_day AS "monthlyDay", custom_dates AS "customDates",
          start_date AS "startDate", end_date AS "endDate",
          estimated_time AS "estimatedTime", is_archived AS "isArchived"
        FROM tasks WHERE student_id = $1
      `,
      [studentId]
    );

    const dayObj = new Date(`${day}T00:00:00`);
    const gununGorevleri = tasksRes.rows
      .map(mapTask)
      .filter((task) => isTaskDueOnDateIgnoringArchive(task, dayObj, day));

    if (!gununGorevleri.length) {
      return adminRedirect(req, res, {
        error: `${studentRes.rows[0].name} için ${day} gününde görev yok.`
      });
    }

    let yazilan = 0;
    let atlanan = 0;
    for (const task of gununGorevleri) {
      const yazma = await query(
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
          WHERE task_statuses.status IS DISTINCT FROM EXCLUDED.status
        `,
        [makeId('status'), task.id, studentId, day, action, req.currentUser.id, notDogrulama.value]
      );
      if (yazma.rowCount > 0) yazilan += 1;
      else atlanan += 1;
    }

    const etiket = action === 'done' ? 'Yapıldı' : 'Yapılmadı';
    const atlamaNotu = atlanan ? ` ${atlanan} görev zaten "${etiket}" durumundaydı.` : '';
    return adminRedirect(req, res, {
      message: `${studentRes.rows[0].name} · ${day}: ${yazilan} görev "${etiket}" olarak işaretlendi.${atlamaNotu}`
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

// Toplu sil: "Tum Gorevler" listesinde secilen gorevleri tek seferde siler.
// Tek gorev silmeyle ayni kural (admin her gorevi silebilir), yalnizca coklu.
app.post(
  '/admin/tasks/bulk-delete',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    let ids = req.body.taskIds;
    if (!Array.isArray(ids)) ids = ids ? [ids] : [];
    ids = ids.map((x) => normalizeText(x)).filter(Boolean);
    if (!ids.length) {
      return adminRedirect(req, res, { error: 'Silinecek görev seçilmedi.' });
    }
    const deleted = await query(`DELETE FROM tasks WHERE id = ANY($1)`, [ids]);
    return adminRedirect(req, res, {
      message: `${deleted.rowCount} görev kalıcı olarak silindi.`
    });
  })
);

/**
 * Bir rutinin (uyanma / spor / yapay zeka / YDS) ICINDE BULUNULAN HAFTANIN her
 * gunu icin "Gorevlerim" tablosuna sahte satirlar uretir. Namaz HARIC — gunde
 * 5 vakit tutar, listeyi bogar (bkz. CLAUDE.md), kendi seridinde kalir.
 *
 * - Rutin kuruldugu gunden (createdDay) once satir yok; sistem taban tarihinden
 *   oncesine de inmez.
 * - Gecmis gunler kendi durumlariyla (kilitli), BUGUN islem yapilabilir,
 *   gelecek gunler "Bekliyor".
 * - Zaman-tabanli rutinler (uyanma/spor) bugun tek dokunusla isaretlenir (satir
 *   ici dugme); planli rutinler (YZ/YDS) uc durumlu oldugu icin satirdan kendi
 *   sayfasina baglanti verilir.
 *
 * `view` = buildWakeView / buildSportView / buildStudyView sonucu (rows: en yeni
 * ustte, son N gun). `haftaGunleri` = Pzt..Paz tarih dizisi.
 */
function buildRoutineWeekRows(config, view, haftaGunleri, today) {
  const { tur, baslik, endpoint, page, tip } = config;
  if (!view || !view.routine || view.routine.isActive === false) return [];
  const routine = view.routine;
  const taban = [routine.createdDay || SYSTEM_START_DATE, SYSTEM_START_DATE].sort().pop();
  const logByDay = new Map((view.rows || []).map((r) => [r.day, r]));

  const saatAna = tip === 'time' && tur === 'wake' ? routine.targetTime : routine.startTime;
  const saatAlt =
    tip === 'time' && tur === 'wake'
      ? routine.toleranceMinutes
        ? `+${routine.toleranceMinutes} dk`
        : ''
      : `→ ${routine.endTime}`;

  const satirlar = [];
  for (const gun of haftaGunleri) {
    if (gun < taban) continue;
    const bugun = gun === today;
    const gecmis = gun < today;
    const r = logByDay.get(gun) || null;
    const durum = r ? r.status : null;

    // Namaz: gunde TEK OZET satir (5 vakit). r = buildPrayerView gun ozeti
    // (onTime/qada/missed/pending). Satir ici isaretlenmez (5 vakit x 3 durum);
    // bugun bekleyen varsa / gecmiste kilinmayan varsa kendi sayfasina baglanir.
    if (tip === 'prayer') {
      const onTime = r ? r.onTime : 0;
      const qada = r ? r.qada : 0;
      const missed = r ? r.missed : 0;
      const pending = r ? r.pending : 5;
      const settled = pending === 0;
      let pHref = null;
      let pLabel = null;
      if (bugun && pending > 0) {
        pHref = page;
        pLabel = 'İşaretle';
      } else if (gecmis && missed > 0) {
        pHref = page;
        pLabel = 'Kaza';
      }
      const parcalar = [`${onTime}/5 vaktinde`];
      if (qada) parcalar.push(`${qada} kaza`);
      if (missed) parcalar.push(`${missed} kılınmadı`);
      if (pending && !gecmis) parcalar.push(`${pending} bekleyen`);
      const ozet = parcalar.join(' · ');
      satirlar.push({
        id: `routine-prayer-${gun}`,
        isRoutine: true,
        routineTur: 'prayer',
        routineEndpoint: null,
        routineMarkInline: false,
        routineActionHref: pHref,
        routineActionLabel: pLabel,
        routinePage: page,
        cellEndpoint: null,
        title: baslik,
        categoryName: 'Rutin',
        scheduleText: bugun ? `${gun} · Bugün` : gun,
        singleDate: gun,
        estimatedTime: '',
        routineSaatAna: '5 vakit',
        routineSaatAlt: '',
        description: '',
        canEditDescription: false,
        canEditTime: false,
        canManage: false,
        // Kilit = gun kapanmis ve yapilacak islem yok (tam gun / kaza gerekmez).
        isMarked: !pHref && settled,
        isLocked: !pHref && settled,
        routineDoneAt: null,
        routineStatus: null,
        routineStatusText: ozet,
        // Durum hucresinde gosterilecek gun ozeti (2/5 vaktinde · 1 kaza · ...).
        routinePrayerSummary: ozet,
        routineDelay: 0,
        // Yalnizca BES vaktin de VAKTINDE kilindigi gun "tamamlandi" sayilir
        // (seri olcusuyle ayni); aksi halde notr (kirmizi yapilmaz).
        displayStatus: onTime === 5 ? { status: 'done', day: gun } : null,
        displayStatusIsToday: bugun,
        displayStatusDay: gun,
        todayStatus: null
      });
      continue;
    }

    // "isaretli" = o gun icin kapanmis/gercek bir durum var mi.
    const isaretli =
      tip === 'time'
        ? durum === 'on_time' || durum === 'late' || durum === 'missed'
        : durum === 'done' || durum === 'not_done' || durum === 'makeup';

    // Sayac ve satir rengi icin done/not_done'a indirger.
    let displayDurum = null;
    if (isaretli) {
      if (tip === 'time') displayDurum = durum === 'missed' ? 'not_done' : 'done';
      else displayDurum = durum === 'done' || durum === 'makeup' ? 'done' : 'not_done';
    }

    // Islem: uyanma/spor bugun satir ici dugme; YZ/YDS bugun (bekliyor) ya da
    // gecmis (yapilmadi -> telafi) kendi sayfasina baglanti.
    const markInline = tip === 'time' && bugun && !isaretli;
    let actionHref = null;
    let actionLabel = null;
    if (tip === 'study') {
      if (bugun && durum !== 'done' && durum !== 'makeup') {
        actionHref = page;
        actionLabel = durum === 'not_done' ? 'Telafi' : 'İşaretle';
      } else if (gecmis && durum === 'not_done') {
        actionHref = page;
        actionLabel = 'Telafi';
      }
    }

    // Kapanmis (kilit rozeti gosterilecek) durum: isaretli ve baska islem yok.
    const kilitli = isaretli && !actionHref;

    satirlar.push({
      id: `routine-${tur}-${gun}`,
      isRoutine: true,
      routineTur: tur,
      routineEndpoint: endpoint || null,
      routineMarkInline: markInline,
      routineActionHref: actionHref,
      routineActionLabel: actionLabel,
      routinePage: page,
      // Not yalnizca uyanma/spor'da ve YALNIZCA bugun (kayit varsa) yazilir.
      cellEndpoint: tip === 'time' && bugun && isaretli ? `/student/routines/${tur}/note` : null,
      title: baslik,
      categoryName: 'Rutin',
      scheduleText: bugun ? `${gun} · Bugün` : gun,
      singleDate: gun,
      estimatedTime: saatAlt ? `${saatAna} ${saatAlt}` : saatAna,
      routineSaatAna: saatAna,
      routineSaatAlt: saatAlt,
      description: r ? r.note || '' : '',
      canEditDescription: tip === 'time' && bugun && isaretli,
      canEditTime: false,
      canManage: false,
      isMarked: kilitli,
      isLocked: kilitli,
      routineDoneAt: r ? (tur === 'wake' ? r.wokeAt : r.doneAt) || (r.makeupAt || null) : null,
      routineStatus: durum,
      routineStatusText: r && r.statusText ? r.statusText : 'Bekliyor',
      routineDelay: r && r.delayMinutes ? r.delayMinutes : 0,
      displayStatus: displayDurum ? { status: displayDurum, day: gun } : null,
      displayStatusIsToday: bugun,
      displayStatusDay: gun,
      todayStatus: bugun && isaretli ? { status: durum } : null
    });
  }
  return satirlar;
}

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

  // Ders gorevi ogretim yilindaki her ders saati icin acilir (yuzlerce);
  // listede yalnizca ICINDE BULUNULAN HAFTA'nin dersleri kalir.
  //
  // Once "yalnizca bugun" idi ve hafta sonu liste bombos kaliyordu: cumartesi
  // acan kullanici gorevleri olusturdugu halde hicbir sey goremedi. Hafta
  // penceresi hem o sorunu cozer hem de "bu hafta hangi dersin konusunu
  // yazmadim" sorusunu yanitlar. Digerleri silinmez: takvimde kendi gununde,
  // haftalik analizde ve raporlarda aynen gorunur.
  const buHaftaBaslangic = startOfWeek(today);
  const buHaftaBitis = shiftDate(buHaftaBaslangic, 6);

  // Bu haftanin yazilmis konulari: gorev satirinda YAZILAN KONU gorunsun.
  // Liste yalnizca "1. ders · Matematik" gosteriyordu; ogretmen konuyu
  // yazdiktan sonra da satirda yazdigi sey gorunmuyordu.
  const haftaKonulariRes = await query(
    `
      SELECT day_of_week AS "dayOfWeek", period, topic
      FROM lesson_topics
      WHERE week_start = $1 AND topic <> ''
    `,
    [buHaftaBaslangic]
  );
  const haftaKonulari = new Map(
    haftaKonulariRes.rows.map((r) => [`${r.dayOfWeek}:${r.period}`, r.topic])
  );

  const activeTasks = allTasks
    .filter((task) => !task.isArchived)
    .filter(
      (task) =>
        !isLessonTask(task.sourceKey) ||
        (task.singleDate >= buHaftaBaslangic && task.singleDate <= buHaftaBitis)
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
      // Ders gorevinde ACIKLAMA SUTUNU = o ders saatine yazilan konu.
      // Gorevin kunyesi (zil saati, sinif) baslik altinda kucuk satira iner.
      const dersGorevi = isLessonTask(task.sourceKey);
      let lessonTopic = '';
      let lessonMeta = '';
      if (dersGorevi && task.singleDate) {
        const parcalar = String(task.sourceKey).split(':');
        lessonTopic = haftaKonulari.get(`${schedule.dayOfWeek(task.singleDate)}:${Number(parcalar[2])}`) || '';
        // Eski gorevlerde aciklamanin sonunda kalip metin kalmis olabilir.
        lessonMeta = String(task.description || '').replace(/\s*·\s*işlenen konuyu yaz$/, '');
      }

      return {
        ...task,
        isMarked,
        lessonTopic,
        lessonMeta,
        // Ders gorevinde aciklama YAZILAN KONUDUR; elle duzenlenmez, kaynagi
        // Islenen Konular ekranidir.
        description: dersGorevi ? lessonTopic : task.description,
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
        canEditDescription: !locked && !dersGorevi,
        isLocked: locked
      };
    });

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

  // Namaz gorunumu panoda da gerekiyor (ust serit), o yuzden dashboard'da da
  // hesaplanir — uyanma/spor ile ayni desen.
  const prayer =
    currentPage === 'prayer' || currentPage === 'dashboard'
      ? await buildPrayerView(req.currentUser.id, currentPage === 'prayer' ? 14 : 7)
      : null;

  // Acik sayfa hangi planli rutinse onun gorunumu (pano her ikisini de
  // serit olarak gosterir).
  const studyView = STUDY_KINDS[currentPage]
    ? await buildStudyView(STUDY_KINDS[currentPage], req.currentUser.id, 14)
    : null;

  // YZ/YDS gorunumleri panoda hem UST SERIT hem GOREVLERIM tablosu icin
  // haftalik (son 7 gun) cekilir; ikisinde de ayni veriyi kullanir.
  const aiWeek =
    currentPage === 'dashboard' ? await buildStudyView(STUDY_KINDS.ai, req.currentUser.id, 7) : null;
  const ydsWeek =
    currentPage === 'dashboard' ? await buildStudyView(STUDY_KINDS.yds, req.currentUser.id, 7) : null;
  const studyStrips =
    currentPage === 'dashboard'
      ? [aiWeek, ydsWeek].filter((v) => v && v.routine && v.routine.isActive)
      : [];

  // Rutinler "Gorevlerim" tablosunda da gorunur: uyanma, spor, yapay zeka, YDS
  // ve NAMAZ — ICINDE BULUNULAN HAFTANIN her gunu icin. Gecmis gunler
  // durumlariyla, bugun islem yapilabilir, gelecek gunler "Bekliyor".
  // Uyanma/spor bugun satir ici tek dokunusla; YZ/YDS uc durumlu oldugu icin
  // kendi sayfasina baglanti; NAMAZ gunde 5 vakit oldugu icin TEK OZET satir
  // ("2/5 vaktinde · 1 kaza · ...") ve isaretleme kendi sayfasinda.
  // Gorevlerim listesi YALNIZCA okul gunlerini (Sal/Per/Cum — schedule.GUNLER)
  // ve YALNIZCA BUGUNE KADAR gosterir (ileri tarihler gizli); rutin satirlari
  // da yalnizca bu gunler icin uretilir.
  const haftaGunleri = [];
  for (let g = buHaftaBaslangic; g <= buHaftaBitis; g = shiftDate(g, 1)) {
    if (g <= today && schedule.GUNLER.includes(schedule.dayOfWeek(g))) haftaGunleri.push(g);
  }
  const rutinSatirlari =
    currentPage === 'dashboard'
      ? [
          ...buildRoutineWeekRows(
            { tur: 'wake', baslik: 'Uyanma Rutini', endpoint: '/student/wake', page: '/student/wake', tip: 'time' },
            wake,
            haftaGunleri,
            today
          ),
          ...buildRoutineWeekRows(
            { tur: 'sport', baslik: 'Spor Rutini', endpoint: '/student/sport', page: '/student/sport', tip: 'time' },
            sport,
            haftaGunleri,
            today
          ),
          ...buildRoutineWeekRows(
            { tur: 'ai', baslik: 'Yapay Zeka Rutini', page: '/student/ai', tip: 'study' },
            aiWeek,
            haftaGunleri,
            today
          ),
          ...buildRoutineWeekRows(
            { tur: 'yds', baslik: 'YDS Rutini', page: '/student/yds', tip: 'study' },
            ydsWeek,
            haftaGunleri,
            today
          ),
          ...buildRoutineWeekRows(
            { tur: 'prayer', baslik: 'Namaz Rutini', page: '/student/prayer', tip: 'prayer' },
            prayer,
            haftaGunleri,
            today
          )
        ]
      : [];

  const scheduleView = currentPage === 'schedule' ? await buildStudentScheduleView(req) : null;

  // Ogrenci hedefleri yalnizca GORUR; koyma ve degerlendirme adminde.
  const goalsView =
    currentPage === 'goals'
      ? await buildMonthlyGoalsView(req, [{ id: req.currentUser.id, name: req.currentUser.name }])
      : null;

  // Liste bos kaldiginda NEDEN bos oldugunu sayfada soyleyebilmek icin: bu
  // hesapta hic ders gorevi var mi, varsa hangi araliktalar? ("Olusturdum ama
  // gorunmuyor" vakasinda tek tek veritabani sorgulamak yerine sayfa yanitlar.)
  let dersGorevBilgi = null;
  if (!activeTasks.some((task) => isLessonTask(task.sourceKey))) {
    const ozet = await query(
      `
        SELECT count(*)::int AS toplam,
               min(single_date) AS ilk,
               max(single_date) AS son
        FROM tasks
        WHERE student_id = $1 AND source_key LIKE $2
      `,
      [req.currentUser.id, `${LESSON_PREFIX}:%`]
    );
    const satir = ozet.rows[0] || {};
    dersGorevBilgi = {
      toplam: Number(satir.toplam) || 0,
      ilk: toDateOnly(satir.ilk),
      son: toDateOnly(satir.son),
      haftaBaslangic: buHaftaBaslangic,
      haftaBitis: buHaftaBitis
    };
  }

  // Listede gorunen satirlarin tamami, GUN GUN okunacak sekilde siralanir:
  // once tarih, ayni gun icinde once rutinler (sabah), sonra ders saatleri.
  // Ders saati sirasi baslik metninden degil source_key'deki sayidan gelir —
  // "10. ders" metinsel siralamada "2. ders"in onune duserdi.
  const RUTIN_SIRA = { wake: 0, sport: 1, ai: 2, yds: 3, prayer: 4 };
  const satirSirasi = (satir) => {
    if (satir.isRoutine) return RUTIN_SIRA[satir.routineTur] ?? 4;
    if (isLessonTask(satir.sourceKey)) {
      const saat = Number(String(satir.sourceKey).split(':')[2]);
      return Number.isFinite(saat) ? 100 + saat : 900;
    }
    return 900;
  };
  // Yalnizca okul gunu (Sal/Per/Cum) ve bugune kadar; ileri tarihli ve okul
  // disi gunlerdeki gorevler listede gizlenir. Tarihi olmayan satirlar kalir.
  const okulGunuSatir = (s) =>
    !s.singleDate ||
    (schedule.GUNLER.includes(schedule.dayOfWeek(s.singleDate)) && s.singleDate <= today);
  const listeSatirlari = [...rutinSatirlari, ...activeTasks].filter(okulGunuSatir).sort(
    (a, b) =>
      String(a.singleDate || '').localeCompare(String(b.singleDate || '')) ||
      satirSirasi(a) - satirSirasi(b) ||
      String(a.title || '').localeCompare(String(b.title || ''), 'tr')
  );

  // Gun basliklari icin: her satirin gun adi ve o gunun ozeti.
  const gunOzeti = new Map();
  for (const satir of listeSatirlari) {
    const gun = satir.singleDate || today;
    if (!gunOzeti.has(gun)) gunOzeti.set(gun, { toplam: 0, yapilan: 0 });
    const ozet = gunOzeti.get(gun);
    ozet.toplam += 1;
    if (satir.displayStatus && satir.displayStatus.status === 'done') ozet.yapilan += 1;
  }
  for (const satir of listeSatirlari) {
    const gun = satir.singleDate || today;
    satir.gun = gun;
    satir.gunAdi = getDayName(gun);
    satir.gunBugun = gun === today;
    satir.gunOzeti = gunOzeti.get(gun);
  }
  // "Tamamlanan" sayaci EKRANDA GORUNENI saymali. Once yalnizca gorev
  // satirlarinin BUGUNKU durumuna bakiyordu: rutinler hic sayilmiyordu ve
  // defter gorevinin durumu kendi son tarihine (haftanin pazari) yazildigi
  // icin isaretli gorunen satir sayaca girmiyordu — liste "✓" gosterirken
  // sayac "0 tamamlandi" diyordu.
  const doneCount = listeSatirlari.filter(
    (satir) => satir.displayStatus && satir.displayStatus.status === 'done'
  ).length;

  // "Bugunun Ozeti" KPI'si YALNIZCA BUGUNU sayar: liste artik tum haftayi
  // (ders gorevleri + rutinler) gosterdigi icin tum listeyi saymak "bugun"
  // etiketiyle celisirdi. Gun bazli sayac (gunOzeti) zaten her gun basliginda.
  const bugunSatirlari = listeSatirlari.filter((satir) => (satir.singleDate || today) === today);
  const bugunOzet = {
    toplam: bugunSatirlari.length,
    tamamlanan: bugunSatirlari.filter(
      (satir) => satir.displayStatus && satir.displayStatus.status === 'done'
    ).length
  };

  const currentSection = menu.resolveSection(
    menu.STUDENT_MENU,
    currentPage,
    normalizeText(req.query.bolum)
  );

  return {
    user: req.currentUser,
    currentPage,
    currentSection,
    menuTree: menu.buildMenuTree(menu.STUDENT_MENU, currentPage, currentSection),
    currentSectionLabel: menu.sectionLabel(menu.STUDENT_MENU, currentPage, currentSection),
    today,
    menuIcons,
    categories,
    activeTasks: listeSatirlari,
    dersGorevBilgi,
    doneCount,
    bugunOzet,
    questionEntry: null,
    questionHistory,
    calendar,
    program,
    wake,
    sport,
    prayer,
    studyView,
    studyStrips,
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
    const allowedPages = new Set(['dashboard', 'questions', 'calendar', 'program', 'wake', 'schedule', 'goals', 'sport', 'prayer', 'ai', 'yds']);
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

// Calisan surum: acilista bir kez okunur. "Degisiklik canlida mi?" sorusunu
// disaridan yanitlayabilmek icin var — daha once bunu yalnizca public bir
// dosyanin (styles.css) icerigine bakarak tahmin edebiliyorduk ve sunucu
// tarafi degisikliklerde hicbir kanit yoktu.
const APP_VERSION = (() => {
  try {
    return require('child_process')
      .execSync('git rev-parse --short HEAD', { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch (err) {
    return 'bilinmiyor';
  }
})();
const APP_STARTED_AT = new Date().toISOString();

app.get(
  '/healthz',
  asyncHandler(async (_req, res) => {
    await query('SELECT 1');
    return res.json({
      ok: true,
      service: 'öğrenci-takip-app',
      version: APP_VERSION,
      startedAt: APP_STARTED_AT,
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
      ['namaz', `DELETE FROM prayer_logs WHERE day < $1::date`],
      ['yapay zeka', `DELETE FROM ai_logs WHERE day < $1::date`],
      ['yds', `DELETE FROM yds_logs WHERE day < $1::date`],
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

  // Ders gorevi tamamlamasi otomatik kilitten ONCE calisir: kilit once calissa
  // aksam yazilan bir konunun gorevi "yapilmadi" muhurlenmis olurdu.
  try {
    const { completed } = await completeLessonTasks();
    if (completed > 0) {
      console.log(`${completed} ders görevi, konusu yazıldığı için işaretlendi.`);
    }
  } catch (err) {
    console.error('Ders görevi tamamlama hatası:', err);
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

  for (const kind of Object.values(STUDY_KINDS)) {
    try {
      const { sealed } = await sealMissedStudyLogs(kind);
      if (sealed > 0) {
        console.log(`${sealed} gün için ${kind.label} çalışması "yapılmadı" olarak mühürlendi.`);
      }
    } catch (err) {
      console.error(`${kind.label} rutini mühürleme hatası:`, err);
    }
  }

  try {
    const { sealed } = await sealMissedPrayerLogs();
    if (sealed > 0) {
      console.log(`${sealed} namaz vakti "kılınmadı" olarak mühürlendi.`);
    }
  } catch (err) {
    console.error('Namaz rutini mühürleme hatası:', err);
  }
}

async function bootstrap() {
  await initDb();
  await seedAdmin();

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
