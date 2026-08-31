# Community Solar Kiosk Dashboard

Real-time solar production dashboard for the Affordable Solar Group community
solar sites across New Mexico. A single codebase deploys to one Railway service
per site; each site's identity and AlsoEnergy configuration is supplied
entirely through environment variables.

## Sites

| Site                          | AlsoEnergy Site ID | Meter ID | AC (kW) | DC (kW) | City         | Railway service    |
|-------------------------------|--------------------|----------|---------|---------|--------------|--------------------|
| Cuidando Los Niños (CLN)      | 72296              | 570224   | 4975    | 6499    | Belen        | CLN-dashboard      |
| Central New Mexico (CNM)      | 72862              | 578792   | 4975    | 7979    | Belen        | CNMCC-dashboard    |
| Locker 505                    | 72861              | 588711   | 4975    | 7003    | Rio Rancho   | L505-dashboard     |
| Global Give a Book (GGAB)     | 72859              | 578835   | 4975    | 7685    | Los Lunas    | GGAB-dashboard     |
| Wings for Life (WFL)          | 72858              | 596696   | 4975    | 7767    | Las Cruces   | WFL-dashboard      |
| WESST                         | 72860              | 597714   | 4975    | 7462    | Roswell      | WESST-dashboard    |
| Homewise                      | 74628              | 611259   | 4975    | 6947    | Rio Rancho   | Homewise-dashboard |

Homewise (SLO 2) energized in August 2026 and is still commissioning: all 20
inverters report `Operating` and live kW is good, but the production meter has
only intermittent history (first full day 2026-08-19). Expect the *Yesterday*
and *7-Day History* panels to read zero until the meter uploads continuously.
Its AC/DC come from the AlsoEnergy inverter nameplate (19 x 250 kW + 1 x 225 kW
= 4,975 kW AC); DC is carried as 6,947 kW to match the figure Solscribe uses in
anchor allocation and PRC disclosures, though the nameplate module config sums
to 6,835 kW.

`PV_SIZE_AC` is 4,975 kW at every site — the NM community-solar interconnect
limit, confirmed against the AlsoEnergy inverter nameplate. GGAB and L505 were
corrected 2026-08-31: GGAB had AC and DC transposed (`AC 7790 / DC 4975`), which
made `server.js`'s `currentKW / PV_SIZE_AC` capacity readout ~36% low, and L505
carried `AC 5835`. DC values track `db/migrations/113_anchor_deal_desk_settings.sql`
in the solscribe repo, the same table anchor allocation and PRC disclosures use.
Note WFL still shows 7767 here vs 7801 in that table — unverified, left alone.

## How it works

- `server.js` — Express server. Scrapes the AlsoEnergy REST API every 15
  minutes, writes `public/data.json` and `public/history.json`, and serves the
  dashboard. Injects per-site config into the HTML at request time.
- `public/index.html` — Single-page kiosk dashboard (live kW gauge, today /
  yesterday / 30-day energy, sun arc, weather, 7-day history chart, irradiance
  forecast, solar-facts ticker, night-mode countdown).
- `public/facts.json` — Solar facts ticker content, regenerated daily from the
  Anthropic API if `ANTHROPIC_API_KEY` is configured. Falls back to the
  hardcoded pool baked into `index.html` if absent or invalid.

Energy totals are derived from 15-minute and daily bins of AlsoEnergy's `KW`
field (their `Avg` function is time-weighted, so `avgKW × binHours = kWh`).
The native `ProdKWH` / `KWH` fields are empty on these meters.

## Environment variables (per Railway service)

| Variable               | Example                                                | Required |
|------------------------|--------------------------------------------------------|----------|
| `SITE_NAME`            | `Cuidando Los Niños Community Solar`                   | yes      |
| `SITE_SUBTITLE`        | `Community Solar · Belen, New Mexico`                  | yes      |
| `SITE_CITY`            | `Belen, New Mexico`                                    | yes      |
| `ALSO_ENERGY_SITE_ID`  | `72296`                                                | yes      |
| `ALSO_ENERGY_METER_ID` | `570224`                                               | yes      |
| `PV_SIZE_AC`           | `4975` (kW)                                            | yes      |
| `PV_SIZE_DC`           | `6499` (kW)                                            | yes      |
| `SITE_LAT`             | `34.6612`                                              | yes      |
| `SITE_LON`             | `-106.7747`                                            | yes      |
| `SITE_TIMEZONE`        | `America/Denver` (default)                             | no       |
| `ALSO_ENERGY_USERNAME` | AlsoEnergy account email (shared across sites)         | yes      |
| `ALSO_ENERGY_PASSWORD` | AlsoEnergy account password (shared across sites)      | yes      |
| `ANTHROPIC_API_KEY`    | For AI-generated facts; omit to use fallback pool      | no       |
| `PORT`                 | Auto-set by Railway                                    | no       |

Credentials live **only** in Railway env vars — never in the repo.

## Endpoints

- `GET /` and `GET /index.html` — dashboard (site config injected at render).
- `GET /data.json` — latest scrape result (current kW, today/yesterday/30d kWh,
  weather, sunrise/sunset).
- `GET /history.json` — 30 days of daily kWh.
- `GET /facts.json` — ticker facts (AI-generated or fallback).
- `GET /health` — `{ ok, site, scrapedAt }` for uptime checks.

## Local development

```
npm install
ALSO_ENERGY_USERNAME=... ALSO_ENERGY_PASSWORD=... \
SITE_NAME="Test Site" ALSO_ENERGY_SITE_ID=72296 ALSO_ENERGY_METER_ID=570224 \
PV_SIZE_AC=5000 PV_SIZE_DC=5000 SITE_LAT=34.66 SITE_LON=-106.77 \
npm start
```

Visit http://localhost:8080.

## Deploy

Push to `main`; Railway auto-deploys each service from the same GitHub repo.
Each Railway service has its own set of env vars.
