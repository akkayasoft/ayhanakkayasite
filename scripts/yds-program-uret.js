#!/usr/bin/env node
/**
 * yds.obs icerigini takip.obs gunluk gorev programina cevirir.
 *
 * Kaynak: akkayasoft/yds-yokdil-app deposundaki content/*.json
 * Hedef : src/data/ydsProgram.json
 *
 * Kullanim:
 *   node scripts/yds-program-uret.js --yds /yol/yds-yokdil-app
 *   node scripts/yds-program-uret.js --yds ... --gunler her-gun --dakika 90
 *
 * YZ PROGRAMINDAN FARKI
 * ---------------------
 * YZ mufredati sabitti (149 ders) ve takvime bire bir yayiliyordu. YDS icerigi
 * ise Ankara Dil kaynaklarindan gun gun uretiliyor: bugun 42 parca var, yil ise
 * 179 ders gunu. Bu yuzden burada:
 *   1. Her parca en fazla 3 kez planlanir (ilk gorme + 3 gun sonra + 10 gun
 *      sonra tekrar). Araliklarin genislemesi araliklı tekrar mantigidir;
 *      ayni okumayi 45 kez planlamak yerine durust olan budur.
 *   2. Icerik bitince kalan gunler "bekliyor" olarak isaretlenir — o gunlere
 *      icerik uydurulmaz, yalnizca gunluk calisma gorevi acilir.
 *   3. Icerik buyuyunce script tekrar calistirilir; YENI parcalar bos gunlere
 *      yerlesir, gecmis gunler oynamaz.
 */

const fs = require('fs');
const path = require('path');

const academicCalendar = require('../src/academicCalendar');
// Yayma motoru paylasimli: ayni kod admin arayuzunden gun duzeni degistiginde
// de calisiyor (src/ydsPlan.js).
const ydsPlan = require('../src/ydsPlan');
// Icerik cikarimi paylasimli: sinav ureticisi de ayni kurallari kullanir.
const ydsIcerik = require('../src/ydsIcerik');
const { TUR_ADI, parcalariTopla } = ydsIcerik;

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

// Programin baslangici (kullanici 14 Eylul dedi; ogretim yilinin ilk gunu).
const BASLANGIC = process.env.YDS_PROGRAM_START || academicCalendar.ACADEMIC_YEAR.start;

// Gunluk hedef sure (dk). Paket bu butceye gore doldurulur.
// YDS hafta sonuna alindi (hafta ici YZ programi calisiyor), o yuzden gunluk
// butce 60 degil 120 dk: hafta sonu daha genis blok var. --dakika ile degisir.
const GUNLUK_DAKIKA = Number(arg('dakika', process.env.YDS_GUNLUK_DAKIKA || 120));

// Calisma gunleri: hazir duzen adi ('hafta-sonu' | 'hafta-ici' | 'her-gun') ya
// da virgullu hafta gunu listesi ('0,3,6'; 0=Pazar). Varsayilan hafta sonu.
// Ayni secim admin panelinden de yapilabilir; orada secilen deposu degil
// veritabanini gunceller (bkz. yds_program_settings).
const GUN_SET = ydsPlan.normalizeGunSet(arg('gunler', process.env.YDS_GUN_SET || 'hafta-sonu'));

function shiftDate(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const calismaGunleri = () =>
  ydsPlan.calismaGunleri({ gunSet: GUN_SET, baslangic: BASLANGIC });

const programUret = (parcalar, gunler) =>
  ydsPlan.programUret(parcalar, gunler, { gunlukDakika: GUNLUK_DAKIKA });

function main() {
  const ydsDir = arg('yds', path.resolve(__dirname, '../../yds-yokdil-app'));
  if (!fs.existsSync(path.join(ydsDir, 'content'))) {
    console.error(`YDS icerigi bulunamadi: ${ydsDir}/content`);
    console.error('Kullanim: node scripts/yds-program-uret.js --yds /yol/yds-yokdil-app');
    process.exit(1);
  }

  const parcalar = parcalariTopla(ydsDir);
  const gunler = calismaGunleri();
  const program = programUret(parcalar, gunler);

  const dolu = program.filter((g) => g.durum === 'dolu');
  const bekleyen = program.filter((g) => g.durum === 'bekliyor');

  const cikti = {
    surum: `${academicCalendar.ACADEMIC_YEAR.label}.1`,
    kaynak: 'akkayasoft/yds-yokdil-app',
    // Ilk gercek calisma gunu (BASLANGIC hafta ici bir gune denk gelebilir).
    baslangic: gunler[0] || null,
    bitis: gunler[gunler.length - 1] || null,
    gunlukDakika: GUNLUK_DAKIKA,
    toplamParca: parcalar.length,
    calismaGunu: gunler.length,
    gunDuzeni: ydsPlan.duzenAdi(GUN_SET),
    gunSet: GUN_SET.join(','),
    doluGun: dolu.length,
    bekleyenGun: bekleyen.length,
    gunler: program
  };

  const hedef = path.resolve(__dirname, '../src/data/ydsProgram.json');
  fs.mkdirSync(path.dirname(hedef), { recursive: true });
  fs.writeFileSync(hedef, `${JSON.stringify(cikti, null, 1)}\n`, 'utf-8');

  const turSayisi = {};
  parcalar.forEach((p) => (turSayisi[p.tur] = (turSayisi[p.tur] || 0) + 1));

  console.log(`parca         : ${parcalar.length}  (${Object.entries(turSayisi).map(([k, v]) => `${k}:${v}`).join(' ')})`);
  console.log(`calisma gunu  : ${gunler.length} gun [${ydsPlan.gunSetEtiketi(GUN_SET)}]  (${cikti.baslangic} -> ${cikti.bitis})`);
  console.log(`icerikli gun  : ${dolu.length}   (son: ${dolu.length ? dolu[dolu.length - 1].tarih : '-'})`);
  console.log(`bekleyen gun  : ${bekleyen.length}`);
  const ortalama = dolu.length
    ? Math.round(dolu.reduce((t, g) => t + g.toplamSure, 0) / dolu.length)
    : 0;
  console.log(`ortalama sure : ${ortalama} dk/gun (hedef ${GUNLUK_DAKIKA})`);
  if (bekleyen.length) {
    const gerekli = Math.ceil((bekleyen.length * GUNLUK_DAKIKA) / 20);
    console.log(`NOT: kalan ${bekleyen.length} gunu doldurmak icin kabaca ${gerekli} yeni parca gerekiyor.`);
  }
}

main();
