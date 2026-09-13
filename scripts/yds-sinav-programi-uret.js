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
 *   ders    : Pzt / Car / Cmt / Paz — 1 ders (video + kitap), varsayilan 180 dk
 *   tekrar  : Sal / Per / Cum       — hizli tekrar: kelime + onceki dersin ozeti
 *   deneme  : belirli Cumalar + sinav oncesi bos gunler — tam deneme (180 dk)
 *   hafif   : sinavdan onceki gun   — yalniz hata defteri
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
const TEKRAR_DAKIKA = Number(arg('tekrar-sure', 50));
const DENEME_DAKIKA = 180;

const DERSLER_PATH = path.resolve(__dirname, '../src/data/ydsDersleri.json');
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
 * Deneme gunlerini secer.
 *
 * Ara olcumler CUMA aksamina konur: ders gunu degil, ertesi gun okul yok.
 * Boylece ders gunlerinin hicbiri deneme icin harcanmaz — "her ders gununde
 * bir ders" kurali bozulmaz.
 */
function araOlcumGunleri(gunler) {
  const cumalar = gunler.filter((g) => dow(g) === 5);
  const secili = [];
  for (const oran of [0.35, 0.62, 0.85]) {
    const aday = cumalar[Math.floor(cumalar.length * oran)];
    if (aday && !secili.includes(aday)) secili.push(aday);
  }
  return new Set(secili);
}

/**
 * Ders gunu yetmediginde tekrar gunlerinden odunc alir.
 *
 * Odunc gunler ARALIGA ESIT DAGITILIR, sona yigilmaz. Ilk surumde eksik
 * gunler sinava en yakin tekrar gunlerinden aliniyordu; sonuc olarak 38-40.
 * dersler 18-20 Kasim'a dusuyordu — yani sinavdan onceki 48 saate yeni konu,
 * ustelik deneme haftasinin yerine. Oturmamis konu net getirmez; esit dagitim
 * hem yuku dengeler hem sinav haftasini bos birakir.
 */
function oduncGunler(adaylar, adet) {
  if (adet <= 0 || !adaylar.length) return new Set();
  const secili = new Set();
  const adim = adaylar.length / adet;
  for (let i = 0; i < adet; i++) {
    const idx = Math.min(adaylar.length - 1, Math.floor(i * adim));
    let g = adaylar[idx];
    // Ayni gun iki kez secilirse bir sonraki bos adaya kay.
    let k = idx;
    while (g && secili.has(g) && k < adaylar.length - 1) g = adaylar[++k];
    if (g) secili.add(g);
  }
  return secili;
}

function uret() {
  const { kaynak, dersler } = dersleriOku();
  const tumGunler = gunListesi(BASLANGIC, shiftDate(SINAV, -1));

  // Sinav oncesi blok: yeni konu YOK, yalnizca deneme + hata analizi.
  // Varsayilan 6 gun, yani ara tatil (16-20 Kasim) + Cumartesi.
  const blok = Math.max(0, Number(arg('sinav-blogu', 6)));
  const blokBaslangic = tumGunler.length > blok ? tumGunler[tumGunler.length - blok] : tumGunler[0];
  const dersPenceresi = tumGunler.filter((g) => g < blokBaslangic);
  const sonGun = tumGunler[tumGunler.length - 1];

  const araOlcumler = araOlcumGunleri(dersPenceresi);

  // 1) Gun tipleri — once ders penceresi.
  const tip = new Map();
  for (const g of dersPenceresi) {
    if (araOlcumler.has(g)) tip.set(g, 'deneme');
    else if (DERS_GUNLERI.includes(dow(g))) tip.set(g, 'ders');
    else tip.set(g, 'tekrar');
  }

  // 2) Ders gunu yetmiyorsa tekrar gunlerinden ESIT ARALIKLA odunc al.
  const dersGunu = dersPenceresi.filter((g) => tip.get(g) === 'ders').length;
  const eksik = dersler.length - dersGunu;
  if (eksik > 0) {
    const adaylar = dersPenceresi.filter((g) => tip.get(g) === 'tekrar');
    for (const g of oduncGunler(adaylar, eksik)) tip.set(g, 'ders');
  }

  // 3) Sinav blogu: son gun hafif, gerisi deneme.
  for (const g of tumGunler) {
    if (g < blokBaslangic) continue;
    tip.set(g, g === sonGun ? 'hafif' : 'deneme');
  }

  const program = [];
  let sira = 0;
  let sonDers = null;
  let denemeNo = 0;

  for (const tarih of tumGunler) {
    const t = tip.get(tarih);
    const gunAdi = GUN_ADLARI[dow(tarih)];
    let parcalar = [];

    if (t === 'ders' && sira < dersler.length) {
      const d = dersler[sira];
      sira += 1;
      sonDers = d;
      parcalar = [
        {
          id: `ders-${String(d.no).padStart(2, '0')}`,
          tur: 'konu',
          turAdi: 'Ders',
          baslik: `${String(d.no).padStart(2, '0')}. ${d.baslik}`,
          sure: Number(d.sure) || DERS_DAKIKA,
          tekrar: 0
        }
      ];
    } else if (t === 'deneme' || (t === 'ders' && sira >= dersler.length)) {
      denemeNo += 1;
      parcalar = [
        {
          id: `deneme-${String(denemeNo).padStart(2, '0')}`,
          tur: 'test',
          turAdi: 'Deneme',
          baslik: `${denemeNo}. tam deneme — 180 dk tek oturum + hata analizi`,
          sure: DENEME_DAKIKA,
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
      const atif = sonDers
        ? `${String(sonDers.no).padStart(2, '0')}. ${sonDers.baslik}`
        : 'kelime listesi';
      parcalar = [
        {
          id: `tekrar-${tarih}`,
          tur: 'kelime',
          turAdi: 'Hızlı Tekrar',
          baslik: `20 dk kelime + ${atif} özeti`,
          sure: TEKRAR_DAKIKA,
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

  return {
    kaynak,
    dersler,
    program,
    yerlesen: sira,
    denemeSayisi: denemeNo,
    sonDersGunu: [...tip.entries()].filter(([, v]) => v === 'ders').map(([k]) => k).sort().pop()
  };
}

function main() {
  const { kaynak, dersler, program, yerlesen, denemeSayisi } = uret();

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
    toplamParca: dersler.length,
    calismaGunu: program.length,
    doluGun: program.filter((g) => g.durum === 'dolu').length,
    bekleyenGun: program.filter((g) => g.durum !== 'dolu').length,
    gunler: program
  };

  fs.mkdirSync(path.dirname(HEDEF), { recursive: true });
  fs.writeFileSync(HEDEF, `${JSON.stringify(cikti, null, 1)}\n`, 'utf-8');

  const say = (tur) =>
    program.filter((g) => g.parcalar.some((p) => p.turAdi === tur)).length;
  const dk = program.reduce((a, g) => a + g.toplamSure, 0);

  console.log(`hedef        : ${path.relative(process.cwd(), HEDEF)}`);
  console.log(`aralik       : ${cikti.baslangic} -> ${cikti.bitis}  (sinav ${SINAV})`);
  console.log(`ders gunleri : ${DERS_GUNLERI.map((g) => GUN_ADLARI[g]).join(', ')}`);
  console.log(`ders         : ${say('Ders')} gun  (${yerlesen}/${dersler.length} ders)`);
  console.log(`deneme       : ${say('Deneme')} gun`);
  console.log(`hizli tekrar : ${say('Hızlı Tekrar')} gun`);
  console.log(`hafif        : ${say('Hafif Tekrar')} gun`);
  console.log(`toplam       : ${program.length} gun, ${Math.round(dk / 60)} saat`);
}

main();
