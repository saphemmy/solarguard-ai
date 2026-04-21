# SolarGuard

A browser-based simulation of a rooftop solar monitoring platform for UK PV installations. It pretends to be the full ESP32 → MQTT → AWS IoT Core → Lambda → DynamoDB pipeline, but it's just HTML, CSS and vanilla JS — no backend, no database, no cloud account needed.

Everything lives in `localStorage`, so you can poke at it, break it, and refresh without losing your homes.

## What's in it

The sidebar has eight views. Here's roughly what each one does:

- **Overview** — live KPIs (voltage, power, irradiance, inverter temp), a rolling telemetry chart, the scenario simulator, the diagnostics panel, and fleet tiles.
- **Sites** — an inverter inventory table. Each row has Fan / Dust / Heat / Reset buttons that toggle faults on that specific inverter. Knocking the fan out drops RPM, starves the cooling, and the thermal alert fires on its own.
- **Field Engineer** — a phone-framed mobile view. Only noise-filtered alerts reach it (Z-score over a 10-sample window, threshold 3).
- **Analyst** — longer-range yield trends (24h / 7d / 30d), an efficiency-vs-theoretical chart for spotting soiling, and CSV / JSON export.
- **Telemetry Log** — tail of the simulated MQTT topic.
- **Infrastructure** — the pipeline diagram, a second MQTT tail, and the security posture list (X.509, TLS 1.2, UK GDPR).
- **Simulations** — fault injection (surge / fan / soiling / noise), weather modes, the uplink toggle for exercising the offline cache, and fleet controls.
- **Admin** — projected monthly cloud spend in GBP using rough AWS list prices, plus a requirements trace.

## Running it

The simplest way is Docker. If you don't have Docker, any static server will do.

### Docker

```bash
cd solarguard-ai
docker compose up -d --build
```

Open <http://localhost:8081>. Stop it with `docker compose down`.

Plain Docker works too:

```bash
docker build -t solarguard .
docker run -d --name solarguard -p 8081:80 solarguard
```

The image is ~64 MB (Alpine + `nodejs` package, no npm, no build tools).

### Python

```bash
cd solarguard-ai
python3 -m http.server 8081
```

### Node.js

```bash
cd solarguard-ai
node server.js          # listens on port 80
PORT=8081 node server.js  # or pick a port
```

Then browse to <http://localhost:8081> (or whichever port you used).

## Requirements

- A reasonably recent browser — anything that understands ES2020+ is fine (Chrome, Firefox, Safari, Edge).
- One of: Docker, Python 3, or Node.js.

There is no build step and no runtime dependencies beyond that.

## Files

```
index.html    markup and view structure
styles.css    styling
app.js        simulation engine, state, and rendering
server.js     tiny Node static file server (zero dependencies)
Dockerfile    alpine + nodejs package
docker-compose.yml
```

## Notes

- The **Home** dropdown in the top bar switches between simulated addresses. Each home has its own fleet of inverters, its own alerts, and its own cache.
- The site-level fault buttons are toggles — click once to engage, click again to release. **Reset** on a row clears every fault for that inverter. Everything else is home-wide and lives under **Simulations**.
- State is persisted under the `localStorage` key `solarguard.v3`. If things get weird, **Simulations → Hard reset** wipes it.
