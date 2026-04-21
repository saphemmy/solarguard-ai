/* SolarGuard AI — front-end simulation of the Amways SolarShield serverless
 * architecture. Everything here is a client-side mock of the AWS IoT Core /
 * Lambda / DynamoDB pipeline described in the scope document: edge telemetry
 * at ~1 Hz, Z-score noise filtering, thermal / soiling / surge heuristics,
 * offline store-and-forward cache, and GDPR-style randomised site IDs.
 *
 * State is scoped per "home" (each a physical address with its own fleet of
 * inverters). Homes are selected via the AWS-region-style dropdown in the
 * header and persisted to localStorage so returning users land on their last
 * selection.
 */

(() => {
  "use strict";

  /* ---------- Constants ---------- */
  const LS_KEY = "solarguard.v3";
  const Z_WINDOW = 10;
  const Z_THRESHOLD = 3;
  const CACHE_FLUSH_BATCH = 8;
  // AWS list prices converted to GBP at ~0.79 GBP/USD for UK case study context.
  // Lambda: $0.20/M invocations → ~£0.158/M
  // DynamoDB on-demand write: $1.25/M → ~£0.99/M
  // IoT Core messaging: $1.00/M → ~£0.79/M
  const LAMBDA_COST_PER_INVOCATION = 0.000000158;
  const DDB_COST_PER_WRITE = 0.00000099;
  const IOT_COST_PER_MSG = 0.00000079;
  const CURRENCY = "£";
  // 10 Hz sim tick keeps the Live Telemetry Stream chart smooth, but MQTT log
  // lines are throttled to one publish per site every PUBLISH_MS so the log
  // reads like a tailed terminal (one batched payload per site every 2s).
  const TICK_MS = 100;
  const TICK_SEC = TICK_MS / 1000;
  const PUBLISH_MS = 2000;
  const MAX_SAMPLES = 60 * 60 * 24; // 24h worth at 1Hz; history is decimated when stored
  const HISTORY_STEP_S = 60; // decimated history resolution

  const WEATHER = {
    clear:  { irrMult: 1.00, jitter: 0.02, label: "Clear sky" },
    cloudy: { irrMult: 0.55, jitter: 0.15, label: "Cloudy" },
    dusty:  { irrMult: 0.85, jitter: 0.06, label: "Dusty haze" },
    storm:  { irrMult: 0.25, jitter: 0.25, label: "Storm" },
  };

  const REGIONS = ["sw-uk-1", "se-uk-1", "nw-uk-1", "ne-uk-1", "scot-uk-1", "wales-uk-1"];
  const VENDORS = ["Huawei", "SolarEdge", "Fronius", "Sungrow", "Growatt", "Enphase"];

  /* ---------- Utilities ---------- */
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const randId = (len = 6) =>
    Math.random().toString(36).slice(2, 2 + len).toUpperCase();
  const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
  const fmt = (n, digits = 1) => (Math.round(n * 10 ** digits) / 10 ** digits).toFixed(digits);
  const now = () => Date.now();
  const isoTime = (ts) => new Date(ts).toLocaleTimeString([], { hour12: false });
  const humanTime = (ts) => {
    const delta = Math.max(0, (now() - ts) / 1000);
    if (delta < 60) return `${Math.floor(delta)}s ago`;
    if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
    return `${Math.floor(delta / 3600)}h ago`;
  };
  const solarCurve = () => {
    // cosine-shaped availability based on local hour, clamped to [0,1]
    const d = new Date();
    const h = d.getHours() + d.getMinutes() / 60;
    const v = Math.cos(((h - 13) / 6) * (Math.PI / 2));
    return clamp(v, 0, 1) ** 1.2;
  };
  const gaussian = () => {
    // Box-Muller
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
  };

  /* ---------- State ---------- */
  const state = {
    homes: [],
    currentHomeId: null,
    globalWeather: "clear",
    simSpeed: 1,
    tickCount: 0,
  };

  const currentHome = () => state.homes.find((h) => h.id === state.currentHomeId) || null;

  /* ---------- Home / Site factories ---------- */
  function makeSite(overrides = {}) {
    const ratedKw = overrides.ratedKw || 3 + Math.random() * 5;
    return {
      id: overrides.id || `INV-${randId(5)}`,
      vendor: overrides.vendor || VENDORS[Math.floor(Math.random() * VENDORS.length)],
      region: overrides.region || REGIONS[Math.floor(Math.random() * REGIONS.length)],
      ratedKw,
      // live telemetry
      voltage: 230,
      current: 0,
      power: 0,
      intTemp: 30,
      ambient: 22,
      fanRpm: 2400,
      irradiance: 0,
      // internal state
      soilingPct: 0, // 0..1, fraction of yield lost to soiling
      fanHealth: 1,  // 1=good, 0=dead; derates over time once "failing"
      faults: new Set(), // "surge"|"fan"|"soil"|"noise"|"thermal"
      noiseBoostUntil: 0,
      lastPublishAt: 0, // gate for the MQTT tail throttle
      // windows for Z-score
      zWindow: [],
      zSuppressed: 0,
      // sparkline buffers (last 60s at 1Hz)
      vBuf: [],
      pBuf: [],
      tBuf: [],
      // condensed history (every HISTORY_STEP_S seconds)
      history: [],
      lastHistTs: 0,
    };
  }

  function makeHome(name, region, siteCount = 3) {
    const home = {
      id: `HM-${randId(6)}`,
      name,
      region: region || REGIONS[Math.floor(Math.random() * REGIONS.length)],
      createdAt: now(),
      weather: "clear",
      activeScenario: "optimal",
      sites: [],
      alerts: [],
      ackedAlertIds: new Set(),
      mqttLog: [],
      cache: [],
      networkUp: true,
      lastBurstTs: null,
      syncState: "idle",
      counters: { iotMsgs: 0, lambdas: 0, ddbWrites: 0, bytes: 0 },
      budgetLimit: 5,
      budgetAlertSent: false,
      lastAlertSig: new Map(), // suppress duplicate burst alerts per site+type
      aggBuf: [], // aggregate kW last 60s
    };
    for (let i = 0; i < siteCount; i++) home.sites.push(makeSite({ region: home.region }));
    return home;
  }

  function seedIfEmpty() {
    if (state.homes.length) return;
    state.homes.push(makeHome("Roehampton Flat", "sw-uk-1", 3));
    state.homes.push(makeHome("Manchester Office", "nw-uk-1", 4));
    state.homes.push(makeHome("Edinburgh Workshop", "scot-uk-1", 2));
    state.currentHomeId = state.homes[0].id;
  }

  /* ---------- Persistence (small subset) ---------- */
  function saveSettings() {
    try {
      const payload = {
        homes: state.homes.map((h) => ({
          id: h.id, name: h.name, region: h.region,
          networkUp: h.networkUp,
          budgetLimit: h.budgetLimit,
          activeScenario: h.activeScenario || "optimal",
          weather: h.weather || "clear",
          sites: h.sites.map((s) => ({ id: s.id, vendor: s.vendor, region: s.region, ratedKw: s.ratedKw })),
        })),
        currentHomeId: state.currentHomeId,
        weather: state.globalWeather,
        simSpeed: state.simSpeed,
      };
      localStorage.setItem(LS_KEY, JSON.stringify(payload));
    } catch (e) { /* quota or serialisation edge case */ }
  }

  function loadSettings() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return;
      const payload = JSON.parse(raw);
      if (!payload.homes || !payload.homes.length) return;
      state.homes = payload.homes.map((h) => {
        const home = makeHome(h.name, h.region, 0);
        home.id = h.id;
        home.budgetLimit = h.budgetLimit || 5;
        home.activeScenario = h.activeScenario || "optimal";
        home.weather = h.weather || "clear";
        // Derive networkUp from the active scenario so the UI can't get stuck
        // offline via stale localStorage. Only the "Connectivity Loss" preset
        // keeps the uplink down on reload.
        home.networkUp = home.activeScenario !== "offline";
        home.sites = (h.sites || []).map((s) => makeSite(s));
        return home;
      });
      state.currentHomeId = payload.currentHomeId && state.homes.some((h) => h.id === payload.currentHomeId)
        ? payload.currentHomeId
        : state.homes[0].id;
      state.globalWeather = payload.weather || "clear";
      state.simSpeed = payload.simSpeed || 1;
    } catch (e) { /* ignore corrupt payload */ }
  }

  /* ---------- Z-score filter ---------- */
  function pushZ(site, value) {
    site.zWindow.push(value);
    if (site.zWindow.length > Z_WINDOW) site.zWindow.shift();
    if (site.zWindow.length < Z_WINDOW) return { z: 0, noise: false, mu: value, sigma: 0 };
    const mu = site.zWindow.reduce((a, b) => a + b, 0) / site.zWindow.length;
    const variance = site.zWindow.reduce((a, b) => a + (b - mu) ** 2, 0) / site.zWindow.length;
    const sigma = Math.sqrt(variance);
    const z = sigma === 0 ? 0 : (value - mu) / sigma;
    return { z, noise: Math.abs(z) > Z_THRESHOLD, mu, sigma };
  }

  /* ---------- Alert generation ---------- */
  function raiseAlert(home, site, type, title, sub, severity = "warn") {
    const sig = `${site.id}:${type}`;
    const last = home.lastAlertSig.get(sig) || 0;
    if (now() - last < 15000) return; // debounce repeat alerts per type
    home.lastAlertSig.set(sig, now());

    const alert = {
      id: `AL-${randId(6)}`,
      siteId: site.id,
      type,
      title,
      sub,
      severity,
      ts: now(),
      acked: false,
    };
    home.alerts.unshift(alert);
    if (home.alerts.length > 200) home.alerts.length = 200;
    render(); // re-render to surface the new alert
  }

  function runFaultChecks(home, site, sample) {
    const { z: zV, noise } = pushZ(site, sample.voltage);
    if (noise) {
      site.zSuppressed++;
      return; // discard obvious outliers
    }

    // Voltage surge: |Δ| from rolling mean over last 3 samples
    if (site.vBuf.length > 3) {
      const recent = site.vBuf.slice(-3);
      const muV = recent.reduce((a, b) => a + b, 0) / recent.length;
      if (Math.abs(sample.voltage - muV) > 55 && Math.abs(sample.voltage - muV) < 140) {
        raiseAlert(home, site, "surge",
          `Voltage surge at ${site.id}`,
          `ΔV = ${fmt(sample.voltage - muV, 1)} V · Z=${fmt(zV, 2)}`,
          "crit");
      }
    }

    // Thermal delta / fan failure
    const delta = sample.intTemp - sample.ambient;
    if (delta > 38 && sample.power > 0.2 * site.ratedKw) {
      raiseAlert(home, site, "thermal",
        `Thermal Δ spike at ${site.id}`,
        `Internal ${fmt(sample.intTemp)}°C vs ambient ${fmt(sample.ambient)}°C`,
        "crit");
    }
    if (sample.fanRpm < 900 && sample.power > 0.2 * site.ratedKw) {
      raiseAlert(home, site, "fan",
        `Cooling fan degradation at ${site.id}`,
        `RPM=${Math.round(sample.fanRpm)} · fan-shield engaged`,
        "warn");
    }

    // Soiling: real yield ≪ theoretical yield under non-cloudy weather
    const weather = WEATHER[home.weather] || WEATHER.clear;
    const theoretical = (sample.irradiance / 1000) * site.ratedKw * 0.92;
    if (theoretical > 0.3 && sample.power / theoretical < 0.72 && weather.irrMult > 0.6) {
      raiseAlert(home, site, "soil",
        `Possible soiling at ${site.id}`,
        `Yield at ${fmt((sample.power / theoretical) * 100)}% of theoretical`,
        "warn");
    }
  }

  /* ---------- Cache / network ---------- */
  function pushToCloud(home, site, sample) {
    // Throttle to one publish per site per PUBLISH_MS so the MQTT tail reads
    // like a tailed log rather than a firehose. Intermediate samples are
    // already captured in the sparkline buffers and in-memory history.
    const t = now();
    if (t - site.lastPublishAt < PUBLISH_MS) return;
    site.lastPublishAt = t;

    if (home.networkUp) {
      home.counters.iotMsgs++;
      home.counters.lambdas++;
      home.counters.ddbWrites++;
      home.counters.bytes += 160;
      mqttLog(home, site, sample);
    } else {
      home.cache.push({ siteId: site.id, sample });
      home.syncState = "caching";
    }
  }

  function flushCache(home) {
    if (!home.networkUp) return;
    if (!home.cache.length) {
      if (home.syncState !== "idle") home.syncState = "idle";
      return;
    }
    const burst = home.cache.splice(0, CACHE_FLUSH_BATCH);
    burst.forEach(({ siteId, sample }) => {
      const site = home.sites.find((s) => s.id === siteId);
      if (!site) return;
      home.counters.iotMsgs++;
      home.counters.lambdas++;
      home.counters.ddbWrites++;
      home.counters.bytes += 160;
      mqttLog(home, site, sample, true);
    });
    home.syncState = home.cache.length ? "flushing" : "idle";
    home.lastBurstTs = now();
  }

  let _mqttSeq = 0;
  function mqttLog(home, site, sample, fromCache = false) {
    // Reference-style compact payload: { "v": <VAC>, "p": <kW>, "t": <inv °C> }
    const body = `{ "v": ${sample.voltage.toFixed(2)}, "p": ${sample.power.toFixed(2)}, "t": ${sample.intTemp.toFixed(1)} }`;
    home.mqttLog.unshift({
      id: ++_mqttSeq,
      ts: now(),
      site: site.id,
      topic: `solar/${home.region}/${site.id}/telemetry`,
      prefix: "MQTT Publish:",
      body,
      fromCache,
    });
    if (home.mqttLog.length > 200) home.mqttLog.length = 200;
  }

  /* ---------- Telemetry tick ---------- */
  // Scenario-driven physics biases. Each preset skews the live readings so that
  // the KPIs (Voltage, Power, Irradiance, Inverter Temp) visibly respond the
  // moment a scenario is picked.
  const SCENARIO_PHYSICS = {
    optimal:   { irrMult: 1.00, powerMult: 1.00, tempBias: 0,  voltageJitter: 1, voltageBias: 0,  fanMul: 1.00, surgeProb: 0 },
    cloudy:    { irrMult: 0.35, powerMult: 0.35, tempBias: -3, voltageJitter: 1, voltageBias: -2, fanMul: 1.00, surgeProb: 0 },
    soil:      { irrMult: 1.00, powerMult: 0.55, tempBias: 2,  voltageJitter: 1, voltageBias: 0,  fanMul: 1.00, surgeProb: 0 },
    thermal:   { irrMult: 0.95, powerMult: 0.82, tempBias: 26, voltageJitter: 2, voltageBias: 0,  fanMul: 0.55, surgeProb: 0 },
    equipment: { irrMult: 0.95, powerMult: 0.35, tempBias: 6,  voltageJitter: 6, voltageBias: -8, fanMul: 0.90, surgeProb: 0.12 },
    offline:   { irrMult: 1.00, powerMult: 1.00, tempBias: 0,  voltageJitter: 1, voltageBias: 0,  fanMul: 1.00, surgeProb: 0 },
  };

  function tickHome(home) {
    const curve = solarCurve();
    const weather = WEATHER[home.weather] || WEATHER.clear;
    const scenario = home.activeScenario || "optimal";
    const phys = SCENARIO_PHYSICS[scenario] || SCENARIO_PHYSICS.optimal;

    home.sites.forEach((site) => {
      // Base irradiance — time-of-day × weather × scenario mask. The minimum
      // ensures dashboards show a readable value even at night for the demo.
      const jitter = 1 + gaussian() * weather.jitter * 0.12;
      const rawCurve = Math.max(curve, 0.55); // floor so night-time demos still show activity
      const baseIrr = 1000 * rawCurve * weather.irrMult * phys.irrMult * jitter;
      let irradiance = clamp(baseIrr, 0, 1200);

      // Soiling reduces effective irradiance reaching the cells
      if (site.faults.has("soil")) {
        site.soilingPct = Math.min(0.35, site.soilingPct + 0.002);
      } else {
        site.soilingPct = Math.max(0, site.soilingPct - 0.0005);
      }
      const panelIrr = irradiance * (1 - site.soilingPct);

      // Ambient temp correlated with irradiance
      const ambient = 18 + 10 * rawCurve + gaussian() * 0.6 + (weather.irrMult < 0.5 ? -3 : 0);

      // Fan behaviour
      let fanRpm;
      if (site.faults.has("fan")) {
        site.fanHealth = Math.max(0.05, site.fanHealth - 0.01);
        fanRpm = 2400 * site.fanHealth + gaussian() * 30;
      } else {
        site.fanHealth = Math.min(1, site.fanHealth + 0.005);
        fanRpm = 2300 + gaussian() * 50;
      }
      fanRpm = Math.max(0, fanRpm * phys.fanMul);

      // Internal temp rises with power and drops with fan RPM
      const load = panelIrr / 1000;
      const coolingFactor = clamp(fanRpm / 2400, 0.1, 1);
      const thermalBias = site.faults.has("thermal") ? 26 : 0;
      const intTemp = ambient + 8 + 20 * load / coolingFactor + phys.tempBias + thermalBias + gaussian() * 0.4;

      // Power draw — rated × load × small losses, further scaled by scenario
      let power = site.ratedKw * load * 0.94 * phys.powerMult;
      if (site.faults.has("soil")) power *= (1 - site.soilingPct);
      power = Math.max(0, power + gaussian() * 0.03);

      // Voltage / current — scenario controls baseline jitter and stochastic surges
      const noiseBoost = site.faults.has("noise") || now() < site.noiseBoostUntil;
      let voltage = 230 + phys.voltageBias + gaussian() * (noiseBoost ? 6 : 1.5) * phys.voltageJitter;
      if (site.faults.has("surge")) {
        voltage += 70 + Math.random() * 20;
        site.faults.delete("surge"); // single-shot spike
      }
      if (phys.surgeProb && Math.random() < phys.surgeProb) {
        voltage += (Math.random() > 0.5 ? 1 : -1) * (30 + Math.random() * 40);
      }
      const current = power * 1000 / Math.max(voltage, 1);

      const sample = {
        voltage, current, power, intTemp, ambient, fanRpm, irradiance: panelIrr,
      };

      // Commit live readings
      site.voltage = voltage;
      site.current = current;
      site.power = power;
      site.intTemp = intTemp;
      site.ambient = ambient;
      site.fanRpm = fanRpm;
      site.irradiance = panelIrr;

      // Rolling buffers
      site.vBuf.push(voltage); if (site.vBuf.length > 60) site.vBuf.shift();
      site.pBuf.push(power); if (site.pBuf.length > 60) site.pBuf.shift();
      site.tBuf.push(intTemp - ambient); if (site.tBuf.length > 60) site.tBuf.shift();

      // Decimated history every HISTORY_STEP_S seconds
      const tNow = now();
      if (!site.lastHistTs || tNow - site.lastHistTs >= HISTORY_STEP_S * 1000) {
        site.history.push({
          ts: tNow,
          power, voltage, intTemp,
          delta: intTemp - ambient,
          irradiance: panelIrr,
        });
        if (site.history.length > MAX_SAMPLES / HISTORY_STEP_S) site.history.shift();
        site.lastHistTs = tNow;
      }

      // Heuristics (alerts)
      runFaultChecks(home, site, sample);

      // Transport
      pushToCloud(home, site, sample);
    });

    // Aggregate buffer
    const agg = home.sites.reduce((a, s) => a + s.power, 0);
    home.aggBuf.push(agg); if (home.aggBuf.length > 60) home.aggBuf.shift();

    // Cache flush
    flushCache(home);

    // Budget alert (US04) — require a stabilisation window (~10 s) so the first
    // few noisy ticks don't produce a spurious projection.
    if (state.tickCount > 100) {
      const spend = projectedSpend(home);
      if (spend >= home.budgetLimit && !home.budgetAlertSent) {
        home.budgetAlertSent = true;
        raiseAlert(home, home.sites[0] || { id: "BILLING" }, "network",
          `Budget threshold breached`,
          `Projected monthly spend ${CURRENCY}${fmt(spend, 2)} exceeds ${CURRENCY}${fmt(home.budgetLimit, 2)}`,
          "crit");
        showToast(`Budget alert dispatched: ${CURRENCY}${fmt(spend, 2)} > limit`);
      }
      if (spend < home.budgetLimit * 0.9) home.budgetAlertSent = false;
    }

    // Connectivity churn log once when flipping
    if (home.networkUp && home.syncState === "idle" && home.cache.length === 0) {
      // steady state
    }
  }

  function projectedSpend(home) {
    const c = home.counters;
    // Each mainTick advances TICK_SEC of sim time at 1× speed. At higher
    // simSpeed we do extra inner ticks per main tick.
    const simSeconds = Math.max(1,
      state.tickCount * TICK_SEC * Number(state.simSpeed || 1));
    const SECONDS_PER_MONTH = 30 * 24 * 3600;
    const totalCostSoFar = c.iotMsgs * IOT_COST_PER_MSG +
                           c.lambdas * LAMBDA_COST_PER_INVOCATION +
                           c.ddbWrites * DDB_COST_PER_WRITE;
    return (totalCostSoFar / simSeconds) * SECONDS_PER_MONTH;
  }

  /* ---------- Main tick loop ---------- */
  function mainTick() {
    state.tickCount++;
    const speed = Number(state.simSpeed) || 1;
    for (let i = 0; i < speed; i++) {
      state.homes.forEach(tickHome);
    }
    render();
    // Keep the message queue log updating even when the user is on another
    // view — newly-streamed rows are ready the moment they click Telemetry.
    const home = currentHome();
    if (home) {
      streamMqtt(el.telemetryLog, home.mqttLog, 180, el.telLive, home.networkUp);
      streamMqtt(el.mqttLog, home.mqttLog, 60, el.mqttLive, home.networkUp);
    }
  }

  /* ---------- View switching ---------- */
  const KNOWN_VIEWS = new Set(["overview", "sites", "mobile", "analyst", "telemetry", "infra", "sim", "admin"]);
  const VIEW_TITLES = {
    overview: "Dashboard",
    sites: "Site Inventory",
    mobile: "Field Engineer Mobile",
    analyst: "Analyst Workspace",
    telemetry: "Telemetry Log",
    infra: "Infrastructure",
    sim: "Simulations",
    admin: "Administrator",
  };

  const SCENARIOS = [
    { id: "optimal",   icon: "sun",    accent: "",             title: "Optimal Conditions",  sub: "Clear sky, peak efficiency", state: { cls: "ok",   label: "Normal" } },
    { id: "cloudy",    icon: "cloud",  accent: "accent-blue",  title: "Heavy Cloud Cover",   sub: "Low solar irradiance",       state: { cls: "warn", label: "Cloudy" } },
    { id: "soil",      icon: "wind",   accent: "accent-amber", title: "Dust / Dirt Buildup", sub: "Simulate soiling loss",      state: { cls: "warn", label: "Soiling" } },
    { id: "thermal",   icon: "flame",  accent: "accent-red",   title: "Thermal Stress",      sub: "Temp > 75°C alert",          state: { cls: "crit", label: "Thermal Alert" } },
    { id: "equipment", icon: "bolt",   accent: "accent-purple",title: "Equipment Fault",     sub: "Simulate inverter failure",  state: { cls: "crit", label: "Fault" } },
    { id: "offline",   icon: "wifi",   accent: "accent-slate", title: "Connectivity Loss",   sub: "Simulate MQTT outage",       state: { cls: "off",  label: "Offline" } },
  ];
  const SCENARIOS_BY_ID = Object.fromEntries(SCENARIOS.map((s) => [s.id, s]));

  const SCENARIO_ICONS = {
    sun:  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>',
    cloud:'<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/></svg>',
    wind: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
    flame:'<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
    bolt: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>',
    wifi: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="1" y1="1" x2="23" y2="23"/><path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55"/><path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39"/><path d="M10.71 5.05A16 16 0 0 1 22.58 9"/><path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88"/><line x1="12" y1="20" x2="12.01" y2="20"/></svg>',
  };
  let currentView = "overview";
  function switchView(name) {
    if (!KNOWN_VIEWS.has(name)) name = "overview";
    currentView = name;
    if (location.hash.replace("#", "") !== name) {
      history.replaceState(null, "", `#${name}`);
    }
    $$(".nav-btn").forEach((b) => b.classList.toggle("is-active", b.dataset.view === name));
    $$(".view").forEach((v) => v.classList.toggle("is-active", v.dataset.view === name));
    render();
  }
  window.addEventListener("hashchange", () => switchView(location.hash.replace("#", "") || "overview"));

  /* ---------- Rendering ---------- */
  const el = {
    // header
    viewTitle: $("#viewTitle"),
    systemStatus: $("#systemStatus"),
    homeBtnLabel: $("#homeBtnLabel"),
    homeBtn: $("#homeBtn"),
    homeMenu: $("#homeMenu"),
    homeMenuList: $("#homeMenuList"),
    topDevice: $("#topDevice"),
    topUptime: $("#topUptime"),
    alertBadge: $("#alertBadge"),
    // sidebar service dots
    svcIot: $("#svcIot"),
    svcLambda: $("#svcLambda"),
    svcDdb: $("#svcDdb"),
    // KPI
    kpiV: $("#kpiV"),
    kpiVPill: $("#kpiVPill"),
    kpiP: $("#kpiP"),
    kpiPPill: $("#kpiPPill"),
    kpiIrr: $("#kpiIrr"),
    kpiT: $("#kpiT"),
    aggChart: $("#aggChart"),
    // scenario simulator
    scenarioList: $("#scenarioList"),
    // diag
    diagCard: $("#diagCard"),
    diagIcon: $("#diagIcon"),
    diagMsg: $("#diagMsg"),
    diagRecoText: $("#diagRecoText"),
    // alerts + sites
    alertFeed: $("#alertFeed"),
    alertFeedCount: $("#alertFeedCount"),
    siteTiles: $("#siteTiles"),
    // telemetry log
    telemetryLog: $("#telemetryLog"),
    telLive: $("#telLive"),
    mqttLive: $("#mqttLive"),
    // sites table
    sitesTable: $("#sitesTable tbody"),
    siteDetailCard: $("#siteDetailCard"),
    siteDetailTitle: $("#siteDetailTitle"),
    dDevice: $("#dDevice"),
    dCache: $("#dCache"),
    dZV: $("#dZV"),
    dSoil: $("#dSoil"),
    chartV: $("#chartV"),
    chartP: $("#chartP"),
    chartT: $("#chartT"),
    // mobile
    mConn: $("#mConn"),
    mGaugeArc: $("#mGaugeArc"),
    mGaugeVal: $("#mGaugeVal"),
    mToday: $("#mToday"),
    mOpen: $("#mOpen"),
    mSites: $("#mSites"),
    mAlerts: $("#mAlerts"),
    mMu: $("#mMu"),
    mSigma: $("#mSigma"),
    mSupp: $("#mSupp"),
    // analyst
    aSite: $("#aSite"),
    aMetric: $("#aMetric"),
    analystChart: $("#analystChart"),
    effChart: $("#effChart"),
    aMean: $("#aMean"),
    aStd: $("#aStd"),
    aMin: $("#aMin"),
    aMax: $("#aMax"),
    aN: $("#aN"),
    // infra
    pEdge: $("#pEdge"),
    pIot: $("#pIot"),
    pLambda: $("#pLambda"),
    pDdb: $("#pDdb"),
    arrow1: $("#arrow1"),
    arrow2: $("#arrow2"),
    arrow3: $("#arrow3"),
    mqttLog: $("#mqttLog"),
    // sim
    surgeSite: $("#surgeSite"),
    fanSite: $("#fanSite"),
    soilSite: $("#soilSite"),
    noiseSite: $("#noiseSite"),
    weatherMode: $("#weatherMode"),
    netToggle: $("#netToggle"),
    netLabel: $("#netLabel"),
    cacheCount: $("#cacheCount"),
    lastBurst: $("#lastBurst"),
    syncState: $("#syncState"),
    simSpeed: $("#simSpeed"),
    // admin
    budgetFill: $("#budgetFill"),
    budgetSpend: $("#budgetSpend"),
    budgetLimit: $("#budgetLimit"),
    budgetLimitInput: $("#budgetLimitInput"),
    bLambda: $("#bLambda"),
    bDdb: $("#bDdb"),
    bIot: $("#bIot"),
    bMb: $("#bMb"),
    budgetBanner: $("#budgetBanner"),
  };

  let aRange = "24h";

  function render() {
    const home = currentHome();
    if (!home) return renderNoHome();
    renderHeader(home);
    renderSidebarStatus(home);
    if (currentView === "overview") renderOverview(home);
    else if (currentView === "sites") renderSites(home);
    else if (currentView === "mobile") renderMobile(home);
    else if (currentView === "analyst") renderAnalyst(home);
    else if (currentView === "telemetry") renderTelemetry(home);
    else if (currentView === "infra") renderInfra(home);
    else if (currentView === "sim") renderSim(home);
    else if (currentView === "admin") renderAdmin(home);
  }

  function renderNoHome() {
    if (el.homeBtnLabel) el.homeBtnLabel.textContent = "No home";
    if (el.systemStatus) { el.systemStatus.textContent = "No home"; el.systemStatus.className = "state-pill off"; }
  }

  function renderHeader(home) {
    el.viewTitle.textContent = VIEW_TITLES[currentView] || "Dashboard";
    el.homeBtnLabel.textContent = `${home.name} · ${home.region}`;

    // Primary site ID shown as "Device" (ESP32-style)
    const primary = home.sites[0];
    el.topDevice.textContent = primary ? `ESP32-${primary.id.replace(/^INV-/, "")}` : "—";
    el.topUptime.textContent = formatUptime(now() - home.createdAt);

    // State pill is driven directly by the active Scenario Simulator preset
    // so the header stays in lockstep with what the operator picked.
    const scenario = SCENARIOS_BY_ID[home.activeScenario] || SCENARIOS_BY_ID.optimal;
    const st = scenario.state;
    el.systemStatus.className = `state-pill ${st.cls}`;
    el.systemStatus.textContent = st.label;

    const open = home.alerts.filter((a) => !a.acked);
    el.alertBadge.textContent = open.length;
    el.alertBadge.style.display = open.length ? "grid" : "none";
  }

  function renderSidebarStatus(home) {
    const online = home.networkUp;
    [el.svcIot, el.svcLambda, el.svcDdb].forEach((row) => {
      if (!row) return;
      row.classList.toggle("offline", !online);
    });
  }

  function formatUptime(ms) {
    const s = Math.floor(ms / 1000);
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    return `${d}d ${String(h).padStart(2, "0")}h ${String(m).padStart(2, "0")}m`;
  }

  function renderOverview(home) {
    const primary = home.sites[0];
    const totalPower = home.sites.reduce((a, s) => a + s.power, 0);
    const avgV = primary ? primary.voltage : 0;
    const avgIrr = home.sites.length ? home.sites.reduce((a, s) => a + s.irradiance, 0) / home.sites.length : 0;
    const maxTemp = home.sites.reduce((a, s) => Math.max(a, s.intTemp), 0);

    el.kpiV.textContent = fmt(avgV, 1);
    const vDelta = primary ? primary.voltage - 230 : 0;
    el.kpiVPill.textContent = `${vDelta >= 0 ? "+" : ""}${fmt(vDelta, 1)}`;
    el.kpiVPill.className = "kpi-pill " + (Math.abs(vDelta) > 15 ? "red" : Math.abs(vDelta) > 8 ? "amber" : "green");

    el.kpiP.textContent = fmt(totalPower, 2);
    // Use the same irradiance floor the sim uses so efficiency is meaningful
    // even at night during a live demo.
    const capacityKw = home.sites.reduce((a, s) => a + s.ratedKw, 0);
    const theoreticalKw = capacityKw * Math.max(solarCurve(), 0.55);
    const effPct = theoreticalKw > 0.3 ? totalPower / theoreticalKw : 0;
    el.kpiPPill.textContent = effPct >= 0.85 ? "Optimal" : effPct >= 0.55 ? "Fair" : effPct >= 0.3 ? "Degraded" : "Poor";
    el.kpiPPill.className = "kpi-pill " + (effPct >= 0.85 ? "green" : effPct >= 0.55 ? "amber" : "red");

    el.kpiIrr.textContent = Math.round(avgIrr);
    el.kpiT.textContent = fmt(maxTemp, 1);

    // Live Telemetry Stream — voltage trace of the primary inverter (matches
    // the reference UI which shows VAC around 230 V with "V" unit suffix).
    const voltageBuf = primary ? primary.vBuf : [];
    drawSpark(el.aggChart, voltageBuf, {
      withAxes: true,
      unit: "V",
      autoPad: 2,      // pad y-range ±2 V around min/max for a stable trace
      digits: 2,
      areaFill: true,
    });

    renderScenarioList(home);
    renderDiagEngine(home);
    renderAlertFeed(home);
    renderSiteTiles(home);
  }

  function renderScenarioList(home) {
    if (!el.scenarioList) return;
    const active = home.activeScenario || "optimal";
    // Re-rendering every tick destroys buttons mid-click (mousedown/mouseup
    // can straddle a rebuild). Only rebuild when active changes; toggle the
    // .active class in place otherwise.
    if (el.scenarioList.dataset.built === "1") {
      if (el.scenarioList.dataset.active !== active) {
        $$(".scenario-btn", el.scenarioList).forEach((b) =>
          b.classList.toggle("active", b.dataset.scenario === active));
        el.scenarioList.dataset.active = active;
      }
      return;
    }
    el.scenarioList.innerHTML = SCENARIOS.map((s) => `
      <button class="scenario-btn ${s.accent} ${active === s.id ? "active" : ""}" data-scenario="${s.id}">
        <span class="s-icon">${SCENARIO_ICONS[s.icon]}</span>
        <span class="s-body">
          <span class="s-title">${escape(s.title)}</span>
          <span class="s-sub">${escape(s.sub)}</span>
        </span>
      </button>
    `).join("");
    el.scenarioList.dataset.built = "1";
    el.scenarioList.dataset.active = active;
  }

  function renderDiagEngine(home) {
    const open = home.alerts.filter((a) => !a.acked);
    const crit = open.find((a) => a.severity === "crit");
    const warn = open.find((a) => a.severity === "warn");
    el.diagCard.classList.remove("warn", "crit");
    if (crit) {
      el.diagCard.classList.add("crit");
      el.diagMsg.textContent = `${crit.title} — ${crit.sub}`;
      el.diagRecoText.textContent = recommendationFor(crit.type);
    } else if (warn) {
      el.diagCard.classList.add("warn");
      el.diagMsg.textContent = `${warn.title} — ${warn.sub}`;
      el.diagRecoText.textContent = recommendationFor(warn.type);
    } else {
      el.diagMsg.textContent = "System operating within optimal parameters.";
      el.diagRecoText.textContent = "Recommendation: No action required.";
    }
  }

  function recommendationFor(type) {
    return {
      surge: "Recommendation: inspect breaker and upstream wiring; check for loose neutrals.",
      thermal: "Recommendation: verify inverter ventilation and cooling fan function.",
      fan: "Recommendation: schedule fan replacement; derate output until serviced.",
      soil: "Recommendation: arrange panel cleaning; re-measure yield after cleaning.",
      network: "Recommendation: verify Wi-Fi uplink and SIM backhaul; cached rows will sync on reconnect.",
    }[type] || "Recommendation: review alert detail in the field app.";
  }

  function renderAlertFeed(home) {
    const open = home.alerts.filter((a) => !a.acked).slice(0, 12);
    el.alertFeedCount.textContent = home.alerts.filter((a) => !a.acked).length;
    if (!open.length) {
      el.alertFeed.innerHTML = `<li class="alert-empty">No open alerts. System nominal.</li>`;
      return;
    }
    el.alertFeed.innerHTML = open.map((a) => `
      <li class="alert-item" data-id="${a.id}">
        <span class="alert-dot ${a.type}"></span>
        <div class="alert-text">
          <div class="a-title">${escape(a.title)}</div>
          <div class="a-sub">${escape(a.sub)} · ${humanTime(a.ts)}</div>
        </div>
        <button class="alert-ack" data-ack="${a.id}">ACK</button>
      </li>
    `).join("");
  }

  function renderSiteTiles(home) {
    el.siteTiles.innerHTML = home.sites.map((s) => {
      const delta = s.intTemp - s.ambient;
      const cls = siteState(s);
      return `
        <div class="site-tile" data-site="${s.id}">
          <div class="site-tile-head">
            <span class="site-id">${s.id}</span>
            <span class="state-pill ${cls}">${cls}</span>
          </div>
          <div class="site-tile-body">
            <div>Power<b>${fmt(s.power, 2)} kW</b></div>
            <div>Voltage<b>${fmt(s.voltage, 1)} V</b></div>
            <div>Δ Temp<b>${fmt(delta, 1)} °C</b></div>
            <div>Fan<b>${Math.round(s.fanRpm)} rpm</b></div>
          </div>
        </div>
      `;
    }).join("");
  }

  function siteState(s) {
    const delta = s.intTemp - s.ambient;
    if (!s.power && solarCurve() > 0.1) return "off";
    if (delta > 40 || s.fanRpm < 600) return "crit";
    if (delta > 33 || s.fanRpm < 1200 || s.soilingPct > 0.15) return "warn";
    return "ok";
  }

  function renderSites(home) {
    el.sitesTable.innerHTML = home.sites.map((s) => {
      const delta = s.intTemp - s.ambient;
      const cls = siteState(s);
      const rowCls = cls === "crit" ? "row-crit" : cls === "warn" ? "row-warn" : "";
      const fanOn = s.faults.has("fan") ? "is-on" : "";
      const soilOn = s.faults.has("soil") ? "is-on" : "";
      const thermalOn = s.faults.has("thermal") ? "is-on" : "";
      return `
        <tr class="${rowCls}" data-site="${s.id}">
          <td>${s.id}</td>
          <td>${s.region}</td>
          <td>${s.vendor}</td>
          <td>${fmt(s.power, 2)} kW</td>
          <td>${fmt(s.intTemp, 1)} °C</td>
          <td>${fmt(s.ambient, 1)} °C</td>
          <td>${fmt(delta, 1)} °C</td>
          <td>${Math.round(s.fanRpm)}</td>
          <td>${Math.round(s.irradiance)} W/m²</td>
          <td><span class="state-pill ${cls}">${cls}</span></td>
          <td class="row-actions">
            <button class="btn-row ${fanOn}" data-row-fault="fan" data-site-id="${s.id}" title="Fan blow-out — drops RPM, drives inverter temp up">Fan</button>
            <button class="btn-row ${soilOn}" data-row-fault="soil" data-site-id="${s.id}" title="Dust accumulation — depresses yield and lifts temp">Dust</button>
            <button class="btn-row ${thermalOn}" data-row-fault="thermal" data-site-id="${s.id}" title="Thermal stress — inject direct internal-temp rise">Heat</button>
            <button class="btn-row reset" data-row-fault="reset" data-site-id="${s.id}" title="Clear faults on this site">Reset</button>
          </td>
        </tr>
      `;
    }).join("");

    if (selectedSiteId) {
      const site = home.sites.find((s) => s.id === selectedSiteId);
      if (site) renderSiteDetail(home, site);
      else hideSiteDetail();
    }
  }

  function renderSiteDetail(home, site) {
    el.siteDetailCard.hidden = false;
    el.siteDetailTitle.textContent = `${site.id} · ${site.vendor} (${site.ratedKw.toFixed(1)} kW rated)`;
    el.dDevice.textContent = site.id;
    el.dCache.textContent = `${home.cache.filter((c) => c.siteId === site.id).length} rows`;
    const last = site.zWindow.length ? site.zWindow[site.zWindow.length - 1] : 0;
    const { z, mu, sigma } = pushZ({ zWindow: site.zWindow.slice() }, last);
    el.dZV.textContent = `Z=${fmt(z, 2)} μ=${fmt(mu, 1)} σ=${fmt(sigma, 2)}`;
    el.dSoil.textContent = `${fmt(site.soilingPct * 100, 1)} %`;
    drawSpark(el.chartV, site.vBuf, { stroke: "#1e3a8a" });
    drawSpark(el.chartP, site.pBuf, { stroke: "#f59e0b" });
    drawSpark(el.chartT, site.tBuf, { stroke: "#ef4444" });
  }

  function hideSiteDetail() { el.siteDetailCard.hidden = true; selectedSiteId = null; }

  let selectedSiteId = null;

  function renderMobile(home) {
    const totalPower = home.sites.reduce((a, s) => a + s.power, 0);
    const capacity = home.sites.reduce((a, s) => a + s.ratedKw, 0) || 1;
    const pct = clamp(totalPower / capacity, 0, 1);
    const arcLen = 280;
    el.mGaugeArc.setAttribute("stroke-dasharray", `${pct * arcLen} ${arcLen}`);
    el.mGaugeVal.textContent = fmt(totalPower, 2);

    el.mConn.textContent = home.networkUp ? "● Online" : "● Offline (cached)";
    el.mConn.classList.toggle("offline", !home.networkUp);

    el.mToday.textContent = `${fmt(totalPower * (state.tickCount / 3600), 1)} kWh`;
    const open = home.alerts.filter((a) => !a.acked);
    el.mOpen.textContent = open.length;
    el.mSites.textContent = home.sites.length;

    el.mAlerts.innerHTML = open.slice(0, 10).map((a) => `
      <li>
        <span class="dot" style="background:${dotColor(a.type)}"></span>
        <div>
          <div class="m-a-title">${escape(a.title)}</div>
          <div class="m-a-sub">${escape(a.sub)} · ${humanTime(a.ts)}</div>
        </div>
        <button data-ack="${a.id}">ACK</button>
      </li>
    `).join("") || `<li class="m-empty">All clear — no pending alerts on this home.</li>`;

    // noise metrics
    const anySite = home.sites[0];
    if (anySite) {
      const last = anySite.zWindow.length ? anySite.zWindow[anySite.zWindow.length - 1] : 0;
      const { mu, sigma } = pushZ({ zWindow: anySite.zWindow.slice() }, last);
      el.mMu.textContent = fmt(mu, 2);
      el.mSigma.textContent = fmt(sigma, 3);
      el.mSupp.textContent = home.sites.reduce((a, s) => a + s.zSuppressed, 0);
    }
  }

  function dotColor(type) {
    return type === "surge" ? "#ef4444" :
           type === "fan"   ? "#f97316" :
           type === "soil"  ? "#f59e0b" :
           type === "thermal" ? "#a855f7" : "#6b7280";
  }

  function renderAnalyst(home) {
    // Populate site options once (or if list changed)
    const sitesSig = home.sites.map((s) => s.id).join(",");
    if (el.aSite.dataset.sig !== sitesSig) {
      el.aSite.innerHTML = `<option value="all">All sites</option>` +
        home.sites.map((s) => `<option value="${s.id}">${s.id}</option>`).join("");
      el.aSite.dataset.sig = sitesSig;
    }

    const metric = el.aMetric.value;
    const siteFilter = el.aSite.value;
    const history = aggregateHistory(home, siteFilter, metric, aRange);
    const values = history.map((p) => p.v);

    drawSpark(el.analystChart, values, { withAxes: true, stroke: "#1e3a8a", big: true, points: history });

    if (values.length) {
      const mu = values.reduce((a, b) => a + b, 0) / values.length;
      const variance = values.reduce((a, b) => a + (b - mu) ** 2, 0) / values.length;
      el.aMean.textContent = fmt(mu, 2);
      el.aStd.textContent = fmt(Math.sqrt(variance), 2);
      el.aMin.textContent = fmt(Math.min(...values), 2);
      el.aMax.textContent = fmt(Math.max(...values), 2);
      el.aN.textContent = values.length;
    } else {
      el.aMean.textContent = "—"; el.aStd.textContent = "—";
      el.aMin.textContent = "—"; el.aMax.textContent = "—";
      el.aN.textContent = "0";
    }

    // Efficiency chart: power/theoretical across all sites
    const eff = [];
    home.sites.forEach((s) => {
      s.history.forEach((h) => {
        const theo = (h.irradiance / 1000) * s.ratedKw * 0.92;
        if (theo > 0.3) eff.push(clamp(h.power / theo, 0, 1.2));
      });
    });
    drawSpark(el.effChart, eff, { withAxes: true, stroke: "#10b981", big: true, band: 0.75 });
  }

  function aggregateHistory(home, siteFilter, metric, range) {
    const now2 = now();
    const horizonMs = range === "24h" ? 24 * 3600 * 1000 :
                     range === "7d"  ?  7 * 24 * 3600 * 1000 :
                                       30 * 24 * 3600 * 1000;
    const sites = siteFilter === "all" ? home.sites : home.sites.filter((s) => s.id === siteFilter);
    const map = new Map();
    sites.forEach((s) => {
      s.history.forEach((h) => {
        if (now2 - h.ts > horizonMs) return;
        const bucket = Math.floor(h.ts / (HISTORY_STEP_S * 1000));
        const key = bucket;
        const entry = map.get(key) || { ts: h.ts, sum: 0, n: 0 };
        entry.sum += h[metric === "irr" ? "irradiance" : metric] || 0;
        entry.n += 1;
        map.set(key, entry);
      });
    });
    return Array.from(map.values())
      .sort((a, b) => a.ts - b.ts)
      .map((e) => ({ ts: e.ts, v: e.sum / Math.max(1, e.n) }));
  }

  function renderTelemetry(home) {
    streamMqtt(el.telemetryLog, home.mqttLog, 180, el.telLive, home.networkUp);
  }
  const el_extra = {}; // filled on boot
  function streamMqtt(container, buffer, cap, liveBadge, online) {
    if (!container) return;
    // Live badge state
    if (liveBadge) {
      liveBadge.textContent = online ? "Live" : "Paused · Cached";
      liveBadge.classList.toggle("paused", !online);
    }
    // No messages yet
    if (!buffer.length) {
      container.innerHTML = online
        ? '<div class="muted">Awaiting first publish…<span class="console-cursor"></span></div>'
        : '<div class="muted">Uplink offline — messages queued in edge cache. Restore uplink to flush.</div>';
      container.dataset.lastId = "";
      return;
    }

    // Incremental prepend: only inject rows with id > lastRenderedId
    const lastId = Number(container.dataset.lastId || 0);
    const fresh = [];
    for (const m of buffer) {
      if (m.id > lastId) fresh.push(m);
      else break; // buffer is newest-first so we can stop at the first stale entry
    }
    if (fresh.length) {
      const html = fresh.map((l) => rowHtml(l, true)).join("");
      // If the container currently shows a placeholder, clear it
      if (container.querySelector(".muted")) container.innerHTML = "";
      container.insertAdjacentHTML("afterbegin", html);
      container.dataset.lastId = String(buffer[0].id);
      // Trim excess children
      while (container.children.length > cap) container.removeChild(container.lastChild);
      // Drop the animation class after it plays so future prepends stay cheap
      setTimeout(() => {
        container.querySelectorAll(".msg-new").forEach((n) => n.classList.remove("msg-new"));
      }, 520);
    }
  }
  function rowHtml(l, animate) {
    return `<div class="${animate ? "msg-new" : ""}">` +
      `<span class="m-ts">${isoTime(l.ts)}</span> ` +
      (l.fromCache ? '<span style="color:#a855f7">[cached]</span> ' : '') +
      `<span class="m-topic">${escape(l.prefix || "MQTT Publish:")}</span> ` +
      `<span class="m-body">${escape(l.body)}</span>` +
      `</div>`;
  }

  function applyScenario(home, id) {
    home.activeScenario = id;
    // Baseline
    home.sites.forEach((s) => { s.faults.clear(); s.fanHealth = 1; s.soilingPct = 0; s.vBuf.length = 0; s.pBuf.length = 0; s.tBuf.length = 0; s.zWindow.length = 0; s.lastPublishAt = 0; });
    home.aggBuf.length = 0;
    home.networkUp = true;
    // Clear stale alert dedupe cache and open alerts so the diagnostics engine
    // reports only the new scenario's signal, not leftover noise.
    home.alerts = [];
    home.lastAlertSig = new Map();
    home.budgetAlertSent = false;

    if (id === "optimal")   { home.weather = "clear";  showToast("Scenario: Optimal Conditions"); }
    else if (id === "cloudy")    { home.weather = "cloudy"; showToast("Scenario: Heavy Cloud Cover"); }
    else if (id === "soil")      { home.weather = "clear";  home.sites.forEach((s) => { s.faults.add("soil"); s.soilingPct = 0.25; }); showToast("Scenario: Dust / Dirt Buildup"); }
    else if (id === "thermal")   { home.weather = "clear";  showToast("Scenario: Thermal Stress"); }
    else if (id === "equipment") { home.weather = "clear";  if (home.sites[0]) home.sites[0].faults.add("surge"); showToast("Scenario: Equipment Fault"); }
    else if (id === "offline")   { home.weather = "clear";  home.networkUp = false; home.syncState = "caching"; showToast("Scenario: Connectivity Loss"); }

    // Warm-up ticks so the UI reflects the scenario immediately rather than
    // waiting for the next 1-second interval.
    for (let i = 0; i < 12; i++) tickHome(home);
    saveSettings();
    render();
  }

  function renderInfra(home) {
    el.pEdge.textContent = home.sites.length;
    el.pIot.textContent = home.counters.iotMsgs.toLocaleString();
    el.pLambda.textContent = home.counters.lambdas.toLocaleString();
    el.pDdb.textContent = home.counters.ddbWrites.toLocaleString();
    const flow = home.networkUp;
    el.arrow1.classList.toggle("flowing", flow);
    el.arrow2.classList.toggle("flowing", flow);
    el.arrow3.classList.toggle("flowing", flow);

    streamMqtt(el.mqttLog, home.mqttLog, 60, el.mqttLive, home.networkUp);
  }

  function renderSim(home) {
    const opts = home.sites.map((s) => `<option value="${s.id}">${s.id}</option>`).join("");
    [el.surgeSite, el.fanSite, el.soilSite, el.noiseSite].forEach((sel) => {
      if (sel.dataset.sig !== opts) { sel.innerHTML = opts; sel.dataset.sig = opts; }
    });
    el.weatherMode.value = home.weather;
    el.netToggle.checked = home.networkUp;
    el.netLabel.textContent = home.networkUp ? "Uplink online" : "Uplink offline — store-and-forward engaged";
    el.cacheCount.textContent = home.cache.length;
    el.lastBurst.textContent = home.lastBurstTs ? humanTime(home.lastBurstTs) : "—";
    el.syncState.textContent = home.syncState;
    el.simSpeed.value = String(state.simSpeed);
  }

  function renderAdmin(home) {
    const spend = projectedSpend(home);
    const pct = clamp(spend / home.budgetLimit, 0, 1.05);
    el.budgetFill.style.width = `${pct * 100}%`;
    el.budgetSpend.textContent = `${CURRENCY}${fmt(spend, 2)}`;
    el.budgetLimit.textContent = fmt(home.budgetLimit, 2);
    el.budgetLimitInput.value = home.budgetLimit;
    el.bLambda.textContent = home.counters.lambdas.toLocaleString();
    el.bDdb.textContent = home.counters.ddbWrites.toLocaleString();
    el.bIot.textContent = home.counters.iotMsgs.toLocaleString();
    el.bMb.textContent = fmt(home.counters.bytes / (1024 * 1024), 2);
    el.budgetBanner.classList.toggle("hidden", spend < home.budgetLimit);
  }

  /* ---------- SVG charts ---------- */
  function drawSpark(svg, values, opts = {}) {
    if (!svg) return;
    const vb = svg.viewBox.baseVal;
    const W = vb.width, H = vb.height;
    const pad = opts.withAxes ? 52 : 2;
    const padY = opts.withAxes ? 18 : 2;
    const n = values.length;
    let min = opts.min ?? Infinity, max = opts.max ?? -Infinity;
    values.forEach((v) => { if (v < min) min = v; if (v > max) max = v; });
    if (opts.maxHint && opts.maxHint > max) max = opts.maxHint;
    if (!isFinite(min)) { min = 0; max = 1; }
    // Pad the numeric range so the trace sits comfortably between the grid lines
    if (opts.autoPad && isFinite(min) && isFinite(max)) {
      const padRange = Math.max(opts.autoPad, (max - min) * 0.25);
      min -= padRange; max += padRange;
      if (opts.min != null) min = Math.max(min, opts.min);
    }
    if (max - min < 0.001) { max = min + 1; }

    const xScale = (i) => pad + (i / Math.max(1, n - 1)) * (W - pad - 4);
    const yScale = (v) => H - padY - ((v - min) / (max - min)) * (H - padY * 2);

    let path = "";
    let areaPath = "";
    for (let i = 0; i < n; i++) {
      const x = xScale(i), y = yScale(values[i]);
      path += (i === 0 ? "M" : "L") + x.toFixed(1) + " " + y.toFixed(1) + " ";
      if (i === 0) areaPath = `M${x.toFixed(1)} ${H - padY} L${x.toFixed(1)} ${y.toFixed(1)} `;
      else areaPath += `L${x.toFixed(1)} ${y.toFixed(1)} `;
    }
    if (n > 1) areaPath += `L${xScale(n - 1).toFixed(1)} ${H - padY} Z`;

    const stroke = opts.stroke || "#00bc7d";
    const unit = opts.unit || "";
    const digits = opts.digits != null ? opts.digits : 1;

    let grid = "";
    let axis = "";
    if (opts.withAxes) {
      for (let g = 0; g < 4; g++) {
        const y = padY + (g / 3) * (H - padY * 2);
        grid += `<line class="spark-grid" x1="${pad}" y1="${y.toFixed(1)}" x2="${W - 4}" y2="${y.toFixed(1)}"/>`;
        const val = max - (g / 3) * (max - min);
        axis += `<text class="spark-axis" x="${pad - 6}" y="${(y + 3).toFixed(1)}" text-anchor="end">${fmt(val, digits)}${unit}</text>`;
      }
    }

    let band = "";
    if (opts.band != null) {
      const y = yScale(opts.band);
      band = `<line stroke="#ef4444" stroke-dasharray="3 4" stroke-width="1" x1="${pad}" y1="${y.toFixed(1)}" x2="${W - 4}" y2="${y.toFixed(1)}"/>`;
    }

    // Hover overlay group — populated on mousemove
    const overlay = `<g class="spark-hover" id="${svg.id || ""}_hover" style="display:none">
      <line class="hover-line" x1="0" y1="${padY}" x2="0" y2="${H - padY}" stroke="${stroke}" stroke-width="1" stroke-dasharray="3 3" opacity="0.7"/>
      <circle class="hover-dot" cx="0" cy="0" r="4" fill="${stroke}" stroke="#0a0a0c" stroke-width="2"/>
    </g>`;

    svg.innerHTML = grid +
      (n > 1 ? `<path class="spark-area" d="${areaPath}" style="fill:${stroke}"/>` : "") +
      (n ? `<path class="spark-line" d="${path}" style="stroke:${stroke}"/>` : `<text class="spark-axis" x="${W / 2}" y="${H / 2}" text-anchor="middle">collecting samples…</text>`) +
      band + axis + overlay;

    // Remember the data for the hover handler (wireup only runs once per svg)
    svg._sg = {
      values, W, H, pad, padY, min, max, n, unit, digits,
      xScale, yScale,
      tsStart: opts.tsStart || (now() - (n - 1) * 1000),
      stepMs: opts.stepMs || 1000,
    };
    if (!svg._sgWired) bindHover(svg);
  }

  function bindHover(svg) {
    svg._sgWired = true;
    const wrap = svg.closest(".chart-wrap");
    if (!wrap) return;
    const tip = wrap.querySelector(".chart-tip");
    const overlay = svg.querySelector(".spark-hover");

    function onMove(e) {
      const data = svg._sg;
      if (!data || !data.n) return;
      const rect = svg.getBoundingClientRect();
      const relX = e.clientX - rect.left;
      // Map from CSS pixels to SVG viewBox X
      const vbX = (relX / rect.width) * data.W;
      // Nearest index in buffer
      const usableW = data.W - data.pad - 4;
      const approxI = Math.round(((vbX - data.pad) / usableW) * (data.n - 1));
      const i = clamp(approxI, 0, data.n - 1);
      const v = data.values[i];
      const x = data.xScale(i);
      const y = data.yScale(v);

      // Move crosshair + dot
      const line = svg.querySelector(".hover-line");
      const dot = svg.querySelector(".hover-dot");
      if (line) { line.setAttribute("x1", x); line.setAttribute("x2", x); }
      if (dot) { dot.setAttribute("cx", x); dot.setAttribute("cy", y); }
      svg.querySelector(".spark-hover").style.display = "block";

      // Position tooltip in CSS pixels relative to wrap
      if (tip) {
        const cssX = (x / data.W) * rect.width;
        const cssY = (y / data.H) * rect.height;
        tip.style.left = cssX + "px";
        tip.style.top = cssY + "px";
        const ts = data.tsStart + i * data.stepMs;
        const tsEl = tip.querySelector(".tip-ts");
        const valEl = tip.querySelector(".tip-val");
        if (tsEl) tsEl.textContent = isoTime(ts);
        if (valEl) valEl.textContent = `${fmt(v, data.digits)} ${data.unit || ""}`.trim();
      }
    }

    function onLeave() {
      const overlay = svg.querySelector(".spark-hover");
      if (overlay) overlay.style.display = "none";
    }

    svg.addEventListener("mousemove", onMove);
    svg.addEventListener("mouseleave", onLeave);
  }

  /* ---------- Toast ---------- */
  const toastEl = $("#toast");
  let toastTimer;
  function showToast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("show"), 2600);
  }

  /* ---------- Home menu ---------- */
  function renderHomeMenu() {
    el.homeMenuList.innerHTML = state.homes.map((h, i) => {
      const open = h.alerts.filter((a) => !a.acked).length;
      return `
        <li data-home="${h.id}" class="${h.id === state.currentHomeId ? "active" : ""}">
          <div class="h-icon">${h.name.slice(0, 1).toUpperCase()}</div>
          <div class="h-meta">
            <span class="h-name">${escape(h.name)}</span>
            <span class="h-sub">${h.region} · ${h.sites.length} inverters · ${open} open</span>
          </div>
          <span class="h-check">${h.id === state.currentHomeId ? "✓" : ""}</span>
        </li>
      `;
    }).join("");
  }

  function openHomeMenu() {
    renderHomeMenu();
    el.homeMenu.hidden = false;
    el.homeBtn.setAttribute("aria-expanded", "true");
  }
  function closeHomeMenu() {
    el.homeMenu.hidden = true;
    el.homeBtn.setAttribute("aria-expanded", "false");
  }

  /* ---------- Event wiring ---------- */
  function wire() {
    // nav
    $$(".nav-btn").forEach((b) =>
      b.addEventListener("click", () => switchView(b.dataset.view)));

    // home menu
    el.homeBtn.addEventListener("click", () => {
      el.homeMenu.hidden ? openHomeMenu() : closeHomeMenu();
    });
    document.addEventListener("click", (e) => {
      if (!el.homeMenu.contains(e.target) && !el.homeBtn.contains(e.target)) closeHomeMenu();
    });
    el.homeMenuList.addEventListener("click", (e) => {
      const li = e.target.closest("li[data-home]");
      if (!li) return;
      state.currentHomeId = li.dataset.home;
      saveSettings();
      closeHomeMenu();
      // Reset stream state so the log restarts from this home's newest messages
      if (el.telemetryLog) el.telemetryLog.dataset.lastId = "";
      if (el.mqttLog) el.mqttLog.dataset.lastId = "";
      render();
      showToast(`Switched to ${currentHome().name}`);
    });
    $("#homeAdd").addEventListener("click", () => {
      const name = prompt("Name this home (e.g. 'Seaside cottage')");
      if (!name) return;
      const region = prompt(`Region code (e.g. ${REGIONS.slice(0, 3).join(", ")})`, REGIONS[0]) || REGIONS[0];
      const count = parseInt(prompt("How many inverters to seed?", "3"), 10) || 3;
      const h = makeHome(name.trim(), region.trim(), clamp(count, 1, 12));
      state.homes.push(h);
      state.currentHomeId = h.id;
      saveSettings();
      renderHomeMenu();
      render();
      showToast(`Added home: ${h.name}`);
    });
    $("#homeRename").addEventListener("click", () => {
      const h = currentHome(); if (!h) return;
      const name = prompt("Rename home", h.name);
      if (name && name.trim()) { h.name = name.trim(); saveSettings(); render(); renderHomeMenu(); }
    });
    $("#homeRemove").addEventListener("click", () => {
      const h = currentHome(); if (!h) return;
      if (state.homes.length <= 1) { showToast("At least one home is required."); return; }
      if (!confirm(`Remove ${h.name}? This cannot be undone.`)) return;
      state.homes = state.homes.filter((x) => x.id !== h.id);
      state.currentHomeId = state.homes[0].id;
      saveSettings();
      closeHomeMenu();
      render();
    });

    // scenario simulator
    document.body.addEventListener("click", (e) => {
      const sc = e.target.closest("[data-scenario]");
      if (!sc) return;
      const home = currentHome(); if (!home) return;
      applyScenario(home, sc.dataset.scenario);
    });

    // alerts (overview + mobile + bell)
    document.body.addEventListener("click", (e) => {
      const ack = e.target.closest("[data-ack]");
      if (ack) {
        const id = ack.dataset.ack;
        const home = currentHome();
        if (home) {
          const a = home.alerts.find((x) => x.id === id);
          if (a) { a.acked = true; render(); }
        }
      }
      const tile = e.target.closest(".site-tile");
      if (tile) {
        selectedSiteId = tile.dataset.site;
        switchView("sites");
      }
      const rowAction = e.target.closest("[data-row-fault]");
      if (rowAction) {
        const home = currentHome(); if (!home) return;
        const site = home.sites.find((s) => s.id === rowAction.dataset.siteId);
        if (!site) return;
        const which = rowAction.dataset.rowFault;
        if (which === "fan") {
          if (site.faults.has("fan")) { site.faults.delete("fan"); showToast(`${site.id}: fan restored`); }
          else { site.faults.add("fan"); showToast(`${site.id}: fan blow-out — RPM dropping`); }
        } else if (which === "soil") {
          if (site.faults.has("soil")) { site.faults.delete("soil"); showToast(`${site.id}: dust cleared`); }
          else { site.faults.add("soil"); site.soilingPct = Math.max(site.soilingPct, 0.22); showToast(`${site.id}: dust accumulating`); }
        } else if (which === "thermal") {
          if (site.faults.has("thermal")) { site.faults.delete("thermal"); showToast(`${site.id}: thermal stress cleared`); }
          else { site.faults.add("thermal"); showToast(`${site.id}: thermal stress engaged`); }
        } else if (which === "reset") {
          site.faults.clear(); site.fanHealth = 1; site.soilingPct = 0;
          showToast(`${site.id}: all faults cleared`);
        }
        render();
        return;
      }
      const row = e.target.closest("#sitesTable tr[data-site]");
      if (row) {
        selectedSiteId = row.dataset.site;
        render();
      }
    });
    $("#siteDetailClose").addEventListener("click", hideSiteDetail);

    $("#alertBell").addEventListener("click", () => switchView("overview"));
    $("#mAckAll").addEventListener("click", () => {
      const home = currentHome(); if (!home) return;
      home.alerts.forEach((a) => a.acked = true);
      render();
      showToast("All alerts acknowledged");
    });

    // analyst
    $$(".range-btn").forEach((b) =>
      b.addEventListener("click", () => {
        $$(".range-btn").forEach((x) => x.classList.toggle("is-active", x === b));
        aRange = b.dataset.range;
        render();
      }));
    el.aSite.addEventListener("change", render);
    el.aMetric.addEventListener("change", render);
    $("#exportCsv").addEventListener("click", () => exportData("csv"));
    $("#exportJson").addEventListener("click", () => exportData("json"));

    // simulation
    document.body.addEventListener("click", (e) => {
      const b = e.target.closest("[data-fault]");
      if (!b) return;
      const home = currentHome(); if (!home) return;
      const which = b.dataset.fault;
      const sel = { surge: el.surgeSite, fan: el.fanSite, soil: el.soilSite, noise: el.noiseSite }[which];
      const siteId = sel && sel.value;
      const site = home.sites.find((s) => s.id === siteId);
      if (!site) return;
      if (which === "surge") { site.faults.add("surge"); showToast(`Surge queued at ${site.id}`); }
      if (which === "fan")   { site.faults.add("fan");   showToast(`Fan failure engaged at ${site.id}`); }
      if (which === "soil")  { site.faults.add("soil");  showToast(`Soiling building at ${site.id}`); }
      if (which === "noise") { site.faults.add("noise"); site.noiseBoostUntil = now() + 12000; showToast(`Noise burst at ${site.id}`); setTimeout(() => site.faults.delete("noise"), 12000); }
    });

    $("#clearFaults").addEventListener("click", () => {
      const home = currentHome(); if (!home) return;
      home.sites.forEach((s) => { s.faults.clear(); s.fanHealth = 1; s.soilingPct = 0; });
      showToast("All faults cleared");
      render();
    });

    el.weatherMode.addEventListener("change", () => {
      const home = currentHome(); if (!home) return;
      home.weather = el.weatherMode.value;
      state.globalWeather = home.weather;
      saveSettings();
      render();
    });

    el.netToggle.addEventListener("change", () => {
      const home = currentHome(); if (!home) return;
      home.networkUp = el.netToggle.checked;
      home.syncState = home.networkUp ? (home.cache.length ? "flushing" : "idle") : "caching";
      saveSettings();
      render();
      showToast(home.networkUp ? "Uplink restored — flushing cache" : "Uplink dropped — caching locally");
    });

    el.simSpeed.addEventListener("change", () => {
      state.simSpeed = Number(el.simSpeed.value);
      saveSettings();
    });

    $("#addSite").addEventListener("click", () => {
      const home = currentHome(); if (!home) return;
      home.sites.push(makeSite({ region: home.region }));
      saveSettings();
      render();
      showToast("Inverter added");
    });
    $("#removeSite").addEventListener("click", () => {
      const home = currentHome(); if (!home) return;
      if (home.sites.length <= 1) { showToast("Home must retain at least one inverter."); return; }
      home.sites.pop();
      saveSettings();
      render();
    });
    $("#hardReset").addEventListener("click", () => {
      if (!confirm("Delete all homes, alerts, and settings?")) return;
      localStorage.removeItem(LS_KEY);
      location.reload();
    });

    // admin
    el.budgetLimitInput.addEventListener("change", () => {
      const home = currentHome(); if (!home) return;
      const v = Number(el.budgetLimitInput.value);
      if (!v || v <= 0) return;
      home.budgetLimit = v;
      home.budgetAlertSent = false;
      saveSettings();
      render();
    });
  }

  /* ---------- Export ---------- */
  function exportData(format) {
    const home = currentHome(); if (!home) return;
    const rows = [];
    home.sites.forEach((s) => {
      s.history.forEach((h) => {
        rows.push({
          home: home.name, site: s.id, vendor: s.vendor, region: s.region,
          ts: new Date(h.ts).toISOString(),
          power_kw: +h.power.toFixed(3),
          voltage_v: +h.voltage.toFixed(2),
          int_temp_c: +h.intTemp.toFixed(2),
          delta_c: +h.delta.toFixed(2),
          irradiance_w_m2: Math.round(h.irradiance),
        });
      });
    });
    if (!rows.length) return showToast("No history yet — let the sim run a minute.");
    let blob;
    if (format === "csv") {
      const header = Object.keys(rows[0]).join(",");
      const body = rows.map((r) => Object.values(r).join(",")).join("\n");
      blob = new Blob([header + "\n" + body], { type: "text/csv" });
    } else {
      blob = new Blob([JSON.stringify(rows, null, 2)], { type: "application/json" });
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `solarguard_${home.name.replace(/\W+/g, "_")}.${format}`;
    a.click();
    URL.revokeObjectURL(url);
    showToast(`Exported ${rows.length} rows`);
  }

  /* ---------- Escape ---------- */
  function escape(str) {
    return String(str ?? "").replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  /* ---------- Boot ---------- */
  function boot() {
    loadSettings();
    seedIfEmpty();
    state.homes.forEach((h) => h.weather = state.globalWeather);
    wire();
    const initial = location.hash.replace("#", "");
    if (initial) switchView(initial); else render();
    setInterval(mainTick, TICK_MS);
    mainTick();
  }

  document.addEventListener("DOMContentLoaded", boot);
})();
