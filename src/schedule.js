/**
 * Okul ders programi yardimcilari.
 *
 * Zil saatleri SAKLANMAZ, hesaplanir: baslangic saati + ders/teneffus/ogle
 * sureleri verilir, her ders saatinin baslangic-bitisi bunlardan turetilir.
 * Boylece "8. ders kacta baslar" sorusunun tek dogru cevabi olur ve saatler
 * elle girilirken kaymaz.
 */

const GUN_ADLARI = ['', 'Pazartesi', 'Salı', 'Çarşamba', 'Perşembe', 'Cuma'];

const VARSAYILAN_AYAR = {
  startTime: '08:00',
  lessonMinutes: 40,
  breakMinutes: 10,
  periodCount: 10,
  lunchAfterPeriod: 6,
  lunchMinutes: 40
};

function hmToMinutes(hm) {
  if (typeof hm !== 'string') return null;
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

/**
 * Ders saati listesi: her biri { period, start, end, lunchAfter }.
 * lunchAfter = bu dersten sonra ogle arasi var mi.
 */
function buildPeriods(ayar = VARSAYILAN_AYAR) {
  const baslangic = hmToMinutes(ayar.startTime) ?? hmToMinutes(VARSAYILAN_AYAR.startTime);
  const dersDk = Number(ayar.lessonMinutes) || VARSAYILAN_AYAR.lessonMinutes;
  const tenDk = Number.isFinite(Number(ayar.breakMinutes)) ? Number(ayar.breakMinutes) : VARSAYILAN_AYAR.breakMinutes;
  const adet = Number(ayar.periodCount) || VARSAYILAN_AYAR.periodCount;
  const ogleSonra = Number(ayar.lunchAfterPeriod) || null;
  const ogleDk = Number.isFinite(Number(ayar.lunchMinutes)) ? Number(ayar.lunchMinutes) : VARSAYILAN_AYAR.lunchMinutes;

  const saatler = [];
  let imlec = baslangic;
  for (let i = 1; i <= adet; i += 1) {
    const bas = imlec;
    const son = bas + dersDk;
    const ogleVar = ogleSonra === i && i < adet;
    saatler.push({
      period: i,
      start: minutesToHm(bas),
      end: minutesToHm(son),
      lunchAfter: ogleVar
    });
    imlec = son + (i < adet ? (ogleVar ? ogleDk : tenDk) : 0);
  }
  return saatler;
}

/** Gunun bitis saati (son dersin bitisi). */
function endOfDay(ayar = VARSAYILAN_AYAR) {
  const saatler = buildPeriods(ayar);
  return saatler.length ? saatler[saatler.length - 1].end : ayar.startTime;
}

/** Bir tarihin haftanin kacinci gunu oldugu (1=Pzt ... 5=Cuma, hafta sonu 0). */
function dayOfWeek(dateStr) {
  const gun = new Date(`${dateStr}T00:00:00Z`).getUTCDay();
  return gun >= 1 && gun <= 5 ? gun : 0;
}

/**
 * Haftalik izgara: satir = ders saati, sutun = gun.
 * entries -> class_schedule satirlari (gun/saat ile eslenmis).
 */
function buildGrid(entries, ayar = VARSAYILAN_AYAR) {
  const saatler = buildPeriods(ayar);
  const kayitByKey = new Map(entries.map((e) => [`${e.dayOfWeek}:${e.period}`, e]));

  return saatler.map((saat) => ({
    ...saat,
    hucreler: [1, 2, 3, 4, 5].map((gun) => ({
      dayOfWeek: gun,
      gunAdi: GUN_ADLARI[gun],
      entry: kayitByKey.get(`${gun}:${saat.period}`) || null
    }))
  }));
}

/** Bir gunun dersleri, saat sirasinda. */
function lessonsForDay(entries, gun, ayar = VARSAYILAN_AYAR) {
  const saatByPeriod = new Map(buildPeriods(ayar).map((s) => [s.period, s]));
  return entries
    .filter((e) => e.dayOfWeek === gun)
    .sort((a, b) => a.period - b.period)
    .map((e) => ({ ...e, saat: saatByPeriod.get(e.period) || null }));
}

module.exports = {
  GUN_ADLARI,
  VARSAYILAN_AYAR,
  hmToMinutes,
  minutesToHm,
  buildPeriods,
  endOfDay,
  dayOfWeek,
  buildGrid,
  lessonsForDay
};
