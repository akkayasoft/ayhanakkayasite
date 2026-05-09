const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
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

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Cok fazla giris denemesi yaptiniz. Lutfen daha sonra tekrar deneyin.'
});

app.use(
  session({
    secret: process.env.SESSION_SECRET || 'degistir-beni-session-secret',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 1000 * 60 * 60 * 12
    }
  })
);

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

function todayDateString() {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
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
  if (task.repeatType === 'weekly') return `Haftalik (Gun ${task.weeklyDay})`;
  if (task.repeatType === 'monthly') return `Aylik (Gun ${task.monthlyDay})`;
  if (task.repeatType === 'custom') return `Ozel (${(task.customDates || []).join(', ')})`;
  return '-';
}

function isTaskDueOnDate(task, dateObj, dateStr) {
  if (task.isArchived) return false;
  if (task.startDate && dateStr < task.startDate) return false;
  if (task.endDate && dateStr > task.endDate) return false;

  if (task.repeatType === 'once') return task.singleDate === dateStr;
  if (task.repeatType === 'weekly') return Number(task.weeklyDay) === dateObj.getDay();
  if (task.repeatType === 'monthly') return Number(task.monthlyDay) === dateObj.getDate();
  if (task.repeatType === 'custom') return Array.isArray(task.customDates) && task.customDates.includes(dateStr);

  return false;
}

function adminRedirect(res, queryParams) {
  const params = new URLSearchParams(queryParams);
  const queryString = params.toString();
  return res.redirect(queryString ? `/admin?${queryString}` : '/admin');
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
  if (req.currentUser.role === 'admin') return res.redirect('/admin');
  return res.redirect('/student');
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

app.get(
  '/admin',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const [studentsRes, categoriesRes, tasksRes, pointLogsRes] = await Promise.all([
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

    const students = studentsRes.rows.map(mapUser);
    const categories = categoriesRes.rows;
    const tasks = tasksRes.rows.map(mapTask).map((task) => ({
      ...task,
      student: students.find((s) => s.id === task.studentId) || null,
      category: categories.find((c) => c.id === task.categoryId) || null,
      repeatText: formatRepeat(task)
    }));

    const pointLogs = pointLogsRes.rows.map((row) => ({
      ...row,
      createdAt: row.createdAt,
      createdDate: toDateOnly(row.createdAt)
    }));

    const today = todayDateString();

    const todayStatusesRes = await query(
      `
        SELECT task_id AS "taskId", student_id AS "studentId", status
        FROM task_statuses
        WHERE day = $1
      `,
      [today]
    );

    const todayQuestionsRes = await query(
      `
        SELECT student_id AS "studentId", count
        FROM daily_questions
        WHERE day = $1
      `,
      [today]
    );

    const statusRows = todayStatusesRes.rows;
    const questionRows = todayQuestionsRes.rows;

    const dailyBoard = students.map((student) => {
      const dateObj = new Date(`${today}T00:00:00`);
      const dueTasks = tasks.filter((t) => t.studentId === student.id && isTaskDueOnDate(t, dateObj, today));
      const doneCount = statusRows.filter(
        (st) => st.studentId === student.id && st.status === 'done' && dueTasks.some((t) => t.id === st.taskId)
      ).length;

      const question = questionRows.find((q) => q.studentId === student.id);

      return {
        ...student,
        dueCount: dueTasks.length,
        doneCount,
        questionCount: question ? Number(question.count || 0) : 0
      };
    });

    const reportStudentId = normalizeText(req.query.reportStudentId);
    const reportRange = parseDateRange(normalizeText(req.query.reportFrom), normalizeText(req.query.reportTo));
    const selectedStudent = students.find((s) => s.id === reportStudentId) || null;

    let report = null;

    if (selectedStudent && !reportRange.error) {
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
            SELECT student_id AS "studentId", day, count
            FROM daily_questions
            WHERE student_id = $1 AND day BETWEEN $2 AND $3
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
      const rangeStatuses = rangeStatusesRes.rows;
      const rangeQuestions = rangeQuestionsRes.rows;
      const rangePoints = rangePointsRes.rows;

      const rows = reportRange.days.map((dateStr) => {
        const dateObj = new Date(`${dateStr}T00:00:00`);
        const dueTasks = taskPool.filter((t) => isTaskDueOnDate(t, dateObj, dateStr));

        const doneCount = rangeStatuses.filter(
          (st) =>
            toDateOnly(st.day) === dateStr &&
            st.status === 'done' &&
            dueTasks.some((task) => task.id === st.taskId)
        ).length;

        const question = rangeQuestions.find((q) => toDateOnly(q.day) === dateStr);
        const dayPointDelta = rangePoints
          .filter((p) => toDateOnly(p.createdAt) === dateStr)
          .reduce((sum, p) => sum + Number(p.delta || 0), 0);

        return {
          date: dateStr,
          dueCount: dueTasks.length,
          doneCount,
          notDoneCount: Math.max(dueTasks.length - doneCount, 0),
          questionCount: question ? Number(question.count || 0) : 0,
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

    return res.render('admin', {
      user: req.currentUser,
      students,
      categories,
      tasks,
      activeTasks: tasks.filter((t) => !t.isArchived),
      archivedTasks: tasks.filter((t) => t.isArchived),
      pointLogs,
      dailyBoard,
      report,
      reportError: reportRange.error,
      reportFilters: {
        studentId: reportStudentId,
        fromDate: reportRange.fromDate || '',
        toDate: reportRange.toDate || ''
      },
      message: req.query.message || null,
      error: req.query.error || null,
      today
    });
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
      return adminRedirect(res, { error: 'Ogrenci bilgileri eksik.' });
    }

    if (password.length < 6) {
      return adminRedirect(res, { error: 'Sifre en az 6 karakter olmali.' });
    }

    const exists = await query(`SELECT id FROM users WHERE username = $1 LIMIT 1`, [username]);
    if (exists.rowCount > 0) {
      return adminRedirect(res, { error: 'Bu kullanici adi zaten var.' });
    }

    await query(
      `
        INSERT INTO users (id, name, username, password_hash, role, points)
        VALUES ($1, $2, $3, $4, 'student', 0)
      `,
      [makeId('user'), name, username, bcrypt.hashSync(password, 10)]
    );

    return adminRedirect(res, { message: 'Ogrenci eklendi.' });
  })
);

app.post(
  '/admin/categories',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const name = normalizeText(req.body.name);

    if (!name) {
      return adminRedirect(res, { error: 'Kategori adi zorunlu.' });
    }

    try {
      await query(
        `INSERT INTO categories (id, name) VALUES ($1, $2)`,
        [makeId('cat'), name]
      );
    } catch (err) {
      if (err.code === '23505') {
        return adminRedirect(res, { error: 'Bu kategori zaten var.' });
      }
      throw err;
    }

    return adminRedirect(res, { message: 'Kategori eklendi.' });
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
      return adminRedirect(res, { error: 'Bu kategori aktif gorevlerde kullaniliyor.' });
    }

    const deleted = await query(`DELETE FROM categories WHERE id = $1`, [categoryId]);

    if (deleted.rowCount === 0) {
      return adminRedirect(res, { error: 'Kategori bulunamadi.' });
    }

    return adminRedirect(res, { message: 'Kategori silindi.' });
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
      return adminRedirect(res, { error: 'Gorev icin zorunlu alanlar eksik.' });
    }

    if (startDate && endDate && startDate > endDate) {
      return adminRedirect(res, { error: 'Baslangic tarihi bitis tarihinden buyuk olamaz.' });
    }

    const [categoryRes, studentRes] = await Promise.all([
      query(`SELECT id FROM categories WHERE id = $1`, [categoryId]),
      query(`SELECT id FROM users WHERE id = $1 AND role = 'student'`, [studentId])
    ]);

    if (categoryRes.rowCount === 0 || studentRes.rowCount === 0) {
      return adminRedirect(res, { error: 'Kategori veya ogrenci gecersiz.' });
    }

    let singleDateVal = null;
    let weeklyDayVal = null;
    let monthlyDayVal = null;
    let customDatesVal = [];

    if (repeatType === 'once') {
      if (!singleDate) {
        return adminRedirect(res, { error: 'Tek seferlik gorev icin tarih zorunlu.' });
      }
      singleDateVal = singleDate;
    } else if (repeatType === 'weekly') {
      if (weeklyDay === '') {
        return adminRedirect(res, { error: 'Haftalik gorev icin gun zorunlu.' });
      }
      weeklyDayVal = Number(weeklyDay);
    } else if (repeatType === 'monthly') {
      if (!monthlyDay) {
        return adminRedirect(res, { error: 'Aylik gorev icin gun zorunlu.' });
      }
      monthlyDayVal = Number(monthlyDay);
    } else if (repeatType === 'custom') {
      const parsedDates = customDates
        .split(',')
        .map((d) => d.trim())
        .filter(Boolean);

      if (!parsedDates.length) {
        return adminRedirect(res, { error: 'Ozel tarihli gorev icin en az bir tarih girin.' });
      }
      customDatesVal = parsedDates;
    } else {
      return adminRedirect(res, { error: 'Gecersiz tekrar tipi.' });
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

    return adminRedirect(res, { message: 'Gorev olusturuldu.' });
  })
);

app.post(
  '/admin/tasks/:taskId/archive',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const { taskId } = req.params;
    const updated = await query(`UPDATE tasks SET is_archived = true WHERE id = $1`, [taskId]);

    if (updated.rowCount === 0) {
      return adminRedirect(res, { error: 'Gorev bulunamadi.' });
    }

    return adminRedirect(res, { message: 'Gorev arsive alindi.' });
  })
);

app.post(
  '/admin/tasks/:taskId/unarchive',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const { taskId } = req.params;
    const updated = await query(`UPDATE tasks SET is_archived = false WHERE id = $1`, [taskId]);

    if (updated.rowCount === 0) {
      return adminRedirect(res, { error: 'Gorev bulunamadi.' });
    }

    return adminRedirect(res, { message: 'Gorev yeniden aktiflesti.' });
  })
);

app.post(
  '/admin/points',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const studentId = normalizeText(req.body.studentId);
    const type = normalizeText(req.body.type);
    const reason = normalizeText(req.body.reason);
    const parsedPoints = Number(req.body.points);

    if (!studentId || !type || !parsedPoints || !reason) {
      return adminRedirect(res, { error: 'Odul/ceza alanlari eksik.' });
    }

    if (!['reward', 'penalty'].includes(type)) {
      return adminRedirect(res, { error: 'Gecersiz puan tipi.' });
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
        return adminRedirect(res, { error: 'Ogrenci bulunamadi.' });
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

    return adminRedirect(res, { message: 'Puan islemi kaydedildi.' });
  })
);

app.get(
  '/student',
  requireRole('student'),
  asyncHandler(async (req, res) => {
    const today = todayDateString();
    const dateObj = new Date(`${today}T00:00:00`);

    const [tasksRes, statusesRes, questionRes, pointLogsRes] = await Promise.all([
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
          SELECT id, student_id AS "studentId", day, count, note
          FROM daily_questions
          WHERE student_id = $1 AND day = $2
          LIMIT 1
        `,
        [req.currentUser.id, today]
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
      )
    ]);

    const categoriesRes = await query(`SELECT id, name FROM categories`);

    const categories = categoriesRes.rows;
    const statuses = statusesRes.rows;

    const tasksForToday = tasksRes.rows
      .map(mapTask)
      .filter((task) => isTaskDueOnDate(task, dateObj, today))
      .map((task) => {
        const category = categories.find((c) => c.id === task.categoryId);
        const status = statuses.find((s) => s.taskId === task.id);

        return {
          ...task,
          categoryName: category ? category.name : 'Kategori Yok',
          todayStatus: status || null
        };
      });

    const doneCount = tasksForToday.filter((t) => t.todayStatus && t.todayStatus.status === 'done').length;

    const pointLogs = pointLogsRes.rows.map((row) => ({
      ...row,
      createdDate: toDateOnly(row.createdAt)
    }));

    return res.render('student', {
      user: req.currentUser,
      today,
      tasksForToday,
      doneCount,
      questionEntry: questionRes.rowCount ? questionRes.rows[0] : null,
      pointLogs,
      message: req.query.message || null,
      error: req.query.error || null
    });
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
      return res.redirect('/student?error=Gecersiz%20durum.');
    }

    const taskRes = await query(
      `SELECT id FROM tasks WHERE id = $1 AND student_id = $2 AND is_archived = false LIMIT 1`,
      [taskId, req.currentUser.id]
    );

    if (taskRes.rowCount === 0) {
      return res.redirect('/student?error=Gorev%20bulunamadi.');
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

    return res.redirect('/student?message=Gorev%20durumu%20guncellendi.');
  })
);

app.post(
  '/student/questions',
  requireRole('student'),
  asyncHandler(async (req, res) => {
    const parsedCount = Number(req.body.count);
    const note = normalizeText(req.body.note);
    const today = todayDateString();

    if (!Number.isFinite(parsedCount) || parsedCount < 0) {
      return res.redirect('/student?error=Soru%20sayisi%20gecersiz.');
    }

    await query(
      `
        INSERT INTO daily_questions (id, student_id, day, count, note)
        VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT (student_id, day)
        DO UPDATE SET count = EXCLUDED.count, note = EXCLUDED.note, updated_at = NOW()
      `,
      [makeId('q'), req.currentUser.id, today, parsedCount, note]
    );

    return res.redirect('/student?message=Gunluk%20soru%20kaydi%20guncellendi.');
  })
);

app.use((req, res) => {
  res.status(404).send('Sayfa bulunamadi.');
});

app.use((err, req, res, _next) => {
  console.error('Uygulama hatasi:', err);

  if (req.path.startsWith('/admin')) {
    return adminRedirect(res, { error: 'Beklenmeyen bir hata olustu.' });
  }

  if (req.path.startsWith('/student')) {
    return res.redirect('/student?error=Beklenmeyen%20bir%20hata%20olustu.');
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
