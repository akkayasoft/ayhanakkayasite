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
  return new Date(value).toISOString().slice(0, 10);
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
  const days = getWeekDates(weekStart).map((day) => {
    const dayDateObj = new Date(`${day}T00:00:00`);
    const dueTasks = tasks.filter((task) => isTaskDueOnDate(task, dayDateObj, day));
    const doneCount = dueTasks.filter(
      (task) => statusByTaskAndDay.get(`${task.id}:${day}`) === 'done'
    ).length;
    const dayQuestion = questionByDay.get(day);

    const dayInfo = academicCalendar.getDayInfo(day);

    return {
      date: day,
      dayName: getDayName(day),
      dayType: dayInfo.type,
      dayLabel: dayInfo.label,
      isSchoolDay: dayInfo.isSchoolDay,
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
    days
  };
}

// Haftalik analiz: bir hafta icin ogrenci basina gorev tamamlama, soru
// dogrulugu ve calisma suresi; ayrica secili ogrenci icin kategori ve gun
// kirilimi ile onceki haftaya gore degisim.
async function buildWeeklyAnalysis(weekStart, selectedStudentId) {
  const weekEnd = shiftDate(weekStart, 6);
  const prevWeekStart = shiftDate(weekStart, -7);
  const prevWeekEnd = shiftDate(weekStart, -1);

  const [studentsRes, categoriesRes, tasksRes, statusesRes, questionsRes] = await Promise.all([
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

  const bosMetrik = () => ({ due: 0, done: 0, correct: 0, wrong: 0, duration: 0 });

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

    return metrik;
  }

  const oran = (pay, payda) => (payda > 0 ? Math.round((pay / payda) * 1000) / 10 : null);

  function ozetle(metrik) {
    const questionTotal = metrik.correct + metrik.wrong;
    return {
      ...metrik,
      questionTotal,
      completionRate: oran(metrik.done, metrik.due),
      accuracy: oran(metrik.correct, questionTotal)
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
        duration: current.duration - previous.duration
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

      return {
        date: day,
        dayName: getDayName(day),
        dayLabel: dayInfo.isSchoolDay ? 'Ders günü' : dayInfo.label,
        isSchoolDay: dayInfo.isSchoolDay,
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
  const locked = isTaskLockedNow(task, todayDateString(), timeStringInTimeZone());
  return { task, locked };
}

// Suresi dolmus ve hic isaretlenmemis gorev orneklerine 'not_done' yazar.
// Idempotent: var olan kayitlara ON CONFLICT DO NOTHING ile dokunmaz, yani
// ogrencinin kendi isaretledigi 'done' kayitlari korunur.
async function sealOverdueTaskStatuses() {
  const today = todayDateString();
  const nowHm = timeStringInTimeZone();
  const lookbackStart = shiftDate(today, -AUTO_LOCK_LOOKBACK_DAYS);
  const windowStart = AUTO_LOCK_START_DATE > lookbackStart ? AUTO_LOCK_START_DATE : lookbackStart;

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

function adminRedirect(req, res, queryParams) {
  const params = new URLSearchParams(queryParams);
  const requestedNext = normalizeText((req.body && req.body.next) || req.query.next);
  const nextPath = /^\/admin\/(dashboard|students|users|categories|reports|analysis|tasks(?:\/(?:create|update|active))?)(\?.*)?$/.test(requestedNext)
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
  const nextPath = /^\/student\/(dashboard|new-task|questions|calendar)(\?.*)?$/.test(requestedNext)
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
    createdAt: row.createdAt
  };
}

async function getCurrentUserById(userId, withPassword = false) {
  const sql = withPassword
    ? `
      SELECT id, name, username, role, created_at AS "createdAt", password_hash AS "passwordHash"
      FROM users
      WHERE id = $1
    `
    : `
      SELECT id, name, username, role, created_at AS "createdAt"
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
    activeTaskFilters: {
      studentId: activeTaskStudentId
    },
    copyWeekStart,
    copyWeekNextStart,
    weeklyAnalysis,
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
    const allowedSections = new Set(['create', 'update', 'active']);
    const section = allowedSections.has(req.params.section) ? req.params.section : 'active';
    const pageMap = {
      create: 'tasks-create',
      update: 'tasks-update',
      active: 'tasks-active'
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
    const allowedPages = new Set(['dashboard', 'students', 'users', 'categories', 'reports', 'analysis']);
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

    const setClauses = [];
    const values = [];

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

  const activeTasks = allTasks
    .filter((task) => !task.isArchived)
    .sort(compareTasksBySchedule)
    .map((task) => {
      const category = categories.find((c) => c.id === task.categoryId);
      const todayStatus = statuses.find((s) => s.taskId === task.id) || null;
      const latestStatus = latestStatusByTaskId.get(task.id) || null;
      const displayStatus = todayStatus || latestStatus;
      return {
        ...task,
        categoryName: category ? category.name : 'Kategori Yok',
        scheduleText: formatTaskSchedule(task),
        todayStatus,
        displayStatus,
        displayStatusDay: displayStatus ? toDateOnly(displayStatus.day) : '',
        displayStatusIsToday: Boolean(todayStatus),
        canManage:
          task.createdBy === req.currentUser.id &&
          task.repeatType === 'once' &&
          !isTaskLockedNow(task, today, nowHm),
        isLocked: isTaskLockedNow(task, today, nowHm)
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

  return {
    user: req.currentUser,
    currentPage,
    today,
    categories,
    activeTasks,
    doneCount,
    questionEntry: null,
    questionHistory,
    calendar,
    message: req.query.message || null,
    error: req.query.error || null
  };
}

app.get('/student', requireRole('student'), (req, res) => res.redirect('/student/dashboard'));

app.get(
  '/student/:page',
  requireRole('student'),
  asyncHandler(async (req, res) => {
    const allowedPages = new Set(['dashboard', 'new-task', 'questions', 'calendar']);
    const currentPage = allowedPages.has(req.params.page) ? req.params.page : 'dashboard';
    const viewModel = await getStudentViewModel(req, currentPage);
    return res.render('student', viewModel);
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

    const taskRes = await query(
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
    );

    if (taskRes.rowCount === 0) {
      return res.status(404).json({ ok: false, error: 'Bu görev güncellenemez.' });
    }

    const { locked: cellLocked } = await findStudentTaskIfEditable(taskId, req.currentUser.id);
    if (cellLocked) {
      return res.status(403).json({ ok: false, error: 'Bu görevin süresi doldu, üzerinde değişiklik yapılamaz.' });
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
      await query(`UPDATE tasks SET description = $1 WHERE id = $2`, [descriptionValidation.value, taskId]);
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

    const { locked: updateLocked } = await findStudentTaskIfEditable(taskId, req.currentUser.id);
    if (updateLocked) {
      return studentRedirect(req, res, { error: 'Bu görevin süresi doldu, üzerinde değişiklik yapılamaz.' });
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

    const { locked } = await findStudentTaskIfEditable(taskId, req.currentUser.id);
    if (locked) {
      return studentRedirect(req, res, { error: 'Bu görevin süresi doldu, üzerinde değişiklik yapılamaz.' });
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

    // Suresi dolan gorev orneginin isareti degistirilemez.
    const task = mapTask(taskRes.rows[0]);
    if (isTaskLockedNow(task, day, timeStringInTimeZone())) {
      return res.redirect(
        `/student/dashboard?error=${encodeURIComponent(
          'Bu görevin süresi doldu, işareti değiştirilemez.'
        )}`
      );
    }

    await query(
      `
        INSERT INTO task_statuses (id, task_id, student_id, day, status, note)
        VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT (task_id, student_id, day)
        DO UPDATE SET status = EXCLUDED.status, note = EXCLUDED.note, updated_at = NOW()
      `,
      [makeId('status'), taskId, req.currentUser.id, day, status, note]
    );

    return res.redirect(`/student/dashboard?message=${encodeURIComponent('Görev durumu güncellendi.')}`);
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

async function runSealSafely() {
  try {
    const { inserted } = await sealOverdueTaskStatuses();
    if (inserted > 0) {
      console.log(`Süresi dolan ${inserted} görev otomatik "yapılmadı" olarak işaretlendi.`);
    }
  } catch (err) {
    console.error('Otomatik işaretleme hatası:', err);
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
