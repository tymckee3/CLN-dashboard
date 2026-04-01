# ASG 8 Solar Live Dashboard

Live kiosk dashboard for the ASG 8 community solar site (S72296) in Belen, NM.

## Deploy to Railway

1. Push this repo to GitHub
2. In Railway: New Project → Deploy from GitHub repo
3. Add environment variables:
   - `POWERTRACK_USER` = your PowerTrack login email
   - `POWERTRACK_PASS` = your PowerTrack password
4. Railway will build and deploy automatically
5. Go to Settings → Networking → Generate Domain to get your public URL

## How it works

- Express server serves the dashboard HTML at `/`
- Playwright scrapes PowerTrack every 5 minutes (no API key needed)
- Data is cached and served at `/data` as JSON
- Dashboard auto-refreshes every 5 minutes
- School device just opens the Railway URL — no login ever needed

## Data displayed

- Current power output (kW AC)
- Capacity factor
- Today's production (kWh)
- Yesterday's production (MWh)
- Last 30 days (GWh)
- CO₂ offset estimate
- System size (AC/DC)
