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

/* --------------------------------------------------------------------------
   Toplu yapistirma ayristiricisi

   Program elle hucre hucre girilebiliyor ama 20-30 ders icin yorucu. Burasi
   "gun · ders saati · ders adi · sinif · derslik" satirlarini okur.

   Bilerek TOLERANSLI: ayrac olarak sekme (Excel'den kopyala), noktali virgul,
   virgul ya da bosluk kabul edilir; gun adi kisaltmalari ve Turkce karakter
   varyantlari eslenir; "3." / "3. ders" gibi yazimlar temizlenir; "1-2" gibi
   araliklar birden fazla satira acilir (blok ders yaygin).

   Anlasilmayan satir SESSIZCE ATILMAZ — cagirana hatasiyla birlikte doner ki
   kullanici neyin girmedigini gorsun.
   -------------------------------------------------------------------------- */

// Turkce kucuk harfe cevir + aksanlari sadelestir (eslesme icin).
function sadelestir(metin) {
  return String(metin)
    .toLocaleLowerCase('tr')
    .replace(/ı/g, 'i')
    .replace(/ş/g, 's')
    .replace(/ğ/g, 'g')
    .replace(/ü/g, 'u')
    .replace(/ö/g, 'o')
    .replace(/ç/g, 'c')
    .replace(/[.\s]/g, '');
}

const GUN_ESLEME = new Map();
[
  [1, ['pazartesi', 'pzt', 'pt', 'ptesi', 'pazartesı', 'mon', 'monday']],
  [2, ['sali', 'sal', 'sl', 'tue', 'tuesday']],
  [3, ['carsamba', 'car', 'crs', 'crsm', 'wed', 'wednesday']],
  [4, ['persembe', 'per', 'prs', 'prsm', 'thu', 'thursday']],
  [5, ['cuma', 'cum', 'cm', 'fri', 'friday']]
].forEach(([no, adlar]) => adlar.forEach((ad) => GUN_ESLEME.set(ad, no)));

function parseGun(deger) {
  return GUN_ESLEME.get(sadelestir(deger)) ?? null;
}

/** "3", "3.", "3. ders", "1-2", "1/2", "1+2" -> [3] / [1,2] */
function parseSaatler(deger) {
  const temiz = String(deger)
    .toLocaleLowerCase('tr')
    .replace(/ders/g, '')
    .replace(/saat/g, '')
    .replace(/\./g, '')
    .trim();

  const aralik = /^(\d{1,2})\s*[-–—]\s*(\d{1,2})$/.exec(temiz);
  if (aralik) {
    const bas = Number(aralik[1]);
    const son = Number(aralik[2]);
    if (bas > son) return null;
    const cikti = [];
    for (let i = bas; i <= son; i += 1) cikti.push(i);
    return cikti;
  }

  if (/[/+]/.test(temiz)) {
    const parcalar = temiz.split(/[/+]/).map((x) => Number(x.trim()));
    if (parcalar.every((n) => Number.isInteger(n) && n > 0)) return parcalar;
    return null;
  }

  const tek = Number(temiz);
  return Number.isInteger(tek) && tek > 0 ? [tek] : null;
}

/** Satiri alanlarina ayirir: sekme > noktali virgul > virgul > 2+ bosluk > bosluk */
function alanlaraAyir(satir) {
  for (const ayrac of [/\t+/, /\s*;\s*/, /\s*,\s*/, /\s{2,}/]) {
    if (ayrac.test(satir)) {
      const parcalar = satir.split(ayrac).map((x) => x.trim()).filter((x, i, a) => x !== '' || i < a.length - 1);
      if (parcalar.length >= 3) return parcalar.map((x) => x.trim());
    }
  }
  // Tek bosluk: ilk iki alan gun ve saat, gerisi ders adi sayilir.
  const parcalar = satir.trim().split(/\s+/);
  if (parcalar.length >= 3) {
    return [parcalar[0], parcalar[1], parcalar.slice(2).join(' ')];
  }
  return parcalar;
}

/**
 * Yapistirilan metni ayristirir.
 * Doner: { gecerli: [{dayOfWeek, period, subject, className, room, kind}], hatali: [{satir, hata}] }
 */
function parseScheduleText(metin, periodCount = 16) {
  const gecerli = [];
  const hatali = [];
  const gorulen = new Set();

  const satirlar = String(metin || '').split(/\r?\n/);
  for (const ham of satirlar) {
    const satir = ham.trim();
    if (!satir || satir.startsWith('#')) continue;

    const alanlar = alanlaraAyir(satir);
    if (alanlar.length < 3) {
      hatali.push({ satir, hata: 'En az gün, ders saati ve ders adı gerekli.' });
      continue;
    }

    const gun = parseGun(alanlar[0]);
    if (!gun) {
      hatali.push({ satir, hata: `Gün anlaşılmadı: "${alanlar[0]}"` });
      continue;
    }

    const saatler = parseSaatler(alanlar[1]);
    if (!saatler) {
      hatali.push({ satir, hata: `Ders saati anlaşılmadı: "${alanlar[1]}"` });
      continue;
    }

    const subject = (alanlar[2] || '').trim();
    if (!subject) {
      hatali.push({ satir, hata: 'Ders adı boş.' });
      continue;
    }

    const kapsamDisi = saatler.filter((s) => s > periodCount);
    if (kapsamDisi.length) {
      hatali.push({
        satir,
        hata: `Ders saati kapsam dışı (1-${periodCount}): ${kapsamDisi.join(', ')}`
      });
      continue;
    }

    const kind = sadelestir(subject) === 'nobet' ? 'duty' : 'lesson';
    for (const saat of saatler) {
      const anahtar = `${gun}:${saat}`;
      if (gorulen.has(anahtar)) {
        hatali.push({ satir, hata: `Aynı hücre birden çok satırda: ${alanlar[0]} ${saat}. ders` });
        continue;
      }
      gorulen.add(anahtar);
      gecerli.push({
        dayOfWeek: gun,
        period: saat,
        subject,
        className: (alanlar[3] || '').trim(),
        room: (alanlar[4] || '').trim(),
        kind
      });
    }
  }

  return { gecerli, hatali };
}

module.exports = {
  GUN_ADLARI,
  parseScheduleText,
  parseGun,
  parseSaatler,
  VARSAYILAN_AYAR,
  hmToMinutes,
  minutesToHm,
  buildPeriods,
  endOfDay,
  dayOfWeek,
  buildGrid,
  lessonsForDay
};
