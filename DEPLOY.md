# Deploy Guide

> ⚠️ Bu projenin canlı deploy'u **manuel** yapılır. Eski "Hostinger otomatik deploy"
> kurgusu (`scripts/deploy-hostinger.sh`, `.github/workflows/deploy-hostinger.yml`,
> `.env.deploy`) **kullanılmıyor** ve geçmişten kalmadır.

## Canlı ortam

- **URL:** https://takip.obs.akkayasoft.com/
- **Sunucu:** kendi VPS'i, **nginx/1.24 (Ubuntu)** reverse proxy arkasında Node.js uygulaması
- **Otomatik CI deploy:** yok (GitHub Actions workflow'u devre dışı / no-op)

## Manuel deploy adımları (sunucuda)

Repodaki değişiklik, sunucuda aşağıdaki adımlar manuel çalıştırılana kadar canlıya gitmez:

```bash
ssh <kullanici>@<sunucu>
cd <app-dizini>
git pull --ff-only origin main
npm ci --omit=dev          # bağımlılık değiştiyse
# uygulamayı yeniden başlat (process manager'a göre):
pm2 restart ogrenci-takip  # veya: sudo systemctl restart <servis-adi>
```

> Gerçek SSH kullanıcısı, sunucu adresi, app dizini ve restart komutu bu repoda
> tutulmaz. Bunları doldurmak için sunucu erişim bilgilerine ihtiyaç vardır.

## Production ortam değişkenleri

Sunucudaki `.env` (repoda yok) en az şunları içermeli:

- `NODE_ENV=production`
- `PORT` (nginx upstream ile uyumlu)
- `DATABASE_URL` (PostgreSQL bağlantısı)
- `SESSION_SECRET` (güçlü, rastgele — varsayılanı KULLANMA)
- `DEFAULT_ADMIN_USERNAME` / `DEFAULT_ADMIN_PASSWORD` (ilk seed sonrası değiştir)
- `DATABASE_SSL` (gerekiyorsa `true`)

Uygulama açılışta tabloları otomatik kurar ve ilk admin'i seed eder.
