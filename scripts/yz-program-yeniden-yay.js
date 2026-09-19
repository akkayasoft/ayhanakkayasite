#!/usr/bin/env node
/**
 * YZ programini GUNLUK SURE BUTCESINE gore yeniden yayar.
 *
 * Neden ayri bir script: `yz-program-uret.js` ders listesini platform
 * deposundaki (akkayasoft/uretken-yz-platform) dersler.py'den okur ve gune BIR
 * ders koyar. Burada ders listesi zaten commit'li `src/data/yzProgram.json`'dan
 * geldigi icin platform deposuna ihtiyac yok; yapilan is yalnizca TARIH
 * atamak. Kullanim sebebi: gunluk calisma duzeni "her gun 1 saat"e cevrildi,
 * yani bir gune birden fazla kisa ders dusebilir.
 *
 * Kullanim:
 *   node scripts/yz-program-yeniden-yay.js                # her gun, 60 dk
 *   node scripts/yz-program-yeniden-yay.js --dakika 90
 *   node scripts/yz-program-yeniden-yay.js --gunler 1,2,3,4,5
 *   node scripts/yz-program-yeniden-yay.js --baslangic 2026-10-01
 *
 * Kurallar:
 *  - `--baslangic`tan ONCEKI dersler oldugu gibi kalir (gecmis oynatilmaz);
 *    varsayilan baslangic bugundur.
 *  - Gun secimi YDS motoruyla ayni: resmi/dini bayramlar ve ogretim yili disi
 *    gunler atlanir, ara tatil ve yariyil tatili calisma gunudur.
 *  - Butceye sigmayan tek ders (ornegin 65 dk'lik ders, 60 dk'lik gun) gunu
 *    tek basina alir; ders BOLUNMEZ. YDS'de bolme var cunku oradaki parca 180
 *    dk'lik bir video; burada en uzun ders 65 dk ve mufredat ders kimligi
 *    (yz:<dersId>) uzerinden aktariliyor, uydurma alt-ders kimligi
 *    uretilmemeli.
 *
 * Uretilen dosya commit edilir; ardindan admin panelinde "YZ Programı" →
 * "Görevlere Aktar" ile tarihler mevcut gorevlere islenir (yalnizca
 * isaretlenmemis ve gunu gelmemis gorevler tasinir).
 */

const fs = require('fs');
const path = require('path');

const academicCalendar = require('../src/academicCalendar');
const ydsPlan = require('../src/ydsPlan');

const HEDEF = path.resolve(__dirname, '../src/data/yzProgram.json');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function bugun() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: process.env.APP_TIMEZONE || 'Europe/Istanbul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date());
}

function main() {
  const dakika = Number(arg('dakika', '60'));
  if (!Number.isFinite(dakika) || dakika < 15 || dakika > 600) {
    console.error('--dakika 15 ile 600 arasinda olmali.');
    process.exit(1);
  }
  const gunSet = ydsPlan.normalizeGunSet(arg('gunler', '0,1,2,3,4,5,6'));
  const baslangic = arg('baslangic', bugun());

  const program = JSON.parse(fs.readFileSync(HEDEF, 'utf-8'));
  const dersler = Array.isArray(program.gorevler) ? program.gorevler : [];
  if (!dersler.length) {
    console.error('yzProgram.json icinde ders yok.');
    process.exit(1);
  }

  // Gecmis dersler yerinde kalir; yalnizca baslangic ve sonrasi yeniden yayilir.
  const sabit = dersler.filter((d) => d.tarih < baslangic);
  const tasinacak = dersler.filter((d) => d.tarih >= baslangic);

  const gunler = ydsPlan.calismaGunleri({ gunSet, baslangic });
  if (!gunler.length) {
    console.error('Secilen gun duzeninde ogretim yili icinde calisma gunu kalmadi.');
    process.exit(1);
  }

  const yerlesen = [];
  let i = 0;
  for (const gun of gunler) {
    let kalan = dakika;
    let gunlukAdet = 0;
    while (i < tasinacak.length) {
      const ders = tasinacak[i];
      const sure = Number(ders.sure) || 0;
      // Bos gune sigmayan tek ders gunu tek basina alir (bolunmez).
      if (sure > kalan && gunlukAdet > 0) break;
      yerlesen.push({ ...ders, tarih: gun });
      kalan -= sure;
      gunlukAdet += 1;
      i += 1;
      if (kalan <= 0) break;
    }
    if (i >= tasinacak.length) break;
  }

  const sigmayan = tasinacak.length - i;
  const gorevler = [...sabit, ...yerlesen].sort(
    (a, b) => a.tarih.localeCompare(b.tarih) || String(a.dersId).localeCompare(String(b.dersId), 'tr')
  );

  const gunBasinaSure = new Map();
  for (const g of yerlesen) {
    gunBasinaSure.set(g.tarih, (gunBasinaSure.get(g.tarih) || 0) + (Number(g.sure) || 0));
  }

  const cikti = {
    ...program,
    surum: `${academicCalendar.ACADEMIC_YEAR.label}.gunluk-${dakika}dk`,
    baslangic: gorevler.length ? gorevler[0].tarih : null,
    bitis: gorevler.length ? gorevler[gorevler.length - 1].tarih : null,
    toplamDers: dersler.length,
    yerlesen: gorevler.length,
    haftalikGun: gunSet.length,
    gunSet: gunSet.join(','),
    gunlukDakika: dakika,
    gorevler
  };

  fs.writeFileSync(HEDEF, `${JSON.stringify(cikti, null, 1)}\n`, 'utf-8');

  const gunSayisi = gunBasinaSure.size;
  const ortalama = gunSayisi
    ? Math.round([...gunBasinaSure.values()].reduce((t, v) => t + v, 0) / gunSayisi)
    : 0;
  console.log(`ders            : ${dersler.length} (sabit ${sabit.length}, yeniden yayilan ${yerlesen.length})`);
  console.log(`gun duzeni      : ${ydsPlan.gunSetEtiketi(gunSet)} · ${dakika} dk/gun`);
  console.log(`yayilan gun     : ${gunSayisi} (ortalama ${ortalama} dk/gun)`);
  console.log(`ilk / son       : ${cikti.baslangic} → ${cikti.bitis}`);
  if (sigmayan > 0) console.log(`UYARI: ${sigmayan} ders ogretim yilina sigmadi.`);
}

main();
