#!/usr/bin/env node
/**
 * yapayzeka.obs mufredatini takip.obs gorev programina cevirir.
 *
 * Kaynak: akkayasoft/uretken-yz-platform deposundaki dersler.py
 * Hedef : src/data/yzProgram.json
 *
 * Kullanim:
 *   node scripts/yz-program-uret.js --platform /yol/uretken-yz-platform
 *
 * Platform guncellenince (yeni ders/modul eklenince) bu script tekrar
 * calistirilir; uretilen JSON commit edilir ve admin panelindeki
 * "YZ Programi" sayfasindan iceri aktarilir. Iceri aktarma idempotent
 * oldugu icin yalnizca yeni dersler gorev olarak eklenir.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const academicCalendar = require('../src/academicCalendar');

// Pedagojik sira: once programlama/veri temelleri, sonra uretken YZ modulleri.
const KURS_SIRASI = [
  'python-temelleri',
  'python-ileri-seviye',
  'numpy-temelleri',
  'pandas-temelleri',
  'veri-gorsellestirme',
  'makine-ogrenmesi-temelleri',
  'derin-ogrenme-egitimi'
];

// Icerik haftalarinda haftanin hangi gunlerine ders konur (1=Pzt ... 5=Cuma).
// Varsayilan Pzt-Per: Cuma ders tekrari / odev icin bos kalir. Mufredat
// takvime sigmiyorsa Cuma da otomatik acilir (--gunler ile elle zorlanabilir).
const GUN_SECENEKLERI = [
  [1, 2, 3, 4],
  [1, 2, 3, 4, 5]
];

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function derslerOku(platformDir) {
  const py = `
import json, sys
sys.path.insert(0, ${JSON.stringify('')})
import dersler
cikti = []
for d in dersler.DERSLER:
    cikti.append({
        "dersId": d["id"],
        "baslik": d["baslik"],
        "sure": d.get("sure", 0),
        "kurs": d.get("kurs", ""),
        "kursAd": dersler.KURSLAR.get(d.get("kurs", ""), {}).get("ad", ""),
    })
print(json.dumps({"kursSirasi": list(dersler.KURSLAR.keys()), "dersler": cikti}, ensure_ascii=False))
`;
  const out = execFileSync('python3', ['-c', py], {
    cwd: platformDir,
    encoding: 'utf-8',
    maxBuffer: 32 * 1024 * 1024
  });
  return JSON.parse(out);
}

function shiftDate(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Ogretim yilindaki tum ders gunlerini hafta hafta gruplar. */
function haftalar(haftalikGunler) {
  const { start, end } = academicCalendar.ACADEMIC_YEAR;
  // Ogretim yili pazartesi baslamayabilir; ilk gunun haftasina geri sar.
  const first = new Date(`${start}T00:00:00Z`);
  const gunFarki = (first.getUTCDay() + 6) % 7;
  let weekStart = shiftDate(start, -gunFarki);

  const liste = [];
  while (weekStart <= end) {
    const gunler = [];
    for (const offset of haftalikGunler) {
      const gun = shiftDate(weekStart, offset - 1);
      if (gun < start || gun > end) continue;
      if (academicCalendar.getDayInfo(gun).isSchoolDay) gunler.push(gun);
    }
    liste.push({ weekStart, gunler });
    weekStart = shiftDate(weekStart, 7);
  }
  return liste;
}

function main() {
  const platformDir = arg('platform', path.resolve(__dirname, '../../uretken-yz-platform'));
  if (!fs.existsSync(path.join(platformDir, 'dersler.py'))) {
    console.error(`dersler.py bulunamadi: ${platformDir}`);
    console.error('Kullanim: node scripts/yz-program-uret.js --platform /yol/uretken-yz-platform');
    process.exit(1);
  }

  const { kursSirasi, dersler } = derslerOku(platformDir);

  // Modul kurslari KURSLAR sozlugundeki sirayi korur; temel kurslar one alinir.
  const sira = [...KURS_SIRASI, ...kursSirasi.filter((k) => !KURS_SIRASI.includes(k))];
  const sirali = [...dersler].sort((a, b) => {
    const fark = sira.indexOf(a.kurs) - sira.indexOf(b.kurs);
    if (fark !== 0) return fark;
    return a.dersId.localeCompare(b.dersId, 'tr');
  });

  // Mufredat kac gunluk haftaya siginiyorsa en seyrek olani sec.
  const zorlanan = arg('gunler', '');
  const denenecek = zorlanan
    ? [zorlanan.split(',').map((g) => Number(g.trim())).filter(Boolean)]
    : GUN_SECENEKLERI;

  let takvim = null;
  let haftalikGunler = denenecek[denenecek.length - 1];
  for (const secenek of denenecek) {
    const aday = haftalar(secenek);
    const kapasite = aday.reduce((t, h) => t + h.gunler.length, 0);
    if (kapasite >= sirali.length) {
      takvim = aday;
      haftalikGunler = secenek;
      break;
    }
  }
  if (!takvim) {
    takvim = haftalar(haftalikGunler);
  }

  const gorevler = [];
  let i = 0;
  for (const hafta of takvim) {
    for (const gun of hafta.gunler) {
      if (i >= sirali.length) break;
      gorevler.push({ ...sirali[i], tarih: gun });
      i += 1;
    }
    if (i >= sirali.length) break;
  }

  const cikti = {
    surum: `${academicCalendar.ACADEMIC_YEAR.label}.1`,
    baslangic: gorevler.length ? gorevler[0].tarih : null,
    bitis: gorevler.length ? gorevler[gorevler.length - 1].tarih : null,
    kaynak: 'akkayasoft/uretken-yz-platform',
    toplamDers: sirali.length,
    yerlesen: gorevler.length,
    haftalikGun: haftalikGunler.length,
    gorevler
  };

  const hedef = path.resolve(__dirname, '../src/data/yzProgram.json');
  fs.mkdirSync(path.dirname(hedef), { recursive: true });
  fs.writeFileSync(hedef, `${JSON.stringify(cikti, null, 1)}\n`, 'utf-8');

  console.log(`yerlesen ders : ${cikti.yerlesen}/${cikti.toplamDers}`);
  console.log(`hafta duzeni  : ${haftalikGunler.length} ders gunu/hafta (${haftalikGunler.join(',')})`);
  console.log(`ilk  : ${cikti.baslangic}  ${gorevler[0] && gorevler[0].baslik}`);
  console.log(`son  : ${cikti.bitis}  ${gorevler[gorevler.length - 1] && gorevler[gorevler.length - 1].baslik}`);
  console.log(`kurs : ${new Set(gorevler.map((g) => g.kursAd)).size} farkli kategori olusacak`);
  if (cikti.yerlesen < cikti.toplamDers) {
    console.log(`UYARI: ${cikti.toplamDers - cikti.yerlesen} ders takvime sigmadi.`);
  }
}

main();
