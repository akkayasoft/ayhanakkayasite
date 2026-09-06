const fs = require('fs');
const path = require('path');

const PROGRAM_PATH = path.join(__dirname, 'data', 'yzProgram.json');

// Gorev satirlarinda kaynak anahtari olarak kullanilir: tasks.source_key.
// Ayni ogrenciye ayni ders ikinci kez eklenmez (bkz. db.js'teki unique index).
const SOURCE_PREFIX = 'yz';

let cache = null;

function sourceKey(dersId) {
  return `${SOURCE_PREFIX}:${dersId}`;
}

/**
 * scripts/yz-program-uret.js ile uretilen mufredat programini okur.
 * Dosya yoksa (veya bozuksa) uygulama patlamamali; bos program doner.
 */
function loadYzProgram() {
  if (cache) return cache;

  try {
    const raw = fs.readFileSync(PROGRAM_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    const gorevler = Array.isArray(parsed.gorevler) ? parsed.gorevler : [];

    cache = {
      surum: parsed.surum || '',
      baslangic: parsed.baslangic || null,
      bitis: parsed.bitis || null,
      kaynak: parsed.kaynak || '',
      toplamDers: Number(parsed.toplamDers) || gorevler.length,
      gorevler: gorevler
        .filter((g) => g && g.dersId && g.baslik && g.tarih && g.kursAd)
        .map((g) => ({
          dersId: String(g.dersId),
          sourceKey: sourceKey(g.dersId),
          baslik: String(g.baslik),
          sure: Number(g.sure) || 0,
          kurs: String(g.kurs || ''),
          kursAd: String(g.kursAd),
          tarih: String(g.tarih)
        }))
    };
  } catch (err) {
    console.error('YZ programi okunamadi:', err.message);
    cache = { surum: '', baslangic: null, bitis: null, kaynak: '', toplamDers: 0, gorevler: [] };
  }

  return cache;
}

/** Bir ders satirindan gorev aciklamasi uretir. */
function describeLesson(lesson) {
  const parcalar = [lesson.kursAd];
  if (lesson.sure) parcalar.push(`${lesson.sure} dk`);
  parcalar.push(`yapayzeka.obs · ${lesson.dersId}`);
  return parcalar.join(' · ');
}

module.exports = {
  PROGRAM_PATH,
  SOURCE_PREFIX,
  sourceKey,
  loadYzProgram,
  describeLesson
};
