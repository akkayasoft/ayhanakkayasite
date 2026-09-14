#!/usr/bin/env node
/**
 * yds.obs icerigini `src/data/ydsUygulamalar.json`'a cikarir.
 *
 *   node scripts/yds-uygulama-cikar.js --yds /yol/yds-yokdil-app
 *
 * Sinav programindaki UYGULAMA GUNLERI (Sal/Per/Cum) bu dosyadan beslenir.
 * Uygulamanin calisma aninda yds-yokdil-app deposuna erisimi yok; bu yuzden
 * cikti commit edilir. Icerik buyuyunce (yeni test/deste/okuma) bu betigi
 * tekrar calistir, commit'le, sonra programi yeniden uret.
 *
 * Cikarim kurallari `src/ydsIcerik.js` icinde ve `yds-program-uret.js` ile
 * ORTAK: dersler bolumlere, okumalar oturumlara ayrilir. Ilk surumde sinav
 * ureticisi kendi kaba kopyasini kullaniyordu (butun deste/okuma/test =
 * 40 parca) ve ince kirilim kayboluyordu.
 */

const fs = require('fs');
const path = require('path');

const { TUR_ADI, EKRAN, parcalariTopla } = require('../src/ydsIcerik');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const YDS_DIR = arg('yds', path.resolve(__dirname, '../../yds-yokdil-app'));
const HEDEF = path.resolve(__dirname, '../src/data/ydsUygulamalar.json');

function main() {
  if (!fs.existsSync(path.join(YDS_DIR, 'content'))) {
    console.error(`YDS icerigi bulunamadi: ${YDS_DIR}/content`);
    console.error('Kullanim: node scripts/yds-uygulama-cikar.js --yds /yol/yds-yokdil-app');
    process.exit(1);
  }

  const parcalar = parcalariTopla(YDS_DIR).map((p) => ({
    id: p.id,
    tur: p.tur,
    turAdi: TUR_ADI[p.tur] || p.tur,
    ekran: EKRAN[p.tur] || '',
    baslik: p.baslik,
    sure: p.sure
  }));

  const cikti = {
    kaynak: 'akkayasoft/yds-yokdil-app · content/',
    not:
      'yds.obs uygulamasindaki uygulanabilir icerik. Icerik buyuyunce: ' +
      'node scripts/yds-uygulama-cikar.js --yds /yol/yds-yokdil-app',
    uretildi: new Date().toISOString().slice(0, 10),
    toplamSure: parcalar.reduce((a, p) => a + p.sure, 0),
    uygulamalar: parcalar
  };

  fs.mkdirSync(path.dirname(HEDEF), { recursive: true });
  fs.writeFileSync(HEDEF, `${JSON.stringify(cikti, null, 1)}\n`, 'utf-8');

  const say = {};
  parcalar.forEach((p) => (say[p.turAdi] = (say[p.turAdi] || 0) + 1));

  console.log(`hedef  : ${path.relative(process.cwd(), HEDEF)}`);
  console.log(`kaynak : ${YDS_DIR}`);
  console.log(`parca  : ${parcalar.length}  (${Object.entries(say).map(([k, v]) => `${k}:${v}`).join(' ')})`);
  console.log(`sure   : ${cikti.toplamSure} dk  (~${Math.round(cikti.toplamSure / 60)} saat)`);
}

main();
