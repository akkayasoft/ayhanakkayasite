# Codex Notes

- Canlı URL: https://takip.obs.akkayasoft.com/
- Production ortamı: kendi VPS'i, nginx/1.24 (Ubuntu) reverse proxy arkasında
- Deploy yöntemi: MANUEL (SSH üzerinden git pull + servis restart). Otomatik CI deploy yok.
- Proje genel bakışı ve gerçek deploy durumu: `CLAUDE.md`

> Not: `scripts/deploy-hostinger.sh`, `.env.deploy` ve eski "Hostinger" referansları
> kullanılmıyor; geçmişten kalmadır. Gerçek durum için `CLAUDE.md`'ye bak.
