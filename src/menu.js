/**
 * Kenar cubugu menusu ve SAYFA BOLUMLERI — tek kaynak.
 *
 * Once her sayfa butun panellerini alt alta basiyordu: Ders Programi tek
 * ekranda 6, Uyanma Rutini 4 panel gosteriyordu ve sayfa okunmaz haldeydi.
 * Artik her sayfa BIR ALAN gosterir; sayfanin diger alanlari kenar cubugunda
 * o menunun altinda acilir (masaustunde uzerine gelince, telefonda aktif
 * sayfanin altinda serit olarak).
 *
 * Bolum secimi `?bolum=<anahtar>` ile gelir. Tanimsiz/gecersiz deger ilk
 * bolume duser — yani eski baglantilar (bolumsuz) calismaya devam eder.
 *
 * `sections` YOKSA sayfa tek alanlidir ve menu satiri duz bir baglantidir.
 * Bir bolum kendi `href`'ini tasiyorsa (Gorevler) `?bolum=` kullanilmaz:
 * o alanlar zaten ayri rotalarda duruyor.
 */

const ADMIN_MENU = [
  { key: 'dashboard', label: 'Genel Durum', icon: 'dashboard', href: '/admin/dashboard' },
  {
    key: 'students',
    label: 'Öğrenciler',
    icon: 'students',
    href: '/admin/students',
    sections: [
      { key: 'liste', label: 'Öğrenci Listesi' },
      { key: 'ekle', label: 'Yeni Öğrenci' }
    ]
  },
  {
    key: 'users',
    label: 'Kullanıcı Yönetimi',
    icon: 'users',
    href: '/admin/users',
    sections: [
      { key: 'liste', label: 'Kullanıcı Listesi' },
      { key: 'ekle', label: 'Yeni Kullanıcı' }
    ]
  },
  {
    key: 'categories',
    label: 'Kategoriler',
    icon: 'categories',
    href: '/admin/categories',
    sections: [
      { key: 'liste', label: 'Kategori Listesi' },
      { key: 'ekle', label: 'Yeni Kategori' }
    ]
  },
  {
    // Gorevlerin iki alani zaten ayri rotada; menude gorunur olmasi yetiyor.
    key: 'tasks',
    label: 'Görevler',
    icon: 'tasks',
    href: '/admin/tasks/active',
    pages: ['tasks', 'tasks-active', 'tasks-status'],
    sections: [
      { key: 'active', label: 'Tüm Görevler', href: '/admin/tasks/active', page: 'tasks-active' },
      { key: 'status', label: 'Durum Düzelt', href: '/admin/tasks/status', page: 'tasks-status' }
    ]
  },
  {
    key: 'analysis',
    label: 'Haftalık Analiz',
    icon: 'analysis',
    href: '/admin/analysis',
    sections: [
      { key: 'karsilastirma', label: 'Öğrenci Karşılaştırması' },
      { key: 'kategori', label: 'Kategori Kırılımı' },
      { key: 'gun', label: 'Gün Kırılımı' }
    ]
  },
  {
    key: 'goals',
    label: 'Aylık Hedefler',
    icon: 'goals',
    href: '/admin/goals',
    sections: [
      { key: 'hedefler', label: 'Hedefler' },
      { key: 'kayit', label: 'Ayın Kaydı' },
      { key: 'ekle', label: 'Yeni Hedef' }
    ]
  },
  {
    key: 'wake',
    label: 'Uyanma Rutini',
    icon: 'wake',
    href: '/admin/wake',
    sections: [
      { key: 'rutinler', label: 'Öğrenci Rutinleri' },
      { key: 'kayitlar', label: 'Günlük Kayıtlar' },
      { key: 'ayar', label: 'Rutin Ayarla' }
    ]
  },
  {
    key: 'sport',
    label: 'Spor Rutini',
    icon: 'sport',
    href: '/admin/sport',
    sections: [
      { key: 'rutinler', label: 'Öğrenci Rutinleri' },
      { key: 'kayitlar', label: 'Günlük Kayıtlar' },
      { key: 'ayar', label: 'Rutin Ayarla' }
    ]
  },
  {
    key: 'ai',
    label: 'Yapay Zeka Rutini',
    icon: 'ai',
    href: '/admin/ai',
    sections: [
      { key: 'rutinler', label: 'Öğrenci Rutinleri' },
      { key: 'kayitlar', label: 'Günlük Kayıtlar' },
      { key: 'ayar', label: 'Rutin Ayarla' }
    ]
  },
  {
    key: 'prayer',
    label: 'Namaz Rutini',
    icon: 'prayer',
    href: '/admin/prayer',
    sections: [
      { key: 'rutinler', label: 'Öğrenci Rutinleri' },
      { key: 'kayitlar', label: 'Günlük Kayıtlar' },
      { key: 'ayar', label: 'Rutin Ayarla' }
    ]
  },
  {
    key: 'schedule',
    label: 'Ders Programı',
    icon: 'schedule',
    href: '/admin/schedule',
    sections: [
      { key: 'cizelge', label: 'Haftalık Çizelge' },
      { key: 'ozet', label: 'Gün Özeti' },
      { key: 'ders', label: 'Ders Ekle' },
      { key: 'yapistir', label: 'Toplu Yapıştır' },
      { key: 'hafta', label: 'Hafta Seçimi' },
      { key: 'zil', label: 'Zil Çizelgesi' },
      { key: 'gunzil', label: 'Gün Gün Zil Saatleri' },
      { key: 'konular', label: 'İşlenen Konular' },
      { key: 'gorevler', label: 'Ders Görevleri' },
      { key: 'defter', label: 'Defteri Kim Yazabilir' },
      { key: 'excel', label: 'Excel Çıktısı' }
    ]
  },
  { key: 'reports', label: 'Raporlar', icon: 'reports', href: '/admin/reports' }
];

const STUDENT_MENU = [
  { key: 'dashboard', label: 'Görevlerim', icon: 'tasks', href: '/student/dashboard' },
  { key: 'calendar', label: 'Haftalık Takvim', icon: 'schedule', href: '/student/calendar' },
  {
    key: 'program',
    label: 'Yıllık Plan',
    icon: 'program',
    href: '/student/program',
    sections: [
      { key: 'icerik', label: 'Seçili Hafta' },
      { key: 'haftalar', label: 'Öğretim Yılının Haftaları' }
    ]
  },
  {
    key: 'schedule',
    label: 'Ders Programı',
    icon: 'yds',
    href: '/student/schedule',
    sections: [
      { key: 'cizelge', label: 'Haftalık Çizelge' },
      { key: 'ozet', label: 'Gün Özeti' },
      { key: 'konular', label: 'İşlenen Konular' },
      { key: 'excel', label: 'Excel Çıktısı' }
    ]
  },
  {
    key: 'questions',
    label: 'Soru Takibi',
    icon: 'questions',
    href: '/student/questions',
    sections: [
      { key: 'ekle', label: 'Günlük Kayıt' },
      { key: 'liste', label: 'Son Kayıtlar' }
    ]
  },
  {
    key: 'wake',
    label: 'Uyanma Rutini',
    icon: 'wake',
    href: '/student/wake',
    sections: [
      { key: 'durum', label: 'Bugün' },
      { key: 'gecmis', label: 'Son Günler' }
    ]
  },
  {
    key: 'sport',
    label: 'Spor Rutini',
    icon: 'sport',
    href: '/student/sport',
    sections: [
      { key: 'durum', label: 'Bugün' },
      { key: 'gecmis', label: 'Son Günler' }
    ]
  },
  {
    key: 'ai',
    label: 'Yapay Zeka Rutini',
    icon: 'ai',
    href: '/student/ai',
    sections: [
      { key: 'durum', label: 'Bugün' },
      { key: 'gecmis', label: 'Son Günler' }
    ]
  },
  {
    key: 'prayer',
    label: 'Namaz Rutini',
    icon: 'prayer',
    href: '/student/prayer',
    sections: [
      { key: 'durum', label: 'Bugün' },
      { key: 'gecmis', label: 'Son Günler' }
    ]
  },
  {
    key: 'goals',
    label: 'Aylık Hedefler',
    icon: 'goals',
    href: '/student/goals',
    sections: [
      { key: 'hedefler', label: 'Hedefler' },
      { key: 'kayit', label: 'Ayın Kaydı' }
    ]
  }
];

/** Bir sayfanin menu satiri. `pages` varsa o liste, yoksa `key` eslesir. */
function findItem(menu, currentPage) {
  return (
    menu.find((item) =>
      Array.isArray(item.pages) ? item.pages.includes(currentPage) : item.key === currentPage
    ) || null
  );
}

/**
 * Gecerli bolum anahtari. Istenen bolum tanimli degilse ILK bolume duser;
 * boylece bolumsuz eski baglantilar kirilmaz. Kendi rotasi olan bolumler
 * (`href` tasiyanlar) sayfanin kendi adindan bulunur.
 */
function resolveSection(menu, currentPage, requested) {
  const item = findItem(menu, currentPage);
  if (!item || !Array.isArray(item.sections) || !item.sections.length) return null;

  const kendiRotasi = item.sections.find((s) => s.page === currentPage);
  if (kendiRotasi) return kendiRotasi.key;

  const bulunan = item.sections.find((s) => s.key === requested);
  return bulunan ? bulunan.key : item.sections[0].key;
}

/**
 * Sablonun bastigi menu agaci: her satirda aktiflik ve (varsa) bolum
 * baglantilari hazir gelir, sablon karar vermez.
 */
function buildMenuTree(menu, currentPage, currentSection) {
  return menu.map((item) => {
    const aktif = Array.isArray(item.pages)
      ? item.pages.includes(currentPage)
      : item.key === currentPage;
    return {
      key: item.key,
      label: item.label,
      icon: item.icon,
      href: item.href,
      aktif,
      sections: (item.sections || []).map((s) => ({
        key: s.key,
        label: s.label,
        href: s.href || `${item.href}?bolum=${s.key}`,
        aktif: aktif && s.key === currentSection
      }))
    };
  });
}

/** Aktif sayfanin aktif bolum etiketi (sayfa basligi altinda gosterilir). */
function sectionLabel(menu, currentPage, currentSection) {
  const item = findItem(menu, currentPage);
  if (!item || !item.sections) return null;
  const s = item.sections.find((x) => x.key === currentSection);
  return s ? s.label : null;
}

module.exports = {
  ADMIN_MENU,
  STUDENT_MENU,
  findItem,
  resolveSection,
  buildMenuTree,
  sectionLabel
};
