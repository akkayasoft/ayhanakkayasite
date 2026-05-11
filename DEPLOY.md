# Deploy Guide (Hostinger)

Bu projede varsayilan production hedefi `Hostinger` olarak tanimlandi.

## Bir kere yap

1. `cp .env.production.example .env.deploy`
2. `.env.deploy` icine su alanlari doldur:
   - `HOSTINGER_SSH_HOST`
   - `HOSTINGER_SSH_USER`
   - `HOSTINGER_APP_DIR`
   - `HOSTINGER_BRANCH` (genelde `main`)
   - `HOSTINGER_RESTART_COMMAND` (zorunlu, restart komutun)
   - (opsiyonel) `HOSTINGER_PORT`

## Deploy komutlari

- Gercek deploy:
  - `npm run deploy:prod`
- Kontrol (baglanmadan):
  - `npm run deploy:prod:dry`

## Otomatik Deploy (onerilen)

`main` branch'ine her push'ta otomatik deploy calisir:

- Workflow: `.github/workflows/deploy-hostinger.yml`
- Gerekli GitHub Actions secrets:
  - `HOSTINGER_SSH_HOST`
  - `HOSTINGER_SSH_USER`
  - `HOSTINGER_SSH_KEY`
  - `HOSTINGER_APP_DIR`
  - `HOSTINGER_RESTART_COMMAND`
  - (opsiyonel) `HOSTINGER_PORT`

## Script ne yapiyor?

`scripts/deploy-hostinger.sh` su adimlari uzaktan calistirir:

1. App dizinine girer
2. `git fetch --all --prune`
3. `git checkout <branch>`
4. `git pull --ff-only origin <branch>`
5. `npm ci --omit=dev` (yoksa `npm install --omit=dev`)
6. `HOSTINGER_RESTART_COMMAND` calistirir

## Not

- `HOSTINGER_RESTART_COMMAND` placeholder deger ile gelir; kendi restart komutunla degistir.
- Shared hosting kullaniyorsan restart komutunu panelindeki yapiya gore ayarla.
