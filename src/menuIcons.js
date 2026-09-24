/**
 * Kenar cubugu menusundeki 16px cizgi ikonlari.
 *
 * Referans tasarimda (gapdekont.akkayasoft.com) her menu satirinda etiketin
 * solunda 16px'lik bir cizgi ikonu var; menunun okunurlugunun buyuk kismi
 * oradan geliyor. Uygulama EJS ile render edildigi ve derleme adimi olmadigi
 * icin bir ikon paketi yerine SVG'ler burada duruyor: tek dosya, bagimlilik
 * yok, gorunumde satir ici olarak basiliyor (`<%- menuIcons.dashboard %>`).
 *
 * Kurallar: 24x24 viewBox, yalnizca CIZGI (fill yok), renk `currentColor`
 * uzerinden gelir — boylece aktif/pasif satirda metinle ayni rengi alir.
 */

function svg(icerik) {
  return (
    '<svg class="menu-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    icerik +
    '</svg>'
  );
}

const menuIcons = {
  // Genel durum / pano
  dashboard: svg('<rect x="3" y="3" width="7" height="8" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="11" width="7" height="10" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/>'),
  // Ogrenciler
  students: svg('<circle cx="9" cy="8" r="3.2"/><path d="M3.5 20a5.5 5.5 0 0 1 11 0"/><path d="M16.5 7.2a3 3 0 0 1 0 5.6"/><path d="M18 20a5 5 0 0 0-2.4-4.3"/>'),
  // Kullanici yonetimi
  users: svg('<circle cx="10" cy="8" r="3.2"/><path d="M4 20a6 6 0 0 1 12 0"/><circle cx="18.5" cy="16.5" r="2"/><path d="M18.5 12.5v1M18.5 19.5v1M21 15.2l-.9.5M16.9 17.8l-.9.5M21 17.8l-.9-.5M16.9 15.2l-.9-.5"/>'),
  // Kategoriler
  categories: svg('<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h4.6c.5 0 1 .2 1.4.6l8 8a2 2 0 0 1 0 2.8l-4.1 4.1a2 2 0 0 1-2.8 0l-8-8A2 2 0 0 1 3 11z"/><circle cx="7.8" cy="9.8" r="1.2"/>'),
  // Gorevler
  tasks: svg('<path d="M3.5 6.5l2 2 3-3.5"/><path d="M3.5 13l2 2 3-3.5"/><path d="M3.5 19.5l2 2 3-3.5"/><path d="M12 7h9M12 13.5h9M12 20h9"/>'),
  // Haftalik analiz
  analysis: svg('<path d="M4 20V4"/><path d="M4 20h16"/><rect x="7.5" y="12" width="3" height="5" rx="0.8"/><rect x="13" y="8" width="3" height="9" rx="0.8"/><rect x="18" y="5" width="3" height="12" rx="0.8"/>'),
  // Aylik hedefler
  goals: svg('<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.8"/><circle cx="12" cy="12" r="1.3"/>'),
  // Yapay zeka programi
  ai: svg('<rect x="7" y="7" width="10" height="10" rx="2"/><path d="M10 3.5v3M14 3.5v3M10 17.5v3M14 17.5v3M3.5 10h3M3.5 14h3M17.5 10h3M17.5 14h3"/>'),
  // Uyanma rutini
  wake: svg('<path d="M3 18h18"/><path d="M7.5 18a4.5 4.5 0 0 1 9 0"/><path d="M12 3v3M5.2 6.2l2 2M18.8 6.2l-2 2"/><path d="M5 21.5h14"/>'),
  // Spor rutini
  sport: svg('<path d="M3 12h3l2.5-6 4 13 3-9 2 2h3.5"/>'),
  // Namaz rutini: kubbe + iki minare (cizgi, dolgu yok)
  prayer: svg('<path d="M5.5 20v-6.5a6.5 6.5 0 0 1 13 0V20"/><path d="M3 20h18"/><path d="M12 7V4.5"/><path d="M3.5 20v-8.5M3.5 11.5l-.8-1.5.8-1.5.8 1.5z"/><path d="M20.5 20v-8.5M20.5 11.5l-.8-1.5.8-1.5.8 1.5z"/>'),
  // YDS takibi
  yds: svg('<path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H11a2 2 0 0 1 2 2v14a1.6 1.6 0 0 0-1.6-1.6H5.5A1.5 1.5 0 0 1 4 17z"/><path d="M20 5.5A1.5 1.5 0 0 0 18.5 4H13v16a1.6 1.6 0 0 1 1.6-1.6h3.9A1.5 1.5 0 0 0 20 17z"/>'),
  // Ders programi
  schedule: svg('<rect x="3.5" y="5" width="17" height="16" rx="2"/><path d="M3.5 10h17"/><path d="M8 3v4M16 3v4"/><path d="M8 14h3M8 17.5h3M14 14h2.5"/>'),
  // Raporlar
  reports: svg('<path d="M14 3.5H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5z"/><path d="M14 3.5v5h5"/><path d="M8.5 13h7M8.5 16.5h5"/>'),
  // Gorev ekle
  newTask: svg('<rect x="3.5" y="3.5" width="17" height="17" rx="2.5"/><path d="M12 8.5v7M8.5 12h7"/>'),
  // Yillik plan
  program: svg('<rect x="3.5" y="5" width="17" height="16" rx="2"/><path d="M3.5 10h17"/><path d="M8 3v4M16 3v4"/><circle cx="8" cy="14" r="1"/><circle cx="12" cy="14" r="1"/><circle cx="16" cy="14" r="1"/><circle cx="8" cy="17.5" r="1"/><circle cx="12" cy="17.5" r="1"/>'),
  // --- Ozet karti (KPI) kose ikonlari -------------------------------------
  // Menude kullanilmayan, yalnizca kartlarda gecen kavramlar.
  clock: svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 1.8"/>'),
  check: svg('<circle cx="12" cy="12" r="8.5"/><path d="M8.5 12.2l2.4 2.4 4.6-5"/>'),
  archive: svg('<rect x="3.5" y="4.5" width="17" height="4.5" rx="1.2"/><path d="M5 9v9.5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9"/><path d="M10 13h4"/>'),
  percent: svg('<path d="M6 18L18 6"/><circle cx="7.8" cy="7.8" r="2.3"/><circle cx="16.2" cy="16.2" r="2.3"/>'),
  streak: svg('<path d="M12 3.5s4.5 3.6 4.5 8a4.5 4.5 0 1 1-9 0c0-1.6.6-2.9 1.3-3.9.3 1.2 1 2 1.9 2.2-.3-2.5.4-4.7 1.3-6.3z"/>'),
  duration: svg('<path d="M8 3h8M8 21h8"/><path d="M9 3v3.2c0 1.6 3 2.6 3 5.8s-3 4.2-3 5.8V21"/><path d="M15 3v3.2c0 1.6-3 2.6-3 5.8s3 4.2 3 5.8V21"/>'),
  money: svg('<rect x="3" y="6" width="18" height="12" rx="2"/><circle cx="12" cy="12" r="2.6"/><path d="M6.5 12h.01M17.5 12h.01"/>'),

  // Soru takibi
  questions: svg('<rect x="5" y="4.5" width="14" height="16" rx="2"/><path d="M9 4.5a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 15 4.5v1H9z"/><path d="M10.2 11.2a1.9 1.9 0 1 1 2.4 1.8c-.5.2-.8.6-.8 1.1v.3"/><circle cx="11.9" cy="17" r="0.7" fill="currentColor" stroke="none"/>')
};

module.exports = { menuIcons };
