const path = require('path');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { readDb, writeDb, makeId } = require('./store');
const { seedAdmin } = require('./seed');

const app = express();

seedAdmin();

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

function todayDateString() {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function shiftDate(dateStr, offsetDays) {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + offsetDays);
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function formatRepeat(task) {
  if (task.repeatType === 'once') return `Tek seferlik (${task.singleDate || '-'})`;
  if (task.repeatType === 'weekly') return `Haftalik (Gun ${task.weeklyDay})`;
  if (task.repeatType === 'monthly') return `Aylik (Gun ${task.monthlyDay})`;
  if (task.repeatType === 'custom') return `Ozel (${(task.customDates || []).join(', ')})`;
  return '-';
}

function normalizeText(value) {
  return String(value || '').trim();
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

function isTaskDueOnDate(task, dateObj, dateStr) {
  if (task.isArchived) return false;
  if (task.startDate && dateStr < task.startDate) return false;
  if (task.endDate && dateStr > task.endDate) return false;

  if (task.repeatType === 'once') {
    return task.singleDate === dateStr;
  }

  if (task.repeatType === 'weekly') {
    return Number(task.weeklyDay) === dateObj.getDay();
  }

  if (task.repeatType === 'monthly') {
    return Number(task.monthlyDay) === dateObj.getDate();
  }

  if (task.repeatType === 'custom') {
    return Array.isArray(task.customDates) && task.customDates.includes(dateStr);
  }

  return false;
}

function adminRedirect(res, query) {
  const params = new URLSearchParams(query);
  const queryString = params.toString();
  return res.redirect(queryString ? `/admin?${queryString}` : '/admin');
}

function requireAuth(req, res, next) {
  if (!req.session.userId) {
    return res.redirect('/login');
  }
  return next();
}

function requireRole(role) {
  return (req, res, next) => {
    if (!req.session.userId) {
      return res.redirect('/login');
    }

    const data = readDb();
    const user = data.users.find((u) => u.id === req.session.userId);

    if (!user || user.role !== role) {
      return res.status(403).send('Yetkisiz erisim.');
    }

    req.currentUser = user;
    return next();
  };
}

app.get('/', requireAuth, (req, res) => {
  const data = readDb();
  const user = data.users.find((u) => u.id === req.session.userId);

  if (!user) {
    req.session.destroy(() => res.redirect('/login'));
    return;
  }

  if (user.role === 'admin') {
    return res.redirect('/admin');
  }

  return res.redirect('/student');
});

app.get('/login', (req, res) => {
  if (req.session.userId) {
    return res.redirect('/');
  }

  return res.render('login', { error: null });
});

app.post('/login', loginLimiter, (req, res) => {
  const username = normalizeText(req.body.username);
  const password = normalizeText(req.body.password);

  const data = readDb();
  const user = data.users.find((u) => u.username === username);

  if (!user || !bcrypt.compareSync(password, user.passwordHash)) {
    return res.status(401).render('login', { error: 'Kullanici adi veya sifre hatali.' });
  }

  req.session.userId = user.id;
  return res.redirect('/');
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login');
  });
});

app.get('/admin', requireRole('admin'), (req, res) => {
  const data = readDb();
  const students = data.users.filter((u) => u.role === 'student');
  const categories = data.categories;
  const tasks = data.tasks.map((task) => ({
    ...task,
    student: students.find((s) => s.id === task.studentId) || null,
    category: categories.find((c) => c.id === task.categoryId) || null,
    repeatText: formatRepeat(task)
  }));

  const today = todayDateString();

  const reportStudentId = normalizeText(req.query.reportStudentId);
  const reportRange = parseDateRange(normalizeText(req.query.reportFrom), normalizeText(req.query.reportTo));

  const selectedStudent = students.find((s) => s.id === reportStudentId) || null;
  let report = null;

  if (selectedStudent && !reportRange.error) {
    const rows = reportRange.days.map((dateStr) => {
      const dateObj = new Date(`${dateStr}T00:00:00`);
      const dueTasks = data.tasks.filter(
        (t) => t.studentId === selectedStudent.id && isTaskDueOnDate(t, dateObj, dateStr)
      );

      const doneCount = data.taskStatuses.filter(
        (st) =>
          st.studentId === selectedStudent.id &&
          st.date === dateStr &&
          st.status === 'done' &&
          dueTasks.some((t) => t.id === st.taskId)
      ).length;

      const question = data.dailyQuestions.find(
        (q) => q.studentId === selectedStudent.id && q.date === dateStr
      );

      const dayPointDelta = data.pointLogs
        .filter((p) => p.studentId === selectedStudent.id && p.createdAt.slice(0, 10) === dateStr)
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

  const dailyBoard = students.map((student) => {
    const dateObj = new Date(`${today}T00:00:00`);
    const dueTasks = data.tasks.filter((t) => t.studentId === student.id && isTaskDueOnDate(t, dateObj, today));
    const doneCount = data.taskStatuses.filter(
      (st) =>
        st.studentId === student.id &&
        st.date === today &&
        st.status === 'done' &&
        dueTasks.some((t) => t.id === st.taskId)
    ).length;

    const question = data.dailyQuestions.find((q) => q.studentId === student.id && q.date === today);

    return {
      ...student,
      dueCount: dueTasks.length,
      doneCount,
      questionCount: question ? Number(question.count || 0) : 0
    };
  });

  return res.render('admin', {
    user: req.currentUser,
    students,
    categories,
    tasks,
    activeTasks: tasks.filter((t) => !t.isArchived),
    archivedTasks: tasks.filter((t) => t.isArchived),
    pointLogs: data.pointLogs.slice(-20).reverse(),
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
});

app.post('/admin/students', requireRole('admin'), (req, res) => {
  const name = normalizeText(req.body.name);
  const username = normalizeText(req.body.username);
  const password = normalizeText(req.body.password);

  if (!name || !username || !password) {
    return adminRedirect(res, { error: 'Ogrenci bilgileri eksik.' });
  }

  if (password.length < 6) {
    return adminRedirect(res, { error: 'Sifre en az 6 karakter olmali.' });
  }

  const data = readDb();
  const exists = data.users.some((u) => u.username === username);
  if (exists) {
    return adminRedirect(res, { error: 'Bu kullanici adi zaten var.' });
  }

  data.users.push({
    id: makeId('user'),
    name,
    username,
    passwordHash: bcrypt.hashSync(password, 10),
    role: 'student',
    points: 0,
    createdAt: new Date().toISOString()
  });

  writeDb(data);
  return adminRedirect(res, { message: 'Ogrenci eklendi.' });
});

app.post('/admin/categories', requireRole('admin'), (req, res) => {
  const name = normalizeText(req.body.name);

  if (!name) {
    return adminRedirect(res, { error: 'Kategori adi zorunlu.' });
  }

  const data = readDb();
  const exists = data.categories.some((c) => c.name.toLowerCase() === name.toLowerCase());
  if (exists) {
    return adminRedirect(res, { error: 'Bu kategori zaten var.' });
  }

  data.categories.push({
    id: makeId('cat'),
    name,
    createdAt: new Date().toISOString()
  });
  writeDb(data);

  return adminRedirect(res, { message: 'Kategori eklendi.' });
});

app.post('/admin/categories/:categoryId/delete', requireRole('admin'), (req, res) => {
  const { categoryId } = req.params;
  const data = readDb();
  const usedByTask = data.tasks.some((t) => t.categoryId === categoryId && !t.isArchived);

  if (usedByTask) {
    return adminRedirect(res, { error: 'Bu kategori aktif gorevlerde kullaniliyor.' });
  }

  const before = data.categories.length;
  data.categories = data.categories.filter((c) => c.id !== categoryId);

  if (before === data.categories.length) {
    return adminRedirect(res, { error: 'Kategori bulunamadi.' });
  }

  writeDb(data);
  return adminRedirect(res, { message: 'Kategori silindi.' });
});

app.post('/admin/tasks', requireRole('admin'), (req, res) => {
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

  const data = readDb();
  const category = data.categories.find((c) => c.id === categoryId);
  const student = data.users.find((u) => u.id === studentId && u.role === 'student');

  if (!category || !student) {
    return adminRedirect(res, { error: 'Kategori veya ogrenci gecersiz.' });
  }

  const task = {
    id: makeId('task'),
    title,
    description,
    categoryId,
    studentId,
    repeatType,
    singleDate: null,
    weeklyDay: null,
    monthlyDay: null,
    customDates: [],
    startDate: startDate || null,
    endDate: endDate || null,
    isArchived: false,
    createdBy: req.currentUser.id,
    createdAt: new Date().toISOString()
  };

  if (repeatType === 'once') {
    if (!singleDate) {
      return adminRedirect(res, { error: 'Tek seferlik gorev icin tarih zorunlu.' });
    }
    task.singleDate = singleDate;
  } else if (repeatType === 'weekly') {
    if (weeklyDay === '') {
      return adminRedirect(res, { error: 'Haftalik gorev icin gun zorunlu.' });
    }
    task.weeklyDay = Number(weeklyDay);
  } else if (repeatType === 'monthly') {
    if (!monthlyDay) {
      return adminRedirect(res, { error: 'Aylik gorev icin gun zorunlu.' });
    }
    task.monthlyDay = Number(monthlyDay);
  } else if (repeatType === 'custom') {
    const parsedDates = customDates
      .split(',')
      .map((d) => d.trim())
      .filter(Boolean);

    if (!parsedDates.length) {
      return adminRedirect(res, { error: 'Ozel tarihli gorev icin en az bir tarih girin.' });
    }

    task.customDates = parsedDates;
  } else {
    return adminRedirect(res, { error: 'Gecersiz tekrar tipi.' });
  }

  data.tasks.push(task);
  writeDb(data);

  return adminRedirect(res, { message: 'Gorev olusturuldu.' });
});

app.post('/admin/tasks/:taskId/archive', requireRole('admin'), (req, res) => {
  const { taskId } = req.params;
  const data = readDb();
  const task = data.tasks.find((t) => t.id === taskId);

  if (!task) {
    return adminRedirect(res, { error: 'Gorev bulunamadi.' });
  }

  task.isArchived = true;
  writeDb(data);
  return adminRedirect(res, { message: 'Gorev arsive alindi.' });
});

app.post('/admin/tasks/:taskId/unarchive', requireRole('admin'), (req, res) => {
  const { taskId } = req.params;
  const data = readDb();
  const task = data.tasks.find((t) => t.id === taskId);

  if (!task) {
    return adminRedirect(res, { error: 'Gorev bulunamadi.' });
  }

  task.isArchived = false;
  writeDb(data);
  return adminRedirect(res, { message: 'Gorev yeniden aktiflesti.' });
});

app.post('/admin/points', requireRole('admin'), (req, res) => {
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

  const data = readDb();
  const student = data.users.find((u) => u.id === studentId && u.role === 'student');

  if (!student) {
    return adminRedirect(res, { error: 'Ogrenci bulunamadi.' });
  }

  const delta = type === 'reward' ? Math.abs(parsedPoints) : -Math.abs(parsedPoints);
  student.points = Number(student.points || 0) + delta;

  data.pointLogs.push({
    id: makeId('plog'),
    studentId,
    type,
    points: Math.abs(parsedPoints),
    reason,
    delta,
    createdBy: req.currentUser.id,
    createdAt: new Date().toISOString()
  });

  writeDb(data);
  return adminRedirect(res, { message: 'Puan islemi kaydedildi.' });
});

app.get('/student', requireRole('student'), (req, res) => {
  const data = readDb();
  const currentUser = data.users.find((u) => u.id === req.currentUser.id);
  const today = todayDateString();
  const dateObj = new Date(`${today}T00:00:00`);

  const tasksForToday = data.tasks
    .filter((t) => t.studentId === currentUser.id)
    .filter((t) => isTaskDueOnDate(t, dateObj, today))
    .map((task) => {
      const category = data.categories.find((c) => c.id === task.categoryId);
      const status = data.taskStatuses.find(
        (s) => s.taskId === task.id && s.studentId === currentUser.id && s.date === today
      );

      return {
        ...task,
        categoryName: category ? category.name : 'Kategori Yok',
        todayStatus: status || null
      };
    });

  const doneCount = tasksForToday.filter((t) => t.todayStatus && t.todayStatus.status === 'done').length;

  const questionEntry = data.dailyQuestions.find(
    (q) => q.studentId === currentUser.id && q.date === today
  );

  const pointLogs = data.pointLogs
    .filter((p) => p.studentId === currentUser.id)
    .slice(-20)
    .reverse();

  res.render('student', {
    user: currentUser,
    today,
    tasksForToday,
    doneCount,
    questionEntry,
    pointLogs,
    message: req.query.message || null,
    error: req.query.error || null
  });
});

app.post('/student/tasks/:taskId/status', requireRole('student'), (req, res) => {
  const { taskId } = req.params;
  const status = normalizeText(req.body.status);
  const note = normalizeText(req.body.note);
  const today = todayDateString();

  if (!['done', 'not_done'].includes(status)) {
    return res.redirect('/student?error=Gecersiz%20durum.');
  }

  const data = readDb();
  const task = data.tasks.find((t) => t.id === taskId && t.studentId === req.currentUser.id);
  if (!task || task.isArchived) {
    return res.redirect('/student?error=Gorev%20bulunamadi.');
  }

  const existing = data.taskStatuses.find(
    (s) => s.taskId === taskId && s.studentId === req.currentUser.id && s.date === today
  );

  if (existing) {
    existing.status = status;
    existing.note = note;
    existing.updatedAt = new Date().toISOString();
  } else {
    data.taskStatuses.push({
      id: makeId('status'),
      taskId,
      studentId: req.currentUser.id,
      date: today,
      status,
      note,
      updatedAt: new Date().toISOString()
    });
  }

  writeDb(data);
  return res.redirect('/student?message=Gorev%20durumu%20guncellendi.');
});

app.post('/student/questions', requireRole('student'), (req, res) => {
  const parsedCount = Number(req.body.count);
  const note = normalizeText(req.body.note);
  const today = todayDateString();

  if (!Number.isFinite(parsedCount) || parsedCount < 0) {
    return res.redirect('/student?error=Soru%20sayisi%20gecersiz.');
  }

  const data = readDb();
  const existing = data.dailyQuestions.find(
    (q) => q.studentId === req.currentUser.id && q.date === today
  );

  if (existing) {
    existing.count = parsedCount;
    existing.note = note;
    existing.updatedAt = new Date().toISOString();
  } else {
    data.dailyQuestions.push({
      id: makeId('q'),
      studentId: req.currentUser.id,
      date: today,
      count: parsedCount,
      note,
      updatedAt: new Date().toISOString()
    });
  }

  writeDb(data);
  return res.redirect('/student?message=Gunluk%20soru%20kaydi%20guncellendi.');
});

app.use((req, res) => {
  res.status(404).send('Sayfa bulunamadi.');
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(`Sunucu calisiyor: http://localhost:${port}`);
});
