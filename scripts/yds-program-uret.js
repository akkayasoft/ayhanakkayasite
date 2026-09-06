#!/usr/bin/env node
/**
 * yds.obs icerigini takip.obs gunluk gorev programina cevirir.
 *
 * Kaynak: akkayasoft/yds-yokdil-app deposundaki content/*.json
 * Hedef : src/data/ydsProgram.json
 *
 * Kullanim:
 *   node scripts/yds-program-uret.js --yds /yol/yds-yokdil-app
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

// Bir parcanin kac kez planlanacagi ve tekrar araliklari (gun).
const TEKRAR_ARALIKLARI = [3, 10];

// Tekrarlarin gunluk butcede kaplayabilecegi en fazla oran. Sinir olmazsa
// vadesi gelen tekrarlar gunu tamamen doldurup yeni icerigi kovuyor — ilk
// denemede 17-18 Eylul bastan sona tekrar cikmisti.
const TEKRAR_PAYI = 1 / 3;

// Tur basina tahmini sureler (dk) — olcum degil, makul tahmin.
const SURE = { konu: 15, kelime: 12, okuma: 20, test: 25 };

const TUR_ADI = {
  konu: 'Konu Anlatımı',
  kelime: 'Kelime',
  okuma: 'Okuma',
  test: 'Test'
};

function shiftDate(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function oku(dizin, ad) {
  const p = path.join(dizin, 'content', ad);
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

/** YDS icerigini tek bir "parca" listesine cevirir (mufredat sirasinda). */
function parcalariTopla(ydsDir) {
  const lessons = oku(ydsDir, 'lessons.json');
  const vocabulary = oku(ydsDir, 'vocabulary.json');
  const reading = oku(ydsDir, 'reading.json');
  const grammar = oku(ydsDir, 'grammar.json');
  const preposition = oku(ydsDir, 'preposition.json');

  const parcalar = [];

  // 1) Konu anlatimi — her bolum ayri bir parca.
  for (const ders of lessons.lessons || []) {
    const bolumler = ders.sections || [];
    bolumler.forEach((bolum, i) => {
      parcalar.push({
        id: `konu:${ders.id}:${i + 1}`,
        tur: 'konu',
        baslik: `${ders.title || ders.id} — Bölüm ${i + 1}/${bolumler.length}`,
        kaynak: ders.id,
        sure: SURE.konu
      });
    });
  }

  // 2) Okuma — her parca uc oturuma bolunur: metin+sozluk, cumle analizi x2.
  //    (reading.json'da parca basina ~13 cumle analizi var; tek oturumda bitmez.)
  for (const unit of reading.units || []) {
    const cumleler = (unit.sentences || []).length;
    const oturumlar = cumleler > 8 ? 3 : cumleler > 0 ? 2 : 1;
    const adlar = ['Metin ve sözlük', 'Cümle analizi 1', 'Cümle analizi 2'];
    for (let i = 0; i < oturumlar; i++) {
      parcalar.push({
        id: `okuma:${unit.id}:${i + 1}`,
        tur: 'okuma',
        baslik: `${unit.title || unit.id} — ${adlar[i]}`,
        kaynak: unit.id,
        sure: SURE.okuma
      });
    }
  }

  // 3) Kelime desteleri.
  for (const deck of vocabulary.decks || []) {
    parcalar.push({
      id: `kelime:${deck.id}`,
      tur: 'kelime',
      baslik: `${deck.title || deck.id} (${(deck.cards || []).length} kart)`,
      kaynak: deck.id,
      sure: SURE.kelime
    });
  }

  // 4) Testler — puanli olanlar (preposition) once, gercek geri bildirim verir.
  const testler = [
    ...(preposition.tests || []).map((t) => ({ t, puanli: true })),
    ...(grammar.tests || []).map((t) => ({ t, puanli: false }))
  ];
  for (const { t, puanli } of testler) {
    parcalar.push({
      id: `test:${t.id}`,
      tur: 'test',
      baslik: `${t.title || t.id} (${(t.questions || []).length} soru${puanli ? ', puanlı' : ''})`,
      kaynak: t.id,
      sure: SURE.test
    });
  }

  return parcalar;
}

/**
 * Calisma gunleri: ogretim yilindaki CUMARTESI ve PAZAR gunleri.
 *
 * YDS hafta sonuna alindi ki hafta ici calisan YZ programiyla cakismasin.
 * Yalnizca resmi/dini bayramlar cikarilir; ara tatil ve yariyil tatiline denk
 * gelen hafta sonlari DAHILDIR (okul tatili YDS calismasini engellemez, aksine
 * o gunlerde daha cok vakit vardir).
 *
 * Not: getDayInfo() tatil donemini hafta sonundan once dondurdugu icin
 * (ara tatildeki cumartesi type='break' gelir) gun secimi takvim etiketine
 * degil, gercek hafta gunune bakar.
 */
function calismaGunleri() {
  const { end } = academicCalendar.ACADEMIC_YEAR;
  const gunler = [];
  let g = BASLANGIC;
  while (g <= end) {
    const haftaninGunu = new Date(`${g}T00:00:00Z`).getUTCDay(); // 0=Pazar, 6=Cumartesi
    const bilgi = academicCalendar.getDayInfo(g);
    if ((haftaninGunu === 0 || haftaninGunu === 6) && bilgi.type !== 'holiday' && bilgi.type !== 'outside') {
      gunler.push(g);
    }
    g = shiftDate(g, 1);
  }
  return gunler;
}

/**
 * Gunleri doldurur. Her gun once VADESI GELEN tekrarlar, sonra YENI parcalar
 * yerlestirilir; boylece tekrar birikip kaymaz.
 */
function programUret(parcalar, gunler) {
  const yeniKuyruk = [...parcalar];
  const tekrarlar = []; // { parca, vadeGunuIndex, tur: kacinci tekrar }
  const program = [];

  gunler.forEach((tarih, gunIndex) => {
    const paket = [];
    let kalan = GUNLUK_DAKIKA;

    // Yeni icerik bittikten sonra tekrarlarin takvimde delik birakmamasi icin
    // vade sarti kalkar ve kalan tekrarlar ardisik gunlere sikistirilir.
    const yeniBitti = yeniKuyruk.length === 0;
    // Yeni icerik varken tekrar butcesi sinirli; bittiginde gunun tamami acilir.
    let tekrarButcesi = yeniBitti ? GUNLUK_DAKIKA : Math.floor(GUNLUK_DAKIKA * TEKRAR_PAYI);

    // 1) Tekrarlar (en eski vade once).
    tekrarlar.sort((a, b) => a.vade - b.vade);
    for (let i = 0; i < tekrarlar.length; ) {
      const t = tekrarlar[i];
      const vadeUygun = yeniBitti || t.vade <= gunIndex;
      if (vadeUygun && t.parca.sure <= Math.min(kalan, tekrarButcesi)) {
        paket.push({ ...t.parca, tekrar: t.sira });
        kalan -= t.parca.sure;
        tekrarButcesi -= t.parca.sure;
        tekrarlar.splice(i, 1);
        if (t.sira < TEKRAR_ARALIKLARI.length) {
          tekrarlar.push({
            parca: t.parca,
            sira: t.sira + 1,
            vade: gunIndex + TEKRAR_ARALIKLARI[t.sira]
          });
        }
        continue;
      }
      i += 1;
    }

    // 2) Yeni parcalar — ayni turden ust uste iki tane koymamaya calis.
    while (yeniKuyruk.length && kalan > 0) {
      let secilenIndex = yeniKuyruk.findIndex(
        (p) => p.sure <= kalan && !paket.some((x) => x.tur === p.tur)
      );
      if (secilenIndex === -1) {
        secilenIndex = yeniKuyruk.findIndex((p) => p.sure <= kalan);
      }
      if (secilenIndex === -1) break;
      const [parca] = yeniKuyruk.splice(secilenIndex, 1);
      paket.push({ ...parca, tekrar: 0 });
      kalan -= parca.sure;
      tekrarlar.push({ parca, sira: 1, vade: gunIndex + TEKRAR_ARALIKLARI[0] });
    }

    program.push({
      tarih,
      gunAdi: ['Pazar', 'Pazartesi', 'Salı', 'Çarşamba', 'Perşembe', 'Cuma', 'Cumartesi'][
        new Date(`${tarih}T00:00:00Z`).getUTCDay()
      ],
      durum: paket.length ? 'dolu' : 'bekliyor',
      toplamSure: paket.reduce((t, p) => t + p.sure, 0),
      parcalar: paket.map((p) => ({
        id: p.id,
        tur: p.tur,
        turAdi: TUR_ADI[p.tur],
        baslik: p.baslik,
        sure: p.sure,
        tekrar: p.tekrar
      }))
    });
  });

  return program;
}

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
    gunDuzeni: 'hafta-sonu',
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
  console.log(`calisma gunu  : ${gunler.length} hafta sonu gunu  (${cikti.baslangic} -> ${cikti.bitis})`);
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
