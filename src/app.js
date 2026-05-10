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
  message: 'Cok fazla giris denemesi yaptiniz. Lutfen daha sonra tekrar deneyin.'
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
  const names = ['Pazar', 'Pazartesi', 'Sali', 'Carsamba', 'Persembe', 'Cuma', 'Cumartesi'];
  const d = new Date(`${dateStr}T00:00:00`);
  return names[d.getDay()];
}

function todayDateString() {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function isDateOnly(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
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

    return {
      date: day,
      dayName: getDayName(day),
      dueCount: dueTasks.length,
      doneCount,
      questionTotal: dayQuestion ? Number(dayQuestion.totalQuestions || 0) : 0,
      durationMinutes: dayQuestion ? Number(dayQuestion.totalDuration || 0) : 0,
      tasks: dueTasks.map((task) => ({
        id: task.id,
        title: task.title,
        status: statusByTaskAndDay.get(`${task.id}:${day}`) || 'not_set'
      }))
    };
  });

  return {
    weekStart,
    weekEnd,
    prevWeekStart: shiftDate(weekStart, -7),
    nextWeekStart: shiftDate(weekStart, 7),
    days
  };
}

function parseDateRange(from, to) {
  const today = todayDateString();
  const fromDate = from || shiftDate(today, -6);
  const toDate = to || today;

  if (fromDate > toDate) {
    return { error: 'Baslangic tarihi bitis tarihinden buyuk olamaz.' };
  }

  const days = [];
  let cursor = fromDate;
  let count = 0;

  while (cursor <= toDate) {
    days.push(cursor);
    cursor = shiftDate(cursor, 1);
    count += 1;

    if (count > 93) {
      return { error: 'Rapor araligi en fazla 93 gun olabilir.' };
    }
  }

  return { fromDate, toDate, days, error: null };
}

function formatRepeat(task) {
  if (task.repeatType === 'once') return `Tek seferlik (${task.singleDate || '-'})`;
  if (task.repeatType === 'daily') return 'Her gun';
  if (task.repeatType === 'weekly') return `Haftalik (Gun ${task.weeklyDay})`;
  if (task.repeatType === 'monthly') return `Aylik (Gun ${task.monthlyDay})`;
  if (task.repeatType === 'custom') return `Ozel (${(task.customDates || []).join(', ')})`;
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

function adminRedirect(req, res, queryParams) {
  const params = new URLSearchParams(queryParams);
  const requestedNext = normalizeText((req.body && req.body.next) || req.query.next);
  const nextPath = /^\/admin\/(dashboard|students|users|categories|tasks|points|reports)$/.test(requestedNext)
    ? requestedNext
    : '/admin/dashboard';
  const queryString = params.toString();
  return res.redirect(queryString ? `${nextPath}?${queryString}` : nextPath);
}

function mapUser(row) {
  return {
    id: row.id,
    name: row.name,
    username: row.username,
    role: row.role,
    points: Number(row.points || 0),
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
    isArchived: row.isArchived,
    createdBy: row.createdBy,
    createdAt: row.createdAt
  };
}

async function getCurrentUserById(userId, withPassword = false) {
  const sql = withPassword
    ? `
      SELECT id, name, username, role, points, created_at AS "createdAt", password_hash AS "passwordHash"
      FROM users
      WHERE id = $1
    `
    : `
      SELECT id, name, username, role, points, created_at AS "createdAt"
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
      return res.status(403).send('Yetkisiz erisim.');
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
        SELECT id, name, username, role, points, password_hash AS "passwordHash"
        FROM users
        WHERE username = $1
        LIMIT 1
      `,
      [username]
    );

    if (result.rowCount === 0) {
      return res.status(401).render('login', { error: 'Kullanici adi veya sifre hatali.' });
    }

    const user = result.rows[0];
    if (!bcrypt.compareSync(password, user.passwordHash)) {
      return res.status(401).render('login', { error: 'Kullanici adi veya sifre hatali.' });
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
  const [usersRes, studentsRes, categoriesRes, tasksRes, pointLogsRes] = await Promise.all([
    query(
      `SELECT id, name, username, role, points, created_at AS "createdAt" FROM users ORDER BY role DESC, name ASC`
    ),
    query(
      `SELECT id, name, username, role, points, created_at AS "createdAt" FROM users WHERE role = 'student' ORDER BY name ASC`
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
        is_archived AS "isArchived",
        created_by AS "createdBy",
        created_at AS "createdAt"
      FROM tasks
      ORDER BY created_at DESC
    `),
    query(`
      SELECT
        id,
        student_id AS "studentId",
        type,
        points,
        reason,
        delta,
        created_by AS "createdBy",
        created_at AS "createdAt"
      FROM point_logs
      ORDER BY created_at DESC
      LIMIT 20
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

  const pointLogs = pointLogsRes.rows.map((row) => ({
    ...row,
    createdAt: row.createdAt,
    createdDate: toDateOnly(row.createdAt)
  }));

  const today = todayDateString();
  const dateObj = new Date(`${today}T00:00:00`);
  const weeklyRuleWeekStart = normalizeWeekStart(normalizeText(req.query.weekStart), today) || startOfWeek(today);
  const weeklyRuleWeekEnd = shiftDate(weeklyRuleWeekStart, 6);
  const weeklyEvalStudentIdRaw = normalizeText(req.query.weeklyEvalStudentId);
  const weeklyEvalStudentId = students.some((s) => s.id === weeklyEvalStudentIdRaw)
    ? weeklyEvalStudentIdRaw
    : '';
  const editTaskId = normalizeText(req.query.editTaskId);
  const activeTaskStudentIdRaw = normalizeText(req.query.activeTaskStudentId);
  const activeTaskStudentId = students.some((s) => s.id === activeTaskStudentIdRaw) ? activeTaskStudentIdRaw : '';
  const editingTask = tasks.find((t) => t.id === editTaskId) || null;
  const taskForm = editingTask
    ? {
        isEdit: true,
        action: `/admin/tasks/${editingTask.id}/update`,
        submitText: 'Gorevi Guncelle',
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
        endDate: editingTask.endDate || ''
      }
    : {
        isEdit: false,
        action: '/admin/tasks',
        submitText: 'Gorevi Kaydet',
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
        endDate: ''
      };

  const sortedActiveTasks = tasks
    .filter((t) => !t.isArchived)
    .sort((a, b) => {
      const aDate = getTaskSortDate(a);
      const bDate = getTaskSortDate(b);
      if (aDate !== bDate) return aDate.localeCompare(bDate);
      return String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
    });
  const activeTasks = activeTaskStudentId
    ? sortedActiveTasks.filter((t) => t.studentId === activeTaskStudentId)
    : sortedActiveTasks;

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
    const [rangeStatusesRes, rangeQuestionsRes, rangePointsRes] = await Promise.all([
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
      ),
      query(
        `
          SELECT student_id AS "studentId", created_at AS "createdAt", delta
          FROM point_logs
          WHERE student_id = $1 AND created_at::date BETWEEN $2 AND $3
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
      const dayPointDelta = rangePointsRes.rows
        .filter((p) => toDateOnly(p.createdAt) === dateStr)
        .reduce((sum, p) => sum + Number(p.delta || 0), 0);

      return {
        date: dateStr,
        dueCount: dueTasks.length,
        doneCount,
        notDoneCount: Math.max(dueTasks.length - doneCount, 0),
        questionCount: question ? Number(question.totalQuestions || 0) : 0,
        pointDelta: dayPointDelta
      };
    });

    const totals = rows.reduce(
      (acc, row) => {
        acc.due += row.dueCount;
        acc.done += row.doneCount;
        acc.questions += row.questionCount;
        acc.pointDelta += row.pointDelta;
        return acc;
      },
      { due: 0, done: 0, questions: 0, pointDelta: 0 }
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

  let weeklyRules = [];
  let weeklyEvaluations = [];
  if (currentPage === 'points') {
    const [weeklyRulesRes, weeklyEvaluationsRes] = await Promise.all([
      query(
        `
          SELECT
            r.id,
            r.week_start AS "weekStart",
            r.category_id AS "categoryId",
            r.reward_points AS "rewardPoints",
            r.penalty_points AS "penaltyPoints",
            r.reward_label AS "rewardLabel",
            r.penalty_label AS "penaltyLabel",
            r.created_at AS "createdAt",
            r.updated_at AS "updatedAt",
            c.name AS "categoryName"
          FROM weekly_category_rules r
          JOIN categories c ON c.id = r.category_id
          WHERE r.week_start = $1
          ORDER BY c.name ASC
        `,
        [weeklyRuleWeekStart]
      ),
      query(
        `
          SELECT
            e.id,
            e.week_start AS "weekStart",
            e.student_id AS "studentId",
            e.category_id AS "categoryId",
            e.due_count AS "dueCount",
            e.done_count AS "doneCount",
            e.completion_rate AS "completionRate",
            e.result_type AS "resultType",
            e.points_applied AS "pointsApplied",
            e.reason_text AS "reasonText",
            e.calculated_at AS "calculatedAt",
            u.name AS "studentName",
            c.name AS "categoryName"
          FROM weekly_category_evaluations e
          JOIN users u ON u.id = e.student_id
          JOIN categories c ON c.id = e.category_id
          WHERE e.week_start = $1
            AND ($2::text = '' OR e.student_id = $2)
          ORDER BY u.name ASC, c.name ASC
        `,
        [weeklyRuleWeekStart, weeklyEvalStudentId]
      )
    ]);

    weeklyRules = weeklyRulesRes.rows;
    weeklyEvaluations = weeklyEvaluationsRes.rows.map((row) => ({
      ...row,
      completionRate: Number(row.completionRate || 0),
      createdDate: toDateOnly(row.calculatedAt)
    }));
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
    archivedTasks: tasks.filter((t) => t.isArchived),
    taskForm,
    activeTaskFilters: {
      studentId: activeTaskStudentId
    },
    weeklyRuleWeekStart,
    weeklyRuleWeekEnd,
    weeklyRules,
    weeklyEvaluations,
    weeklyEvalFilters: {
      studentId: weeklyEvalStudentId
    },
    pointLogs,
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

app.get('/admin', requireRole('admin'), (req, res) => res.redirect('/admin/dashboard'));

app.get(
  '/admin/:page',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const allowedPages = new Set(['dashboard', 'students', 'users', 'categories', 'tasks', 'points', 'reports']);
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
      return adminRedirect(req, res, { error: 'Ogrenci bilgileri eksik.' });
    }

    if (password.length < 6) {
      return adminRedirect(req, res, { error: 'Sifre en az 6 karakter olmali.' });
    }

    const exists = await query(`SELECT id FROM users WHERE username = $1 LIMIT 1`, [username]);
    if (exists.rowCount > 0) {
      return adminRedirect(req, res, { error: 'Bu kullanici adi zaten var.' });
    }

    await query(
      `
        INSERT INTO users (id, name, username, password_hash, role, points)
        VALUES ($1, $2, $3, $4, 'student', 0)
      `,
      [makeId('user'), name, username, bcrypt.hashSync(password, 10)]
    );

    return adminRedirect(req, res, { message: 'Ogrenci eklendi.' });
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
      return adminRedirect(req, res, { error: 'Kullanici bilgileri eksik.' });
    }

    if (!['admin', 'student'].includes(role)) {
      return adminRedirect(req, res, { error: 'Gecersiz rol.' });
    }

    if (password.length < 6) {
      return adminRedirect(req, res, { error: 'Sifre en az 6 karakter olmali.' });
    }

    const exists = await query(`SELECT id FROM users WHERE username = $1 LIMIT 1`, [username]);
    if (exists.rowCount > 0) {
      return adminRedirect(req, res, { error: 'Bu kullanici adi zaten var.' });
    }

    await query(
      `
        INSERT INTO users (id, name, username, password_hash, role, points)
        VALUES ($1, $2, $3, $4, $5, 0)
      `,
      [makeId('user'), name, username, bcrypt.hashSync(password, 10), role]
    );

    return adminRedirect(req, res, { message: 'Kullanici eklendi.' });
  })
);

app.post(
  '/admin/users/:userId/role',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const { userId } = req.params;
    const role = normalizeText(req.body.role);

    if (!['admin', 'student'].includes(role)) {
      return adminRedirect(req, res, { error: 'Gecersiz rol.' });
    }

    if (userId === req.currentUser.id) {
      return adminRedirect(req, res, { error: 'Kendi rolunuzu bu ekrandan degistiremezsiniz.' });
    }

    const userRes = await query(`SELECT id, role FROM users WHERE id = $1 LIMIT 1`, [userId]);
    if (userRes.rowCount === 0) {
      return adminRedirect(req, res, { error: 'Kullanici bulunamadi.' });
    }

    const target = userRes.rows[0];
    if (target.role === 'admin' && role !== 'admin') {
      const adminCountRes = await query(`SELECT COUNT(*)::int AS "count" FROM users WHERE role = 'admin'`);
      if (Number(adminCountRes.rows[0].count) <= 1) {
        return adminRedirect(req, res, { error: 'Son admin kullanici ogrenciye dusurulemez.' });
      }
    }

    await query(`UPDATE users SET role = $1 WHERE id = $2`, [role, userId]);
    return adminRedirect(req, res, { message: 'Kullanici rolu guncellendi.' });
  })
);

app.post(
  '/admin/users/:userId/password',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const { userId } = req.params;
    const password = normalizeText(req.body.password);

    if (password.length < 6) {
      return adminRedirect(req, res, { error: 'Sifre en az 6 karakter olmali.' });
    }

    const updated = await query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [bcrypt.hashSync(password, 10), userId]);
    if (updated.rowCount === 0) {
      return adminRedirect(req, res, { error: 'Kullanici bulunamadi.' });
    }

    return adminRedirect(req, res, { message: 'Kullanici sifresi guncellendi.' });
  })
);

app.post(
  '/admin/users/:userId/delete',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const { userId } = req.params;

    if (userId === req.currentUser.id) {
      return adminRedirect(req, res, { error: 'Kendi hesabinizi silemezsiniz.' });
    }

    const userRes = await query(`SELECT id, role FROM users WHERE id = $1 LIMIT 1`, [userId]);
    if (userRes.rowCount === 0) {
      return adminRedirect(req, res, { error: 'Kullanici bulunamadi.' });
    }

    const target = userRes.rows[0];
    if (target.role === 'admin') {
      const adminCountRes = await query(`SELECT COUNT(*)::int AS "count" FROM users WHERE role = 'admin'`);
      if (Number(adminCountRes.rows[0].count) <= 1) {
        return adminRedirect(req, res, { error: 'Son admin kullanici silinemez.' });
      }
    }

    try {
      await query(`DELETE FROM users WHERE id = $1`, [userId]);
    } catch (err) {
      if (err.code === '23503') {
        return adminRedirect(req, res, { error: 'Bu kullanici bagli kayitlar nedeniyle silinemiyor.' });
      }
      throw err;
    }

    return adminRedirect(req, res, { message: 'Kullanici silindi.' });
  })
);

app.post(
  '/admin/categories',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const name = normalizeText(req.body.name);

    if (!name) {
      return adminRedirect(req, res, { error: 'Kategori adi zorunlu.' });
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
      return adminRedirect(req, res, { error: 'Bu kategori aktif gorevlerde kullaniliyor.' });
    }

    const deleted = await query(`DELETE FROM categories WHERE id = $1`, [categoryId]);

    if (deleted.rowCount === 0) {
      return adminRedirect(req, res, { error: 'Kategori bulunamadi.' });
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

    if (!title || !categoryId || !studentId || !repeatType) {
      return adminRedirect(req, res, { error: 'Gorev icin zorunlu alanlar eksik.' });
    }

    if (startDate && endDate && startDate > endDate) {
      return adminRedirect(req, res, { error: 'Baslangic tarihi bitis tarihinden buyuk olamaz.' });
    }

    const [categoryRes, studentRes] = await Promise.all([
      query(`SELECT id FROM categories WHERE id = $1`, [categoryId]),
      query(`SELECT id FROM users WHERE id = $1 AND role = 'student'`, [studentId])
    ]);

    if (categoryRes.rowCount === 0 || studentRes.rowCount === 0) {
      return adminRedirect(req, res, { error: 'Kategori veya ogrenci gecersiz.' });
    }

    let singleDateVal = null;
    let weeklyDayVal = null;
    let monthlyDayVal = null;
    let customDatesVal = [];

    if (repeatType === 'once') {
      if (!singleDate) {
        return adminRedirect(req, res, { error: 'Tek seferlik gorev icin tarih zorunlu.' });
      }
      singleDateVal = singleDate;
    } else if (repeatType === 'daily') {
      if (!startDate || !endDate) {
        return adminRedirect(req, res, { error: 'Her gun gorev icin baslangic ve bitis tarihi zorunlu.' });
      }
    } else if (repeatType === 'weekly') {
      if (weeklyDay === '') {
        return adminRedirect(req, res, { error: 'Haftalik gorev icin gun zorunlu.' });
      }
      weeklyDayVal = Number(weeklyDay);
    } else if (repeatType === 'monthly') {
      if (!monthlyDay) {
        return adminRedirect(req, res, { error: 'Aylik gorev icin gun zorunlu.' });
      }
      monthlyDayVal = Number(monthlyDay);
    } else if (repeatType === 'custom') {
      const parsedDates = customDates
        .split(',')
        .map((d) => d.trim())
        .filter(Boolean);

      if (!parsedDates.length) {
        return adminRedirect(req, res, { error: 'Ozel tarihli gorev icin en az bir tarih girin.' });
      }
      customDatesVal = parsedDates;
    } else {
      return adminRedirect(req, res, { error: 'Gecersiz tekrar tipi.' });
    }

    if (repeatType === 'daily') {
      const dayList = getDateRangeInclusive(startDate, endDate);
      if (!dayList || dayList.length === 0) {
        return adminRedirect(req, res, { error: 'Tarih araligi gecersiz veya cok uzun.' });
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
                is_archived,
                created_by
              )
              VALUES ($1,$2,$3,$4,$5,'once',$6,NULL,NULL,'{}',NULL,NULL,false,$7)
            `,
            [makeId('task'), title, description, categoryId, studentId, day, req.currentUser.id]
          );
        }

        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }

      return adminRedirect(req, res, { message: `${dayList.length} adet gunluk gorev olusturuldu.` });
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
          is_archived,
          created_by
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,false,$13)
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
        req.currentUser.id
      ]
    );

    return adminRedirect(req, res, { message: 'Gorev olusturuldu.' });
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

    if (!title || !categoryId || !studentId || !repeatType) {
      return adminRedirect(req, res, { error: 'Gorev guncelleme alanlari eksik.' });
    }

    if (startDate && endDate && startDate > endDate) {
      return adminRedirect(req, res, { error: 'Baslangic tarihi bitis tarihinden buyuk olamaz.' });
    }

    const [taskRes, categoryRes, studentRes] = await Promise.all([
      query(`SELECT id FROM tasks WHERE id = $1 LIMIT 1`, [taskId]),
      query(`SELECT id FROM categories WHERE id = $1 LIMIT 1`, [categoryId]),
      query(`SELECT id FROM users WHERE id = $1 AND role = 'student' LIMIT 1`, [studentId])
    ]);

    if (taskRes.rowCount === 0) {
      return adminRedirect(req, res, { error: 'Gorev bulunamadi.' });
    }
    if (categoryRes.rowCount === 0 || studentRes.rowCount === 0) {
      return adminRedirect(req, res, { error: 'Kategori veya ogrenci gecersiz.' });
    }

    let singleDateVal = null;
    let weeklyDayVal = null;
    let monthlyDayVal = null;
    let customDatesVal = [];

    if (repeatType === 'once') {
      if (!singleDate) {
        return adminRedirect(req, res, { error: 'Tek seferlik gorev icin tarih zorunlu.' });
      }
      singleDateVal = singleDate;
    } else if (repeatType === 'daily') {
      return adminRedirect(req, res, { error: 'Her gun tipi sadece yeni gorev olusturmada kullanilir.' });
    } else if (repeatType === 'weekly') {
      if (weeklyDay === '') {
        return adminRedirect(req, res, { error: 'Haftalik gorev icin gun zorunlu.' });
      }
      weeklyDayVal = Number(weeklyDay);
    } else if (repeatType === 'monthly') {
      if (!monthlyDay) {
        return adminRedirect(req, res, { error: 'Aylik gorev icin gun zorunlu.' });
      }
      monthlyDayVal = Number(monthlyDay);
    } else if (repeatType === 'custom') {
      const parsedDates = customDates
        .split(',')
        .map((d) => d.trim())
        .filter(Boolean);

      if (!parsedDates.length) {
        return adminRedirect(req, res, { error: 'Ozel tarihli gorev icin en az bir tarih girin.' });
      }
      customDatesVal = parsedDates;
    } else {
      return adminRedirect(req, res, { error: 'Gecersiz tekrar tipi.' });
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
          end_date = $11
        WHERE id = $12
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
        taskId
      ]
    );

    return adminRedirect(req, res, { message: 'Gorev guncellendi.' });
  })
);

app.post(
  '/admin/tasks/:taskId/archive',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const { taskId } = req.params;
    const updated = await query(`UPDATE tasks SET is_archived = true WHERE id = $1`, [taskId]);

    if (updated.rowCount === 0) {
      return adminRedirect(req, res, { error: 'Gorev bulunamadi.' });
    }

    return adminRedirect(req, res, { message: 'Gorev arsive alindi.' });
  })
);

app.post(
  '/admin/tasks/:taskId/unarchive',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const { taskId } = req.params;
    const updated = await query(`UPDATE tasks SET is_archived = false WHERE id = $1`, [taskId]);

    if (updated.rowCount === 0) {
      return adminRedirect(req, res, { error: 'Gorev bulunamadi.' });
    }

    return adminRedirect(req, res, { message: 'Gorev yeniden aktiflesti.' });
  })
);

app.post(
  '/admin/tasks/:taskId/delete',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const { taskId } = req.params;
    const deleted = await query(`DELETE FROM tasks WHERE id = $1`, [taskId]);

    if (deleted.rowCount === 0) {
      return adminRedirect(req, res, { error: 'Gorev bulunamadi.' });
    }

    return adminRedirect(req, res, { message: 'Gorev kalici olarak silindi.' });
  })
);

app.post(
  '/admin/weekly-rules',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const weekStart = normalizeWeekStart(normalizeText(req.body.weekStart), todayDateString());
    const categoryId = normalizeText(req.body.categoryId);
    const rewardPoints = Number.parseInt(req.body.rewardPoints, 10);
    const penaltyPoints = Number.parseInt(req.body.penaltyPoints, 10);
    const rewardLabel = normalizeText(req.body.rewardLabel);
    const penaltyLabel = normalizeText(req.body.penaltyLabel);

    if (!weekStart || !categoryId) {
      return adminRedirect(req, res, { error: 'Hafta ve kategori zorunlu.', weekStart: weekStart || '' });
    }

    if (!Number.isInteger(rewardPoints) || rewardPoints < 0 || !Number.isInteger(penaltyPoints) || penaltyPoints < 0) {
      return adminRedirect(req, res, { error: 'Odul/ceza puani 0 veya daha buyuk bir tam sayi olmali.', weekStart });
    }

    const categoryRes = await query(`SELECT id FROM categories WHERE id = $1 LIMIT 1`, [categoryId]);
    if (categoryRes.rowCount === 0) {
      return adminRedirect(req, res, { error: 'Kategori bulunamadi.', weekStart });
    }

    await query(
      `
        INSERT INTO weekly_category_rules (
          id,
          week_start,
          category_id,
          reward_points,
          penalty_points,
          reward_label,
          penalty_label,
          created_by
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT (week_start, category_id)
        DO UPDATE SET
          reward_points = EXCLUDED.reward_points,
          penalty_points = EXCLUDED.penalty_points,
          reward_label = EXCLUDED.reward_label,
          penalty_label = EXCLUDED.penalty_label,
          created_by = EXCLUDED.created_by,
          updated_at = NOW()
      `,
      [
        makeId('wcr'),
        weekStart,
        categoryId,
        rewardPoints,
        penaltyPoints,
        rewardLabel,
        penaltyLabel,
        req.currentUser.id
      ]
    );

    return adminRedirect(req, res, { message: 'Haftalik kategori kurali kaydedildi.', weekStart });
  })
);

app.post(
  '/admin/weekly-evaluations/run',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const weekStart = normalizeWeekStart(normalizeText(req.body.weekStart), todayDateString());
    const weekEnd = weekStart ? shiftDate(weekStart, 6) : '';
    const studentId = normalizeText(req.body.studentId);

    if (!weekStart) {
      return adminRedirect(req, res, { error: 'Hafta bilgisi gecersiz.' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const rulesRes = await client.query(
        `
          SELECT
            r.week_start AS "weekStart",
            r.category_id AS "categoryId",
            r.reward_points AS "rewardPoints",
            r.penalty_points AS "penaltyPoints",
            r.reward_label AS "rewardLabel",
            r.penalty_label AS "penaltyLabel",
            c.name AS "categoryName"
          FROM weekly_category_rules r
          JOIN categories c ON c.id = r.category_id
          WHERE r.week_start = $1
          ORDER BY c.name ASC
        `,
        [weekStart]
      );

      if (!rulesRes.rowCount) {
        await client.query('ROLLBACK');
        return adminRedirect(req, res, { error: 'Bu hafta icin kategori odul/ceza tanimi yok.', weekStart });
      }

      const studentsRes = await client.query(
        `
          SELECT id, name
          FROM users
          WHERE role = 'student'
            AND ($1::text = '' OR id = $1)
          ORDER BY name ASC
        `,
        [studentId]
      );

      if (!studentsRes.rowCount) {
        await client.query('ROLLBACK');
        return adminRedirect(req, res, { error: 'Degerlendirilecek ogrenci bulunamadi.', weekStart });
      }

      const ruleByCategory = new Map(
        rulesRes.rows.map((rule) => [rule.categoryId, rule])
      );
      const categoryIds = Array.from(ruleByCategory.keys());
      const studentIds = studentsRes.rows.map((row) => row.id);
      const weekDates = getWeekDates(weekStart);

      const tasksRes = await client.query(
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
            is_archived AS "isArchived",
            created_by AS "createdBy",
            created_at AS "createdAt"
          FROM tasks
          WHERE student_id = ANY($1)
            AND category_id = ANY($2)
            AND is_archived = false
        `,
        [studentIds, categoryIds]
      );
      const statusesRes = await client.query(
        `
          SELECT task_id AS "taskId", student_id AS "studentId", day, status
          FROM task_statuses
          WHERE student_id = ANY($1)
            AND day BETWEEN $2 AND $3
        `,
        [studentIds, weekStart, weekEnd]
      );
      const existingRes = await client.query(
        `
          SELECT student_id AS "studentId", category_id AS "categoryId"
          FROM weekly_category_evaluations
          WHERE week_start = $1
            AND student_id = ANY($2)
        `,
        [weekStart, studentIds]
      );

      const tasksByStudent = new Map();
      tasksRes.rows.map(mapTask).forEach((task) => {
        const current = tasksByStudent.get(task.studentId) || [];
        current.push(task);
        tasksByStudent.set(task.studentId, current);
      });

      const doneStatusSet = new Set(
        statusesRes.rows
          .filter((row) => row.status === 'done')
          .map((row) => `${row.studentId}:${row.taskId}:${toDateOnly(row.day)}`)
      );
      const existingSet = new Set(
        existingRes.rows.map((row) => `${row.studentId}:${row.categoryId}`)
      );

      let createdCount = 0;
      let rewardCount = 0;
      let penaltyCount = 0;
      let skippedCount = 0;

      for (const student of studentsRes.rows) {
        const studentTasks = tasksByStudent.get(student.id) || [];
        const metricsByCategory = new Map(
          categoryIds.map((categoryId) => [categoryId, { due: 0, done: 0 }])
        );

        for (const day of weekDates) {
          const dayObj = new Date(`${day}T00:00:00`);
          const dueTasks = studentTasks.filter(
            (task) => ruleByCategory.has(task.categoryId) && isTaskDueOnDate(task, dayObj, day)
          );

          for (const dueTask of dueTasks) {
            const metric = metricsByCategory.get(dueTask.categoryId);
            if (!metric) continue;

            metric.due += 1;
            if (doneStatusSet.has(`${student.id}:${dueTask.id}:${day}`)) {
              metric.done += 1;
            }
          }
        }

        for (const [categoryId, rule] of ruleByCategory.entries()) {
          const alreadyCalculated = existingSet.has(`${student.id}:${categoryId}`);
          if (alreadyCalculated) {
            skippedCount += 1;
            continue;
          }

          const metric = metricsByCategory.get(categoryId) || { due: 0, done: 0 };
          const completionRate = metric.due > 0 ? (metric.done / metric.due) * 100 : 0;
          let resultType = 'none';
          let pointsApplied = 0;
          let reasonText = '';
          let pointLogId = null;

          if (metric.due > 0 && completionRate > 80 && Number(rule.rewardPoints) > 0) {
            resultType = 'reward';
            pointsApplied = Number(rule.rewardPoints);
            reasonText = normalizeText(rule.rewardLabel) || `${rule.categoryName} haftalik odul`;
          } else if (metric.due > 0 && completionRate < 80 && Number(rule.penaltyPoints) > 0) {
            resultType = 'penalty';
            pointsApplied = -Number(rule.penaltyPoints);
            reasonText = normalizeText(rule.penaltyLabel) || `${rule.categoryName} haftalik ceza`;
          }

          if (pointsApplied !== 0) {
            await client.query(
              `UPDATE users SET points = points + $1 WHERE id = $2`,
              [pointsApplied, student.id]
            );

            const pointType = pointsApplied > 0 ? 'reward' : 'penalty';
            const pointReason = `${reasonText} (${rule.categoryName}, ${weekStart} - ${weekEnd}, oran %${completionRate.toFixed(1)})`;
            const pointInsertRes = await client.query(
              `
                INSERT INTO point_logs (id, student_id, type, points, reason, delta, created_by)
                VALUES ($1,$2,$3,$4,$5,$6,$7)
                RETURNING id
              `,
              [
                makeId('plog'),
                student.id,
                pointType,
                Math.abs(pointsApplied),
                pointReason,
                pointsApplied,
                req.currentUser.id
              ]
            );
            pointLogId = pointInsertRes.rows[0].id;

            if (pointsApplied > 0) rewardCount += 1;
            if (pointsApplied < 0) penaltyCount += 1;
          }

          await client.query(
            `
              INSERT INTO weekly_category_evaluations (
                id,
                week_start,
                student_id,
                category_id,
                due_count,
                done_count,
                completion_rate,
                result_type,
                points_applied,
                reason_text,
                point_log_id,
                calculated_by
              )
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
            `,
            [
              makeId('weval'),
              weekStart,
              student.id,
              categoryId,
              metric.due,
              metric.done,
              completionRate.toFixed(2),
              resultType,
              pointsApplied,
              reasonText,
              pointLogId,
              req.currentUser.id
            ]
          );

          createdCount += 1;
        }
      }

      await client.query('COMMIT');

      return adminRedirect(req, res, {
        message: `Haftalik degerlendirme tamamlandi. Kayit: ${createdCount}, Odul: ${rewardCount}, Ceza: ${penaltyCount}, Atlanan: ${skippedCount}.`,
        weekStart,
        weeklyEvalStudentId: studentId
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  })
);

app.post(
  '/admin/points',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const weekStart = normalizeWeekStart(normalizeText(req.body.weekStart), todayDateString());
    const studentId = normalizeText(req.body.studentId);
    const type = normalizeText(req.body.type);
    const reason = normalizeText(req.body.reason);
    const parsedPoints = Number(req.body.points);

    if (!studentId || !type || !parsedPoints || !reason) {
      return adminRedirect(req, res, { error: 'Odul/ceza alanlari eksik.', weekStart: weekStart || '' });
    }

    if (!['reward', 'penalty'].includes(type)) {
      return adminRedirect(req, res, { error: 'Gecersiz puan tipi.', weekStart: weekStart || '' });
    }

    const delta = type === 'reward' ? Math.abs(parsedPoints) : -Math.abs(parsedPoints);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const studentRes = await client.query(
        `SELECT id FROM users WHERE id = $1 AND role = 'student' FOR UPDATE`,
        [studentId]
      );

      if (studentRes.rowCount === 0) {
        await client.query('ROLLBACK');
        return adminRedirect(req, res, { error: 'Ogrenci bulunamadi.', weekStart: weekStart || '' });
      }

      await client.query(
        `UPDATE users SET points = points + $1 WHERE id = $2`,
        [delta, studentId]
      );

      await client.query(
        `
          INSERT INTO point_logs (id, student_id, type, points, reason, delta, created_by)
          VALUES ($1,$2,$3,$4,$5,$6,$7)
        `,
        [makeId('plog'), studentId, type, Math.abs(parsedPoints), reason, delta, req.currentUser.id]
      );

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    return adminRedirect(req, res, { message: 'Puan islemi kaydedildi.', weekStart: weekStart || '' });
  })
);

async function getStudentViewModel(req, currentPage) {
  const today = todayDateString();

  const [tasksRes, statusesRes, todayQuestionRes, questionHistoryRes, pointLogsRes, categoriesRes] = await Promise.all([
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
        FROM task_statuses
        WHERE student_id = $1 AND day = $2
      `,
      [req.currentUser.id, today]
    ),
    query(
      `
        SELECT
          id,
          student_id AS "studentId",
          day,
          category_id AS "categoryId",
          lesson_name AS "lessonName",
          correct_count AS "correctCount",
          wrong_count AS "wrongCount",
          duration_minutes AS "durationMinutes"
        FROM daily_questions
        WHERE student_id = $1 AND day = $2
        LIMIT 1
      `,
      [req.currentUser.id, today]
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
    query(
      `
        SELECT
          id,
          student_id AS "studentId",
          type,
          points,
          reason,
          delta,
          created_by AS "createdBy",
          created_at AS "createdAt"
        FROM point_logs
        WHERE student_id = $1
        ORDER BY created_at DESC
        LIMIT 20
      `,
      [req.currentUser.id]
    ),
    query(`SELECT id, name FROM categories`)
  ]);

  const categories = categoriesRes.rows;
  const statuses = statusesRes.rows;
  const allTasks = tasksRes.rows.map(mapTask);

  const activeTasks = allTasks
    .filter((task) => !task.isArchived)
    .sort((a, b) => {
      const aDate = getTaskSortDate(a);
      const bDate = getTaskSortDate(b);
      if (aDate !== bDate) return aDate.localeCompare(bDate);
      return String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
    })
    .map((task) => {
      const category = categories.find((c) => c.id === task.categoryId);
      const status = statuses.find((s) => s.taskId === task.id);
      return {
        ...task,
        categoryName: category ? category.name : 'Kategori Yok',
        scheduleText: formatTaskSchedule(task),
        todayStatus: status || null
      };
    });

  const doneCount = activeTasks.filter((t) => t.todayStatus && t.todayStatus.status === 'done').length;
  const pointLogs = pointLogsRes.rows.map((row) => ({ ...row, createdDate: toDateOnly(row.createdAt) }));
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
    questionEntry: todayQuestionRes.rowCount ? todayQuestionRes.rows[0] : null,
    questionHistory,
    calendar,
    pointLogs,
    message: req.query.message || null,
    error: req.query.error || null
  };
}

app.get('/student', requireRole('student'), (req, res) => res.redirect('/student/dashboard'));

app.get(
  '/student/:page',
  requireRole('student'),
  asyncHandler(async (req, res) => {
    const allowedPages = new Set(['dashboard', 'questions', 'points', 'calendar']);
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
    workbook.creator = 'Ogrenci Takip';
    workbook.created = new Date();

    const sheet = workbook.addWorksheet('Haftalik Takvim');
    sheet.columns = [
      { header: 'Gun', key: 'dayName', width: 14 },
      { header: 'Tarih', key: 'date', width: 13 },
      { header: 'Gorev', key: 'dueCount', width: 10 },
      { header: 'Tamamlanan', key: 'doneCount', width: 12 },
      { header: 'Tamamlanmayan', key: 'notDoneCount', width: 14 },
      { header: 'Soru', key: 'questionTotal', width: 10 },
      { header: 'Sure (dk)', key: 'durationMinutes', width: 11 },
      { header: 'Gorev Basliklari', key: 'taskTitles', width: 54 }
    ];

    sheet.getRow(1).font = { bold: true };
    sheet.views = [{ state: 'frozen', ySplit: 1 }];

    calendar.days.forEach((day) => {
      sheet.addRow({
        dayName: day.dayName,
        date: day.date,
        dueCount: day.dueCount,
        doneCount: day.doneCount,
        notDoneCount: Math.max(day.dueCount - day.doneCount, 0),
        questionTotal: day.questionTotal,
        durationMinutes: day.durationMinutes,
        taskTitles: day.tasks.length
          ? day.tasks
              .map((task) => {
                if (task.status === 'done') return `${task.title} (Yapildi)`;
                if (task.status === 'not_done') return `${task.title} (Yapilmadi)`;
                return `${task.title} (Isaretlenmedi)`;
              })
              .join(', ')
          : '-'
      });
    });

    sheet.addRow({});
    const summaryLabelRow = sheet.addRow({
      dayName: 'Hafta Ozeti',
      dueCount: calendar.days.reduce((sum, day) => sum + day.dueCount, 0),
      doneCount: calendar.days.reduce((sum, day) => sum + day.doneCount, 0),
      notDoneCount: calendar.days.reduce((sum, day) => sum + Math.max(day.dueCount - day.doneCount, 0), 0),
      questionTotal: calendar.days.reduce((sum, day) => sum + day.questionTotal, 0),
      durationMinutes: calendar.days.reduce((sum, day) => sum + day.durationMinutes, 0),
      taskTitles: `${calendar.weekStart} - ${calendar.weekEnd}`
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
  '/student/tasks/:taskId/status',
  requireRole('student'),
  asyncHandler(async (req, res) => {
    const { taskId } = req.params;
    const status = normalizeText(req.body.status);
    const note = normalizeText(req.body.note);
    const today = todayDateString();

    if (!['done', 'not_done'].includes(status)) {
      return res.redirect('/student/dashboard?error=Gecersiz%20durum.');
    }

    const taskRes = await query(
      `SELECT id FROM tasks WHERE id = $1 AND student_id = $2 AND is_archived = false LIMIT 1`,
      [taskId, req.currentUser.id]
    );

    if (taskRes.rowCount === 0) {
      return res.redirect('/student/dashboard?error=Gorev%20bulunamadi.');
    }

    await query(
      `
        INSERT INTO task_statuses (id, task_id, student_id, day, status, note)
        VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT (task_id, student_id, day)
        DO UPDATE SET status = EXCLUDED.status, note = EXCLUDED.note, updated_at = NOW()
      `,
      [makeId('status'), taskId, req.currentUser.id, today, status, note]
    );

    return res.redirect('/student/dashboard?message=Gorev%20durumu%20guncellendi.');
  })
);

app.post(
  '/student/questions',
  requireRole('student'),
  asyncHandler(async (req, res) => {
    const categoryId = normalizeText(req.body.categoryId);
    const lessonName = normalizeText(req.body.lessonName);
    const day = normalizeText(req.body.day) || todayDateString();
    const correctCount = Number(req.body.correctCount);
    const wrongCount = Number(req.body.wrongCount);
    const durationMinutes = Number(req.body.durationMinutes);

    if (!categoryId || !lessonName) {
      return res.redirect('/student/questions?error=Kategori%20ve%20ders%20adi%20zorunlu.');
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      return res.redirect('/student/questions?error=Tarih%20formati%20gecersiz.');
    }

    if (!Number.isInteger(correctCount) || correctCount < 0) {
      return res.redirect('/student/questions?error=Dogru%20sayisi%20gecersiz.');
    }

    if (!Number.isInteger(wrongCount) || wrongCount < 0) {
      return res.redirect('/student/questions?error=Yanlis%20sayisi%20gecersiz.');
    }

    if (!Number.isInteger(durationMinutes) || durationMinutes < 0) {
      return res.redirect('/student/questions?error=Sure%20gecersiz.');
    }

    const categoryRes = await query(`SELECT id FROM categories WHERE id = $1 LIMIT 1`, [categoryId]);
    if (categoryRes.rowCount === 0) {
      return res.redirect('/student/questions?error=Kategori%20bulunamadi.');
    }

    await query(
      `
        INSERT INTO daily_questions (
          id, student_id, day, category_id, lesson_name, correct_count, wrong_count, duration_minutes, count, note
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'')
        ON CONFLICT (student_id, day)
        DO UPDATE SET
          category_id = EXCLUDED.category_id,
          lesson_name = EXCLUDED.lesson_name,
          correct_count = EXCLUDED.correct_count,
          wrong_count = EXCLUDED.wrong_count,
          duration_minutes = EXCLUDED.duration_minutes,
          count = EXCLUDED.count,
          updated_at = NOW()
      `,
      [makeId('q'), req.currentUser.id, day, categoryId, lessonName, correctCount, wrongCount, durationMinutes, correctCount + wrongCount]
    );

    return res.redirect('/student/questions?message=Gunluk%20soru%20kaydi%20guncellendi.');
  })
);

app.use((req, res) => {
  res.status(404).send('Sayfa bulunamadi.');
});

app.use((err, req, res, _next) => {
  console.error('Uygulama hatasi:', err);

  if (req.path.startsWith('/admin')) {
    return adminRedirect(req, res, { error: 'Beklenmeyen bir hata olustu.' });
  }

  if (req.path.startsWith('/student')) {
    return res.redirect('/student/dashboard?error=Beklenmeyen%20bir%20hata%20olustu.');
  }

  if (req.path === '/login') {
    return res.status(500).render('login', { error: 'Beklenmeyen bir hata olustu.' });
  }

  return res.status(500).send('Sunucu hatasi.');
});

async function bootstrap() {
  await initDb();
  await seedAdmin();

  const port = Number(process.env.PORT || 3000);
  app.listen(port, () => {
    console.log(`Sunucu calisiyor: http://localhost:${port}`);
  });
}

bootstrap().catch((err) => {
  console.error('Baslatma hatasi:', err);
  process.exit(1);
});
