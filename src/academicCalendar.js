// 2026-2027 Egitim Ogretim Yili - MEB calisma takvimi
//
// Kaynak: MEB 2026-2027 Egitim Ogretim Yili Calisma Takvimi genelgesi.
// Tarihler iki bagimsiz kaynaktan dogrulandi ve gun adlari hesapla teyit
// edildi. Yeni ogretim yilinda yalnizca asagidaki ACADEMIC_YEAR nesnesini
// guncellemek yeterlidir; gerisi tarihlerden turetilir.

const ACADEMIC_YEAR = {
  label: '2026-2027',
  // Ogretim yilinin ilk ve son ders gunu
  start: '2026-09-14',
  end: '2027-06-25',

  terms: [
    { no: 1, label: '1. Dönem', start: '2026-09-14', end: '2027-01-22' },
    { no: 2, label: '2. Dönem', start: '2027-02-08', end: '2027-06-25' }
  ],

  // Okulun kapali oldugu tatil donemleri
  breaks: [
    { label: '1. Ara Tatil', start: '2026-11-16', end: '2026-11-20' },
    { label: 'Yarıyıl Tatili', start: '2027-01-25', end: '2027-02-05' },
    { label: '2. Ara Tatil', start: '2027-03-08', end: '2027-03-12' }
  ],

  // Ogretim yili icine dusen resmi ve dini bayramlar.
  // Not: Ramazan Bayrami (9-11 Mart 2027) 2. ara tatilin icinde kaliyor;
  // daha acik olsun diye yine de ayrica etiketleniyor.
  holidays: [
    { start: '2026-10-29', end: '2026-10-29', label: 'Cumhuriyet Bayramı' },
    { start: '2027-01-01', end: '2027-01-01', label: 'Yılbaşı' },
    { start: '2027-03-09', end: '2027-03-11', label: 'Ramazan Bayramı' },
    { start: '2027-04-23', end: '2027-04-23', label: 'Ulusal Egemenlik ve Çocuk Bayramı' },
    { start: '2027-05-01', end: '2027-05-01', label: 'Emek ve Dayanışma Günü' },
    { start: '2027-05-16', end: '2027-05-19', label: 'Kurban Bayramı' },
    { start: '2027-05-19', end: '2027-05-19', label: 'Gençlik ve Spor Bayramı' }
  ]
};

function inRange(dateStr, range) {
  return dateStr >= range.start && dateStr <= range.end;
}

function isWeekend(dateStr) {
  const day = new Date(`${dateStr}T00:00:00Z`).getUTCDay();
  return day === 0 || day === 6;
}

function findTerm(dateStr) {
  return ACADEMIC_YEAR.terms.find((term) => inRange(dateStr, term)) || null;
}

// Bir gunun ogretim yilindaki durumunu tarif eder.
// type: 'school' | 'weekend' | 'holiday' | 'break' | 'outside'
function getDayInfo(dateStr) {
  if (!dateStr) return { type: 'outside', label: '', isSchoolDay: false, term: null };

  if (dateStr < ACADEMIC_YEAR.start || dateStr > ACADEMIC_YEAR.end) {
    return { type: 'outside', label: 'Öğretim yılı dışı', isSchoolDay: false, term: null };
  }

  const term = findTerm(dateStr);

  // Bayram etiketi tatil doneminden daha ozeldir, once o gosterilir.
  const holiday = ACADEMIC_YEAR.holidays.find((h) => inRange(dateStr, h));
  if (holiday) {
    return { type: 'holiday', label: holiday.label, isSchoolDay: false, term };
  }

  const period = ACADEMIC_YEAR.breaks.find((b) => inRange(dateStr, b));
  if (period) {
    return { type: 'break', label: period.label, isSchoolDay: false, term };
  }

  if (isWeekend(dateStr)) {
    return { type: 'weekend', label: 'Hafta sonu', isSchoolDay: false, term };
  }

  if (!term) {
    // Iki donem arasindaki bosluk (yariyil tatili disinda kalan gunler)
    return { type: 'break', label: 'Tatil', isSchoolDay: false, term: null };
  }

  return { type: 'school', label: '', isSchoolDay: true, term };
}

// Donem icindeki hafta numarasi (donemin ilk haftasi = 1).
function getTermWeekNumber(dateStr, term) {
  if (!term) return null;
  const termStart = new Date(`${term.start}T00:00:00Z`);
  const target = new Date(`${dateStr}T00:00:00Z`);
  if (target < termStart) return null;

  // Iki tarihin de icinde bulundugu Pazartesi'ye gore fark alinir.
  const toMonday = (d) => {
    const copy = new Date(d);
    const offset = (copy.getUTCDay() + 6) % 7;
    copy.setUTCDate(copy.getUTCDate() - offset);
    return copy;
  };

  const diffDays = Math.round((toMonday(target) - toMonday(termStart)) / 86400000);
  return Math.floor(diffDays / 7) + 1;
}

// Takvim sayfasinin baslik satiri icin ozet.
function describeWeek(weekStart, weekEnd) {
  const days = [];
  let cursor = weekStart;
  while (cursor <= weekEnd) {
    days.push(cursor);
    const next = new Date(`${cursor}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    cursor = next.toISOString().slice(0, 10);
  }

  const infos = days.map(getDayInfo);
  const schoolDays = infos.filter((info) => info.isSchoolDay).length;
  const term = infos.map((info) => info.term).find(Boolean) || null;
  const weekNo = term ? getTermWeekNumber(weekStart, term) : null;

  // Hafta tamamen okul disindaysa sebebini basliga tasi.
  let note = '';
  if (schoolDays === 0) {
    const period = infos.find((info) => info.type === 'break' || info.type === 'holiday');
    note = period ? period.label : 'Öğretim yılı dışı';
  }

  return {
    yearLabel: ACADEMIC_YEAR.label,
    termLabel: term ? term.label : '',
    weekNo,
    schoolDays,
    note
  };
}

module.exports = {
  ACADEMIC_YEAR,
  getDayInfo,
  getTermWeekNumber,
  describeWeek
};
