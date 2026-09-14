/**
 * yds.obs (akkayasoft/yds-yokdil-app) icerigini tek bir "parca" listesine
 * cevirir — mufredat sirasinda, tur ve sure bilgisiyle.
 *
 * Bu dosya yalnizca SCRIPT tarafindan kullanilir: uygulamanin calisma aninda
 * yds-yokdil-app deposuna erisimi yok. Cikti `src/data/ydsUygulamalar.json`
 * olarak commit edilir, program ureticileri o dosyayi okur.
 *
 * Iki uretici de ayni kurallari kullansin diye buraya cikarildi; onceden
 * yalnizca yds-program-uret.js icindeydi ve sinav ureticisi daha kaba bir
 * kopyasini kullaniyordu (butun deste/okuma/test = 40 parca). Ince cikarim
 * dersleri BOLUMLERE, okumalari OTURUMLARA ayirir -> 56 parca.
 */

const fs = require('fs');
const path = require('path');

// Tur basina tahmini sureler (dk) — olcum degil, makul tahmin.
const SURE = { konu: 15, kelime: 12, okuma: 20, test: 25 };

const TUR_ADI = {
  konu: 'Konu Anlatımı',
  kelime: 'Kelime',
  okuma: 'Okuma',
  test: 'Test'
};

// Uygulamada parcanin bulundugu ekran — gorev basliginda gosterilir.
const EKRAN = {
  konu: 'Dilbilgisi → Konu Anlatımı',
  kelime: 'Kelime → Desteler',
  okuma: 'Reading',
  test: 'Dilbilgisi → Testler'
};

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

module.exports = { SURE, TUR_ADI, EKRAN, parcalariTopla };
