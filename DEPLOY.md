# Deploy Guide

> Bu projenin canlı deploy'u **otomatiktir**. `main`'e push etmek yeterlidir;
> değişiklik ~1 dakika içinde canlıya çıkar.
>
> Eski "Hostinger" kurgusu (`scripts/deploy-hostinger.sh`, `.env.deploy`,
> `.github/workflows/deploy-hostinger.yml`) **kullanılmıyor**, geçmişten kalmadır.

## Canlı ortam

- **URL:** https://takip.obs.akkayasoft.com/
- **Sunucu:** VPS `obs-vps` (187.127.68.167), **nginx (Ubuntu)** reverse proxy arkasında
- **Uygulama servisi:** systemd `ayhanakkaya-site.service`
  - `WorkingDirectory=/var/www/ayhanakkayasite`
  - `ExecStart=/usr/bin/node /var/www/ayhanakkayasite/src/app.js`
  - `User=www-data`, `NODE_ENV=production`, port 3000

## Otomatik deploy nasıl çalışır

Sunucuda bir systemd timer her dakika deploy script'ini çalıştırır:

- **Timer:** `ayhanakkayasite-deploy.timer` (`OnUnitActiveSec=1min`)
- **Service:** `ayhanakkayasite-deploy.service` → `/usr/local/bin/deploy-ayhanakkayasite.sh`

Script şunu yapar:

```bash
cd /var/www/ayhanakkayasite
git fetch origin main
# HEAD == origin/main ise atla; değilse:
git pull --ff-only origin main
npm ci --omit=dev
chown -R www-data:www-data /var/www/ayhanakkayasite
systemctl restart ayhanakkaya-site.service
```

## Geliştirici akışı

1. Lokalde değişiklik yap ve test et (`npm start`).
2. `git push origin main`.
3. ~1 dakika bekle; deploy timer çekip yeniden başlatır.
4. Doğrula: `curl https://takip.obs.akkayasoft.com/healthz`

## Faydalı komutlar (sunucuda)

```bash
# Deploy log'u
journalctl -t deploy-ayhanakkayasite -n 50
# Uygulama log'u
journalctl -u ayhanakkaya-site.service -n 50
# Servis durumu / manuel restart
systemctl status ayhanakkaya-site.service
systemctl restart ayhanakkaya-site.service
# Deploy'u beklemeden elle tetikle
systemctl start ayhanakkayasite-deploy.service
```

## Production ortam değişkenleri

Sunucudaki `.env` (repoda yok) en az şunları içermeli:

- `NODE_ENV=production`
- `PORT` (nginx upstream ile uyumlu, 3000)
- `DATABASE_URL` (PostgreSQL bağlantısı)
- `SESSION_SECRET` (güçlü, rastgele — varsayılanı KULLANMA)
- `DEFAULT_ADMIN_USERNAME` / `DEFAULT_ADMIN_PASSWORD` (ilk seed sonrası değiştir)
- `DATABASE_SSL` (gerekiyorsa `true`)

Uygulama açılışta tabloları otomatik kurar ve ilk admin'i seed eder.
