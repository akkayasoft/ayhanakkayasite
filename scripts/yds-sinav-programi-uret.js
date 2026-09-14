#!/usr/bin/env node
/**
 * 22 Kasim 2026 YDS sinavina yonelik 10 haftalik calisma programi uretir.
 *
 *   node scripts/yds-sinav-programi-uret.js
 *   node scripts/yds-sinav-programi-uret.js --gunler 0,1,3,6 --sure 180
 *
 * Hedef: src/data/ydsProgram.json  (mevcut Doktora programinin yerini alir)
 *
 * NEDEN AYRI BIR URETICI
 * ----------------------
 * `yds-program-uret.js` uygulamanin kendi icerigini (56 parca) gunluk dakika
 * butcesine gore yayar — acik uclu bir calisma programi. Bu betik farkli bir
 * isi yapiyor: SABIT SIRALI 40 dersi, sabit bir sinav tarihine dogru, gunde
 * BIR DERS olacak sekilde yerlestiriyor ve arada tekrar/deneme gunleri
 * birakiyor. Ikisi ayni cikti bicimini uretir; bu yuzden aktarim, idempotentlik
 * ve "gecmis + isaretli gorev korunur" guvenceleri ikisinde de aynen calisir.
 *
 * GUN TIPLERI
 *   ders     : Pzt / Car / Cmt / Paz — 1 video ders. Son 10 ders DENEME
 *              ANALIZI videosudur (src/data/ydsDersleri.json icindeki tur).
 *   uygulama : Sal / Per / Cum       — o derslere ait yds.obs uygulamalari
 *              (src/data/ydsUygulamalar.json: 9 dilbilgisi + 2 preposition
 *              testi, 25 kelime destesi, 4 okuma unitesi = 40 parca).
 *   hafif    : sinavdan onceki gun   — yalniz hata defteri
 */

const fs = require('fs');
const path = require('path');

const ydsPlan = require('../src/ydsPlan');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const BASLANGIC = arg('baslangic', '2026-09-14');
const SINAV = arg('sinav', '2026-11-22');
// Ders gunleri (0 = Pazar ... 6 = Cumartesi). Varsayilan: Pzt, Car, Cmt, Paz.
const DERS_GUNLERI = ydsPlan.normalizeGunSet(arg('gunler', '0,1,3,6'));
const DERS_DAKIKA = Number(arg('sure', 180));
const UYGULAMA_DAKIKA = Number(arg('uygulama-sure', 60));

const DERSLER_PATH = path.resolve(__dirname, '../src/data/ydsDersleri.json');
const UYGULAMALAR_PATH = path.resolve(__dirname, '../src/data/ydsUygulamalar.json');
const HEDEF = path.resolve(__dirname, '../src/data/ydsProgram.json');

const GUN_ADLARI = ydsPlan.GUN_ADLARI;
const shiftDate = ydsPlan.shiftDate;
const dow = (d) => new Date(`${d}T00:00:00Z`).getUTCDay();

function gunListesi(bas, son) {
  const out = [];
  let g = bas;
  while (g <= son) {
    out.push(g);
    g = shiftDate(g, 1);
  }
  return out;
}

function uygulamalariOku() {
  const ham = JSON.parse(fs.readFileSync(UYGULAMALAR_PATH, 'utf-8'));
  return Array.isArray(ham.uygulamalar) ? ham.uygulamalar : [];
}

function dersleriOku() {
  const ham = JSON.parse(fs.readFileSync(DERSLER_PATH, 'utf-8'));
  const dersler = Array.isArray(ham.dersler) ? ham.dersler : [];
  if (!dersler.length) {
    console.error(`Ders listesi bos: ${DERSLER_PATH}`);
    process.exit(1);
  }
  return { kaynak: ham.kaynak || '', dersler };
}

/**
 * Gun tiplerini belirler ve dersleri yerlestirir.
 *
 * KURAL (kullanicinin koydugu, degistirilemez):
 *   - Ders YALNIZCA secilen gunlere konur (varsayilan Pzt/Car/Cmt/Paz).
 *   - Diger gunlere (Sal/Per/Cum) DOKUNULMAZ; onlar hizli tekrar gunudur.
 *   - SON HAFTA istisna: sinav oncesi blokta her gun kullanilabilir.
 *
 * Ders penceresine sigmayan dersler son hafta blokuna tasar. Bu bir caresizlik
 * degil tercih: setin son dersleri deneme sinavi ANALIZI oldugu icin sinavdan
 * hemen once islenmeleri dogru yer. Blokta ders bittikten sonra kalan gunler
 * tam denemeye, son gun hafif tekrara ayrilir.
 *
 * > Ilk surumde eksik gunler Sal/Per/Cum'dan "odunc" aliniyordu. Bu, acikca
 * > verilmis bir kisiti kendi basina esnetmekti ve yanlisti: o gunler dinlenme
 * > + hizli tekrar gunu olarak tasarlandi, doldurulunca haftalik tempo
 * > surdurulemez hale geliyor.
 */
function gunTipleri(tumGunler, dersSayisi) {
  const tip = new Map();
  const sonGun = tumGunler[tumGunler.length - 1];

  for (const g of tumGunler) {
    if (g === sonGun) tip.set(g, 'hafif');
    else tip.set(g, DERS_GUNLERI.includes(dow(g)) ? 'ders' : 'uygulama');
  }

  // Ders gunu yetmiyorsa: yalnizca SON HAFTA'nin uygulama gunlerinden, sona en
  // yakindan baslayarak odunc alinir. Kullanici "son hafta her gune
  // koyabilirsin" dedi; ders penceresinin geri kalanina dokunulmaz.
  const dersGunu = [...tip.values()].filter((t) => t === 'ders').length;
  let eksik = dersSayisi - dersGunu;
  if (eksik > 0) {
    const sonHafta = tumGunler.filter((g) => g >= shiftDate(sonGun, -6));
    for (let i = sonHafta.length - 1; i >= 0 && eksik > 0; i -= 1) {
      if (tip.get(sonHafta[i]) !== 'uygulama') continue;
      tip.set(sonHafta[i], 'ders');
      eksik -= 1;
    }
  }

  return tip;
}

function uret() {
  const { kaynak, dersler } = dersleriOku();
  const uygulamalar = uygulamalariOku();
  const tumGunler = gunListesi(BASLANGIC, shiftDate(SINAV, -1));
  const tip = gunTipleri(tumGunler, dersler.length);

  // Uygulamalar, uygulama gunlerine ESIT dagitilir: 40 parca ~29 gune
  // boluenmedigi icin bazi gunler 2 parca alir, bazilari 1.
  const uygulamaGunleri = tumGunler.filter((g) => tip.get(g) === 'uygulama');
  const payla = (i) =>
    uygulamalar.slice(
      Math.floor((i * uygulamalar.length) / uygulamaGunleri.length),
      Math.floor(((i + 1) * uygulamalar.length) / uygulamaGunleri.length)
    );

  const program = [];
  let sira = 0;
  let sonDers = null;
  let uygulamaIndex = 0;

  for (const tarih of tumGunler) {
    const t = tip.get(tarih);
    const gunAdi = GUN_ADLARI[dow(tarih)];
    let parcalar = [];

    if (t === 'ders' && sira < dersler.length) {
      const d = dersler[sira];
      sira += 1;
      sonDers = d;
      const analiz = d.tur === 'deneme-analizi';
      parcalar = [
        {
          id: `ders-${String(d.no).padStart(2, '0')}`,
          tur: 'konu',
          turAdi: analiz ? 'Deneme Analizi' : 'Video Ders',
          baslik: `${String(d.no).padStart(2, '0')}. ${d.baslik}`,
          sure: Number(d.sure) || DERS_DAKIKA,
          tekrar: 0
        }
      ];
    } else if (t === 'hafif') {
      parcalar = [
        {
          id: 'hafif-son',
          tur: 'kelime',
          turAdi: 'Hafif Tekrar',
          baslik: 'Hata defteri ve bağlaç listesi — yeni konu yok, erken yat',
          sure: 90,
          tekrar: 0
        }
      ];
    } else {
      // Uygulama gunu: o ana kadar islenen dersin ardindan yds.obs pratigi.
      const pay = payla(uygulamaIndex);
      uygulamaIndex += 1;
      const atif = sonDers ? `${String(sonDers.no).padStart(2, '0')}. ders sonrası` : 'başlangıç';
      parcalar = pay.length
        ? pay.map((u) => ({
            id: `uyg-${u.tur.toLowerCase()}-${u.id}`,
            tur: u.tur === 'Test' ? 'test' : u.tur === 'Kelime' ? 'kelime' : 'okuma',
            turAdi: `yds.obs · ${u.tur}`,
            baslik: `${u.baslik} — ${u.ekran} (${atif})`,
            sure: Math.round(UYGULAMA_DAKIKA / pay.length),
            tekrar: 0
          }))
        : [
            {
              id: `uyg-serbest-${tarih}`,
              tur: 'kelime',
              turAdi: 'yds.obs · Serbest',
              baslik: `yds.obs'ta serbest çalışma — zayıf kaldığın testleri tekrar çöz (${atif})`,
              sure: UYGULAMA_DAKIKA,
              tekrar: 0
            }
          ];
    }

    program.push({
      tarih,
      gunAdi,
      durum: parcalar.length ? 'dolu' : 'bekliyor',
      toplamSure: parcalar.reduce((a, p) => a + p.sure, 0),
      parcalar
    });
  }

  // Denetim: son hafta disinda secili gunler disina ders dusmemeli.
  const sonHaftaBasi = shiftDate(tumGunler[tumGunler.length - 1], -6);
  const kacak = program.filter(
    (g) =>
      g.tarih < sonHaftaBasi &&
      g.parcalar[0].turAdi !== 'Hafif Tekrar' &&
      !String(g.parcalar[0].turAdi).startsWith('yds.obs') &&
      !DERS_GUNLERI.includes(dow(g.tarih))
  );
  if (kacak.length) {
    console.error(
      `HATA: secili gunler disina ${kacak.length} ders dusmus: ${kacak.map((g) => g.tarih).join(', ')}`
    );
    process.exit(1);
  }

  return { kaynak, dersler, uygulamalar, program, yerlesen: sira };
}

function main() {
  const { kaynak, dersler, uygulamalar, program, yerlesen } = uret();

  if (yerlesen < dersler.length) {
    console.error(
      `UYARI: ${dersler.length} dersin yalnizca ${yerlesen} tanesi yerlesti. ` +
        `Ders gunu sayisini artir (--gunler) ya da ders sayisini azalt.`
    );
  }

  // Her gunun icerigi oldugu icin gun duzeni "her gun"dur: uygulamanin
  // Calisma Gunleri ayari da "Her Gun" + ayni dakika olmali, yoksa aktarim
  // programi yeniden yayar.
  const cikti = {
    surum: '2026-2027.sinav.1',
    kaynak: kaynak || 'Ankara Dil Akademisi · 40 ders',
    baslangic: program[0].tarih,
    bitis: program[program.length - 1].tarih,
    sinav: SINAV,
    gunlukDakika: DERS_DAKIKA,
    gunDuzeni: 'her-gun',
    gunSet: '0,1,2,3,4,5,6',
    dersGunleri: DERS_GUNLERI.join(','),
    toplamParca: dersler.length + uygulamalar.length,
    dersSayisi: dersler.length,
    uygulamaSayisi: uygulamalar.length,
    calismaGunu: program.length,
    doluGun: program.filter((g) => g.durum === 'dolu').length,
    bekleyenGun: program.filter((g) => g.durum !== 'dolu').length,
    gunler: program
  };

  fs.mkdirSync(path.dirname(HEDEF), { recursive: true });
  fs.writeFileSync(HEDEF, `${JSON.stringify(cikti, null, 1)}\n`, 'utf-8');

  const say = (tur) =>
    program.filter((g) => g.parcalar.some((p) => String(p.turAdi).startsWith(tur))).length;
  const parcaSay = (tur) =>
    program.reduce((a, g) => a + g.parcalar.filter((p) => String(p.turAdi).startsWith(tur)).length, 0);
  const dk = program.reduce((a, g) => a + g.toplamSure, 0);

  console.log(`hedef        : ${path.relative(process.cwd(), HEDEF)}`);
  console.log(`aralik       : ${cikti.baslangic} -> ${cikti.bitis}  (sinav ${SINAV})`);
  console.log(`ders gunleri : ${DERS_GUNLERI.map((g) => GUN_ADLARI[g]).join(', ')}`);
  console.log(`video ders   : ${say('Video Ders')} gun`);
  console.log(`deneme analiz: ${say('Deneme Analizi')} gun`);
  console.log(`  toplam ders: ${yerlesen}/${dersler.length}`);
  console.log(`uygulama     : ${say('yds.obs')} gun, ${parcaSay('yds.obs')} parca (havuz ${uygulamalar.length})`);
  console.log(`hafif        : ${say('Hafif Tekrar')} gun`);
  console.log(`toplam       : ${program.length} gun, ${Math.round(dk / 60)} saat`);
}

main();
