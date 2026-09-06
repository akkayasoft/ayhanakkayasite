const fs = require('fs');
const path = require('path');

/**
 * yds.obs (akkayasoft/yds-yokdil-app) ilerleme durumunu okur.
 *
 * YDS uygulamasi cihazlar arasi senkron icin VPS'te minik bir Node servisi
 * calistirir (server/yds-api). Servis kullanici basina tek bir JSON dosyasi
 * tutar; takip.obs AYNI SUNUCUDA oldugu icin dosyayi dogrudan okur —
 * boylece ne HTTP'ye ne de Basic Auth sifresini burada saklamaya gerek kalir.
 *
 * Dosya bicimi YDS uygulamasindaki app/src/sync.ts icindeki `Blob` tipidir;
 * uygulamanin kendisi tek yazicidir.
 */

const DEFAULT_STATE_FILE = '/var/www/yds-api/data/state-ayhan.json';
const SOURCE_PREFIX = 'yds';

function stateFilePath() {
  return process.env.YDS_STATE_FILE || DEFAULT_STATE_FILE;
}

function sourceKey(dateStr) {
  return `${SOURCE_PREFIX}:${dateStr}`;
}

function sayi(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function benzersizSayi(value) {
  return Array.isArray(value) ? new Set(value.filter(Boolean).map(String)).size : 0;
}

function isDateOnly(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/**
 * State dosyasini okur ve normalize eder.
 * Basarisizlikta uygulamayi patlatmaz; { ok: false, reason } doner.
 */
function readYdsState(filePath = stateFilePath()) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    return {
      ok: false,
      filePath,
      reason:
        err.code === 'ENOENT'
          ? 'Durum dosyası bulunamadı.'
          : `Durum dosyası okunamadı: ${err.code || err.message}`
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, filePath, reason: `Durum dosyası geçerli JSON değil: ${err.message}` };
  }

  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, filePath, reason: 'Durum dosyası beklenen biçimde değil.' };
  }

  const gunler = [];
  const ham = parsed.days && typeof parsed.days === 'object' ? parsed.days : {};
  for (const [tarih, deger] of Object.entries(ham)) {
    if (!isDateOnly(tarih) || !deger || typeof deger !== 'object') continue;
    const solved = sayi(deger.questionsSolved);
    const scored = Math.min(sayi(deger.scoredQuestions), solved);
    const correct = Math.min(sayi(deger.questionsCorrect), scored);
    gunler.push({
      date: tarih,
      sourceKey: sourceKey(tarih),
      lessons: benzersizSayi(deger.lessons),
      decks: benzersizSayi(deger.decks),
      quizzes: benzersizSayi(deger.quizzes),
      readings: benzersizSayi(deger.readings),
      wordsLearned: sayi(deger.wordsLearned),
      questionsSolved: solved,
      // Dilbilgisi testleri puansiz (scored:false) oldugu icin cozulen sorularin
      // yalnizca bir kismi dogruluk hesabina girer. scoredQuestions bu paydadir.
      scoredQuestions: scored,
      questionsCorrect: correct,
      questionsWrong: Math.max(0, scored - correct)
    });
  }
  gunler.sort((a, b) => (a.date < b.date ? 1 : -1));

  const hedefler = parsed.goals && typeof parsed.goals === 'object' ? parsed.goals : {};
  const seri = parsed.streak && typeof parsed.streak === 'object' ? parsed.streak : {};

  return {
    ok: true,
    filePath,
    days: gunler,
    goals: {
      okuma: sayi(hedefler.okuma),
      kelime: sayi(hedefler.kelime),
      gramer: sayi(hedefler.gramer),
      test: sayi(hedefler.test)
    },
    streak: {
      count: sayi(seri.count),
      max: sayi(seri.max),
      lastDay: isDateOnly(seri.lastDay) ? seri.lastDay : null
    },
    planStart: isDateOnly(parsed.planStart) ? parsed.planStart : null,
    learnedCards: benzersizSayi(parsed.learnedCards),
    resetAt: sayi(parsed.resetAt)
  };
}

/** Bir gunun hedefleri tutturup tutturmadigi (YDS app'teki goalStatus ile ayni mantik). */
function goalStatus(gun, goals) {
  const eslesme = {
    okuma: gun.readings,
    kelime: gun.decks,
    gramer: gun.lessons,
    test: gun.quizzes
  };
  const aktif = ['okuma', 'kelime', 'gramer', 'test'].filter((k) => goals[k] > 0);
  const tutan = aktif.filter((k) => eslesme[k] >= goals[k]);
  return {
    activeCount: aktif.length,
    doneCount: tutan.length,
    allDone: aktif.length > 0 && tutan.length === aktif.length
  };
}

module.exports = {
  DEFAULT_STATE_FILE,
  SOURCE_PREFIX,
  stateFilePath,
  sourceKey,
  readYdsState,
  goalStatus
};
