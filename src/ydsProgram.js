const fs = require('fs');
const path = require('path');

const PROGRAM_PATH = path.join(__dirname, 'data', 'ydsProgram.json');

// tasks.source_key on eki. YZ programindan ('yz:') ve YDS soru
// senkronundan ('yds:', daily_questions) ayri tutulur.
const SOURCE_PREFIX = 'ydsp';

// Icerigi bitmis gunlerde acilan serbest calisma gorevinin parca kimligi.
const SERBEST_ID = 'serbest';

const KATEGORI = {
  konu: 'YDS · Konu Anlatımı',
  kelime: 'YDS · Kelime',
  okuma: 'YDS · Okuma',
  test: 'YDS · Test',
  serbest: 'YDS · Serbest Çalışma'
};

let cache = null;

function sourceKey(tarih, parcaId) {
  return `${SOURCE_PREFIX}:${tarih}:${parcaId}`;
}

/**
 * scripts/yds-program-uret.js ciktisini okur.
 * Dosya yoksa/bozuksa uygulama patlamamali; bos program doner.
 */
function loadYdsProgram() {
  if (cache) return cache;

  try {
    const parsed = JSON.parse(fs.readFileSync(PROGRAM_PATH, 'utf-8'));
    const gunler = Array.isArray(parsed.gunler) ? parsed.gunler : [];

    const gorevler = [];
    for (const gun of gunler) {
      if (!gun || typeof gun.tarih !== 'string') continue;

      if (gun.durum === 'dolu' && Array.isArray(gun.parcalar) && gun.parcalar.length) {
        for (const parca of gun.parcalar) {
          if (!parca || !parca.id || !parca.baslik) continue;
          gorevler.push({
            tarih: gun.tarih,
            parcaId: parca.id,
            sourceKey: sourceKey(gun.tarih, parca.id),
            tur: parca.tur,
            turAdi: parca.turAdi || parca.tur,
            kategoriAd: KATEGORI[parca.tur] || KATEGORI.serbest,
            baslik: String(parca.baslik),
            sure: Number(parca.sure) || 0,
            tekrar: Number(parca.tekrar) || 0
          });
        }
        continue;
      }

      // Icerik bekleyen gun: gunluk calisma disiplini surer, konu uydurulmaz.
      gorevler.push({
        tarih: gun.tarih,
        parcaId: SERBEST_ID,
        sourceKey: sourceKey(gun.tarih, SERBEST_ID),
        tur: 'serbest',
        turAdi: 'Serbest Çalışma',
        kategoriAd: KATEGORI.serbest,
        baslik: 'YDS/YÖKDİL çalışması',
        sure: Number(parsed.gunlukDakika) || 60,
        tekrar: 0
      });
    }

    cache = {
      surum: parsed.surum || '',
      kaynak: parsed.kaynak || '',
      baslangic: parsed.baslangic || null,
      bitis: parsed.bitis || null,
      gunlukDakika: Number(parsed.gunlukDakika) || 60,
      toplamParca: Number(parsed.toplamParca) || 0,
      dersGunu: Number(parsed.dersGunu) || gunler.length,
      doluGun: Number(parsed.doluGun) || 0,
      bekleyenGun: Number(parsed.bekleyenGun) || 0,
      gorevler
    };
  } catch (err) {
    console.error('YDS programı okunamadı:', err.message);
    cache = {
      surum: '',
      kaynak: '',
      baslangic: null,
      bitis: null,
      gunlukDakika: 60,
      toplamParca: 0,
      dersGunu: 0,
      doluGun: 0,
      bekleyenGun: 0,
      gorevler: []
    };
  }

  return cache;
}

/** Gorev aciklamasi: tur, sure ve tekrar bilgisi. */
function describeItem(gorev) {
  const parcalar = [gorev.turAdi, `${gorev.sure} dk`];
  if (gorev.tekrar > 0) parcalar.push(`${gorev.tekrar}. tekrar`);
  parcalar.push(`yds.obs · ${gorev.parcaId}`);
  return parcalar.join(' · ');
}

module.exports = {
  PROGRAM_PATH,
  SOURCE_PREFIX,
  KATEGORI,
  sourceKey,
  loadYdsProgram,
  describeItem
};
