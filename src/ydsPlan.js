/**
 * YDS (Doktora) programinin PLANLAMA motoru.
 *
 * Bu dosya once yalnizca `scripts/yds-program-uret.js` icindeydi; oradan
 * cikarildi cunku artik iki yerden cagriliyor:
 *
 *   1. Script — yds-yokdil-app deposundaki icerigi okuyup
 *      `src/data/ydsProgram.json`'i uretir (gelistirici, commit'li).
 *   2. Uygulama — admin `/admin/yds` sayfasindan CALISMA GUNLERINI degistirince
 *      ayni motorla programi YENIDEN yayar. Boylece "doktora calismalari
 *      haftanin her gununu ya da ozel gunleri kapsasin" istegi bir deploy
 *      beklemeden, arayuzden karsilanir.
 *
 * Motor saf: takvim disinda hicbir seye bagli degil, veritabanina dokunmaz.
 */

const academicCalendar = require('./academicCalendar');

// Bir parcanin kac kez planlanacagi ve tekrar araliklari (gun).
const TEKRAR_ARALIKLARI = [3, 10];

// Tekrarlarin gunluk butcede kaplayabilecegi en fazla oran. Sinir olmazsa
// vadesi gelen tekrarlar gunu tamamen doldurup yeni icerigi kovuyor.
const TEKRAR_PAYI = 1 / 3;

const GUN_ADLARI = ['Pazar', 'Pazartesi', 'Salı', 'Çarşamba', 'Perşembe', 'Cuma', 'Cumartesi'];

// Hazir gun duzenleri. `ozel` = kullanicinin tek tek sectigi gunler.
const GUN_DUZENLERI = {
  'hafta-sonu': { etiket: 'Hafta Sonu (Cmt-Paz)', gunler: [0, 6] },
  'hafta-ici': { etiket: 'Hafta İçi (Pzt-Cum)', gunler: [1, 2, 3, 4, 5] },
  'her-gun': { etiket: 'Her Gün', gunler: [0, 1, 2, 3, 4, 5, 6] }
};

const VARSAYILAN_GUNLER = GUN_DUZENLERI['hafta-sonu'].gunler;
const VARSAYILAN_DAKIKA = 120;

function shiftDate(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function haftaninGunu(dateStr) {
  return new Date(`${dateStr}T00:00:00Z`).getUTCDay(); // 0=Pazar, 6=Cumartesi
}

/**
 * "0,6" / [0,6] / "hafta-sonu" gibi girdileri 0-6 arasi sirali benzersiz
 * diziye cevirir. Gecersiz/bos girdi varsayilana duser — arayuzden bos form
 * gelse bile program gunsuz kalmaz.
 */
function normalizeGunSet(value) {
  if (typeof value === 'string' && GUN_DUZENLERI[value]) {
    return [...GUN_DUZENLERI[value].gunler];
  }
  const ham = Array.isArray(value) ? value : String(value || '').split(',');
  const gunler = [
    ...new Set(
      ham
        // Bos parca ATILIR: Number('') === 0 oldugu icin bos form gonderimi
        // yoksa "yalnizca pazar" diye okunurdu.
        .map((g) => String(g == null ? '' : g).trim())
        .filter((g) => g !== '')
        .map((g) => Number(g))
        .filter((g) => Number.isInteger(g) && g >= 0 && g <= 6)
    )
  ].sort((a, b) => a - b);
  return gunler.length ? gunler : [...VARSAYILAN_GUNLER];
}

/** Gun kumesine karsilik gelen hazir duzenin adi; yoksa 'ozel'. */
function duzenAdi(gunSet) {
  const imza = normalizeGunSet(gunSet).join(',');
  for (const [ad, tanim] of Object.entries(GUN_DUZENLERI)) {
    if (tanim.gunler.join(',') === imza) return ad;
  }
  return 'ozel';
}

function gunSetEtiketi(gunSet) {
  const gunler = normalizeGunSet(gunSet);
  const ad = duzenAdi(gunler);
  if (ad !== 'ozel') return GUN_DUZENLERI[ad].etiket;
  return gunler.map((g) => GUN_ADLARI[g]).join(', ');
}

/**
 * Secilen hafta gunlerine denk gelen ogretim yili gunleri.
 *
 * Yalnizca resmi/dini bayramlar ve ogretim yili disi gunler cikarilir; ara
 * tatil ve yariyil tatili DAHILDIR (okul tatili YDS calismasini engellemez,
 * aksine o gunlerde daha cok vakit vardir).
 *
 * Not: getDayInfo() tatil donemini hafta sonundan once dondurur (ara tatildeki
 * cumartesi type='break' gelir), o yuzden gun secimi takvim etiketine degil
 * GERCEK HAFTA GUNUNE bakar.
 */
function calismaGunleri({ gunSet, baslangic, bitis } = {}) {
  const secili = new Set(normalizeGunSet(gunSet));
  const ilk = baslangic || academicCalendar.ACADEMIC_YEAR.start;
  const son = bitis || academicCalendar.ACADEMIC_YEAR.end;

  const gunler = [];
  let g = ilk;
  while (g <= son) {
    const bilgi = academicCalendar.getDayInfo(g);
    if (secili.has(haftaninGunu(g)) && bilgi.type !== 'holiday' && bilgi.type !== 'outside') {
      gunler.push(g);
    }
    g = shiftDate(g, 1);
  }
  return gunler;
}

/**
 * Gunleri doldurur. Her gun once VADESI GELEN tekrarlar, sonra YENI parcalar
 * yerlestirilir; boylece tekrar birikip kaymaz. Icerik bitince kalan gunler
 * "bekliyor" kalir — konu uydurulmaz.
 */
function programUret(parcalar, gunler, { gunlukDakika = VARSAYILAN_DAKIKA } = {}) {
  const butce = Number(gunlukDakika) > 0 ? Math.floor(Number(gunlukDakika)) : VARSAYILAN_DAKIKA;
  const yeniKuyruk = [...parcalar];
  const tekrarlar = []; // { parca, vade, sira }
  const program = [];

  gunler.forEach((tarih, gunIndex) => {
    const paket = [];
    let kalan = butce;

    // Yeni icerik bittikten sonra tekrarlarin takvimde delik birakmamasi icin
    // vade sarti kalkar ve kalan tekrarlar ardisik gunlere sikistirilir.
    const yeniBitti = yeniKuyruk.length === 0;
    let tekrarButcesi = yeniBitti ? butce : Math.floor(butce * TEKRAR_PAYI);

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
      gunAdi: GUN_ADLARI[haftaninGunu(tarih)],
      durum: paket.length ? 'dolu' : 'bekliyor',
      toplamSure: paket.reduce((t, p) => t + p.sure, 0),
      parcalar: paket.map((p) => ({
        id: p.id,
        tur: p.tur,
        turAdi: p.turAdi,
        baslik: p.baslik,
        sure: p.sure,
        tekrar: p.tekrar
      }))
    });
  });

  return program;
}

/**
 * Var olan bir planin KALAN occurrence'larini (parca gorunumlerini, tekrarlar
 * dahil) sirasiyla yeni gunlere yeniden yayar.
 *
 * Neden bastan uretmek yerine bu: bastan uretince "zaten islenmis" parcalar
 * elenmek zorunda kalir ve onlarin GELECEKTEKI TEKRARLARI da kaybolur —
 * takvimin geri kalani bos "serbest calisma" gunune doner. Burada icerik ve
 * tekrar sirasi oldugu gibi durur, yalnizca gunler degisir.
 *
 * Bir occurrence gunluk butceye sigmiyorsa (ornegin 25 dk'lik test, 20 dk'lik
 * gune) kilitlenmemek icin gunun tamamini alir; aksi halde sonsuz donguye
 * girerdi.
 */
function yenidenYay(occurrences, gunler, { gunlukDakika = VARSAYILAN_DAKIKA } = {}) {
  const butce = Number(gunlukDakika) > 0 ? Math.floor(Number(gunlukDakika)) : VARSAYILAN_DAKIKA;
  const kuyruk = [...occurrences];
  const program = [];
  let i = 0;

  for (const tarih of gunler) {
    const paket = [];
    let kalan = butce;
    while (i < kuyruk.length) {
      const p = kuyruk[i];
      const sure = Number(p.sure) || 0;
      if (sure > kalan && paket.length) break;
      // Ayni parca ayni gune iki kez konmaz: source_key "ydsp:<tarih>:<parcaId>"
      // oldugu icin ikisi ayni anahtari uretir ve aktarimda biri sessizce
      // dusordu. Tekrar bir sonraki gune kayar.
      if (paket.some((x) => x.id === p.id)) break;
      paket.push(p);
      kalan -= sure;
      i += 1;
      if (kalan <= 0) break;
    }
    program.push({
      tarih,
      gunAdi: GUN_ADLARI[haftaninGunu(tarih)],
      durum: paket.length ? 'dolu' : 'bekliyor',
      toplamSure: paket.reduce((t, p) => t + (Number(p.sure) || 0), 0),
      parcalar: paket.map((p) => ({
        id: p.id,
        tur: p.tur,
        turAdi: p.turAdi,
        baslik: p.baslik,
        sure: Number(p.sure) || 0,
        tekrar: Number(p.tekrar) || 0
      }))
    });
  }

  return { program, yerlesmeyen: kuyruk.length - i };
}

/**
 * Var olan bir program dosyasindan BENZERSIZ parca listesini geri cikarir
 * (mufredat sirasinda, yalnizca ilk gorulusler — tekrarlar atlanir).
 *
 * Uygulama yds-yokdil-app deposuna erisemez; gun duzeni arayuzden
 * degistirildiginde yeniden yayilacak icerik buradan gelir.
 */
function parcalariCikar(programGunleri) {
  const gorulen = new Set();
  const parcalar = [];
  for (const gun of programGunleri || []) {
    for (const p of (gun && gun.parcalar) || []) {
      if (!p || !p.id || p.tekrar > 0 || gorulen.has(p.id)) continue;
      gorulen.add(p.id);
      parcalar.push({ id: p.id, tur: p.tur, turAdi: p.turAdi, baslik: p.baslik, sure: p.sure });
    }
  }
  return parcalar;
}

module.exports = {
  GUN_ADLARI,
  GUN_DUZENLERI,
  VARSAYILAN_GUNLER,
  VARSAYILAN_DAKIKA,
  TEKRAR_ARALIKLARI,
  TEKRAR_PAYI,
  shiftDate,
  normalizeGunSet,
  duzenAdi,
  gunSetEtiketi,
  calismaGunleri,
  programUret,
  yenidenYay,
  parcalariCikar
};
