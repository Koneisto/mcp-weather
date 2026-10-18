# 🇪🇺🇫🇮 mcp-weather

[![CI](https://github.com/Koneisto/mcp-weather/actions/workflows/ci.yml/badge.svg)](https://github.com/Koneisto/mcp-weather/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/Koneisto/mcp-weather)](https://github.com/Koneisto/mcp-weather/releases/latest)
[![License: MIT](https://img.shields.io/github/license/Koneisto/mcp-weather)](LICENSE)
![Node.js](https://img.shields.io/badge/node-%3E%3D22-brightgreen)

A [Model Context Protocol](https://modelcontextprotocol.io/) (MCP) server for weather in the Nordic and Baltic countries and the rest of Europe. It uses the national weather services where they are best: station observations from FMI, SMHI, DMI, the Icelandic Met Office, LHMT and the Estonian Environment Agency, MET Norway's high-resolution MET Nordic forecast and analysis, official warnings from FMI, SMHI, MET Norway and MeteoAlarm, sea level and waves from the national tide gauges and buoys, Finnish lake levels and water temperatures from Syke, Finnish road weather from Fintraffic, radar nowcasts, and aurora forecasts from FMI magnetometers and NOAA. Works out of the box with zero API keys -- add optional keys to unlock more sources.

## Features

- **Nordic weather services** -- FMI (Finland), MET Norway, SMHI (Sweden), DMI (Denmark), Icelandic Met Office, LHMT (Lithuania), Estonian Environment Agency, Kartverket (Norway), Syke (Finnish lakes), Fintraffic, MeteoAlarm, NOAA SWPC, plus Open-Meteo, wttr.in, METAR and optional OpenWeatherMap, WeatherAPI, Tomorrow.io
- **National forecasts** -- in Finland the daily forecast comes from FMI's meteorologist-edited forecast (the one on ilmatieteenlaitos.fi), elsewhere in the Nordic and Baltic countries from MET Norway's 2.5 km MET Nordic model (post-processed with station observations), and outside them from Open-Meteo's best-match blend
- **Official warnings in 8 countries** -- Finland, Sweden and Norway matched to the location (warning polygons and point queries), Denmark, Iceland and the Baltic countries per country
- **Radar nowcast** -- will it rain in the next 2 hours, in 5-minute steps (MET Norway)
- **Northern lights** -- Kp needed at the latitude, NOAA Kp forecast, FMI R-index measured right now, darkness and cloud cover hour by hour
- **Measured current weather** -- the nearest station of the national weather service within 15 km comes first: FMI (Finland), SMHI (Sweden), DMI (Denmark), Icelandic Met Office, LHMT (Lithuania) and the Estonian Environment Agency; in Norway the MET Nordic analysis (observations and radar on a 1 km grid); in Finland, Sweden and Denmark the MET Nordic analysis also fills in between stations. Models fill in what the station does not measure, and farther away the nearest station within 50 km is shown for reference. In Finland air quality is measured at the nearest air quality station within 10 km
- **Sea** -- measured sea level against each country's reference (FMI, SMHI, DMI, Kartverket) with the forecast in Finland and Norway, water temperature, wave buoys, and a wave model anywhere at sea
- **Finnish lakes** -- water level as height above sea level (N2000) with the change in a week and the normal for the date (previous 30 years), surface water temperature against its normal, and ice thickness in winter, for about 800 Syke stations; ask by lake name (`Saimaa` includes its basins such as Haukivesi and Pihlajavesi) or by place
- **Road weather in Finland** -- road surface temperature and state, friction and slipperiness warnings from the nearest Fintraffic road weather station, and the road condition forecast for the next 12 hours
- **12 MCP tools** -- current weather, forecast, precipitation nowcast, warnings, marine conditions, lake conditions, road weather, air quality with pollen, aurora, aviation METAR, astronomy, source status
- **Nordic/Finnish focus** -- 30+ Finnish cities with instant alias resolution (e.g. `hki`, `tre`, `stadi`), Nordic/Baltic capitals included
- **Multi-source aggregation** -- merges data from all available sources for more complete and accurate results
- **Zero-config start** -- every source works without an API key except the three optional ones
- **Smart caching** -- LRU cache with stampede prevention, configurable TTL

## MCP Tools

| Tool | Description |
|------|-------------|
| `get_current_weather` | Current conditions merged into one result; the nearest national weather station (FI, SE, DK, IS, LT, EE) or the MET Nordic analysis (NO) comes first, then the models |
| `get_weather_forecast` | 1-7 day daily forecast (temperature, precipitation, wind, UV); in Finland FMI's meteorologist-edited forecast, elsewhere in the Nordic and Baltic countries the MET Nordic model |
| `get_precipitation_nowcast` | Rain or snow in the next 2 hours from radar, 5-minute steps: raining now, start and end, heaviest rate, total (MET Norway, Nordic radar area) |
| `get_weather_warnings` | Active official warnings in Finland (FMI), Sweden (SMHI), Norway (MET Norway), Denmark, Iceland, Estonia, Latvia, Lithuania (MeteoAlarm); English, Finnish, Swedish or Norwegian where available |
| `get_marine_conditions` | Sea level against the national reference and its forecast (Finland, Norway), water temperature and wave buoys (FMI, SMHI, DMI, Kartverket), wave model (MET Norway Oceanforecast in Norway, Open-Meteo Marine elsewhere) |
| `get_lake_conditions` | Finland: lake or river water level (gauge and N2000 height, change in a week, normal for the date over the previous 30 years), surface water temperature against its normal, ice thickness in winter (Syke); by lake name or place; optional daily history of up to 60 days for charts |
| `get_road_weather` | Finland: nearest Fintraffic road weather station (road surface temperature and state, friction, slipperiness warning, precipitation, visibility, wind) and the road condition forecast for 12 hours |
| `get_aurora_forecast` | Northern lights chance hour by hour: Kp needed at the latitude, NOAA Kp forecast, FMI R-index now (Finland), darkness and cloud cover |
| `get_air_quality` | European AQI with PM2.5, PM10, NO2, O3, SO2, CO levels; in Finland measured at the nearest air quality station (within 10 km); pollen (alder, birch, grass, mugwort, ragweed) from CAMS |
| `get_metar` | Aviation weather (raw + decoded) from aviationweather.gov; for Finnish airports falls back to the airport's FMI weather station observation |
| `get_astronomy` | Sun and moon computed locally: sunrise/sunset, solar noon and altitude, twilight phases, golden hour, day length, moon phase, illumination, moonrise/moonset, midnight sun and polar night |
| `get_weather_source_status` | Health check for all sources + cache statistics |

## Location Input

The server accepts multiple location formats:

| Format | Example | Notes |
|--------|---------|-------|
| Finnish alias | `hki`, `tre`, `stadi`, `turku` | 30+ cities with ICAO codes |
| Nordic capital | `stockholm`, `oslo`, `tallinn` | Finnish names work too (`tukholma`) |
| City name | `London`, `Roma`, `Lontoo` | Geocoded via Open-Meteo in several languages; the capital or largest exact match wins |
| Coordinates | `60.17,24.94` | Latitude, longitude |
| ICAO code | `EFHK`, `ESSA` | Airport position (all tools) |

## Quick Start

Requires Node.js 22 or later, or only Docker (the image compiles the TypeScript itself).

### Docker (recommended)

```bash
git clone https://github.com/Koneisto/mcp-weather.git
cd mcp-weather
cp .env.example .env          # optionally add API keys
docker network create mcp-network   # once; docker-compose.yml expects this network
docker compose up -d
```

The server will be available at `http://localhost:3015/mcp` (Streamable HTTP), with a health check at `http://localhost:3015/health`. The published port binds to loopback by default. To allow trusted LAN clients, set `MCP_BIND_ADDRESS` to the host's LAN address in `.env`. HTTP has no built-in authentication: use an authenticating proxy before exposing it to untrusted clients.

### Local Development

```bash
git clone https://github.com/Koneisto/mcp-weather.git
cd mcp-weather
npm ci
npm run build
node build/index.js           # stdio transport
node build/index.js --http    # Streamable HTTP on PORT (default 3000), /mcp
```

### MCP client (stdio)

Add to your MCP client configuration:

```json
{
  "mcpServers": {
    "weather": {
      "command": "node",
      "args": ["/path/to/mcp-weather/build/index.js"],
      "env": {
        "OPENWEATHERMAP_API_KEY": "",
        "WEATHERAPI_KEY": "",
        "TOMORROW_IO_API_KEY": ""
      }
    }
  }
}
```

## Configuration

All settings are via environment variables. Copy `.env.example` to `.env` to get started.

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENWEATHERMAP_API_KEY` | *(empty)* | [OpenWeatherMap](https://openweathermap.org/api) free tier key |
| `WEATHERAPI_KEY` | *(empty)* | [WeatherAPI](https://www.weatherapi.com/) free tier key |
| `TOMORROW_IO_API_KEY` | *(empty)* | [Tomorrow.io](https://www.tomorrow.io/weather-api/) free tier key |
| `CACHE_TTL_MINUTES` | `60` | Cache time-to-live in minutes |
| `CACHE_MAX_ENTRIES` | `200` | Maximum cached responses |
| `HTTP_TIMEOUT_MS` | `10000` | Upstream deadline including queue and response body; inbound JSON body deadline, in milliseconds |
| `HTTP_MAX_RESPONSE_BYTES` | `8388608` | Maximum decoded upstream body size (8 MiB) |
| `HTTP_MAX_CONCURRENT` / `HTTP_MAX_QUEUED` | `8` / `64` | Maximum active upstream requests and waiting jobs; queued jobs keep their original deadline |
| `MAX_HTTP_REQUESTS` | `8` | Maximum simultaneous MCP HTTP requests; overload returns 503 with Retry-After |
| `CACHE_MAX_INFLIGHT` | `64` | Maximum distinct pending cache fetches; identical work is shared |
| `MCP_BIND_ADDRESS` | `127.0.0.1` | Docker published address; use a trusted LAN address only when needed |
| `PORT` / `HOST` | `3000` / `127.0.0.1` | Listen address in HTTP mode (Docker explicitly uses `0.0.0.0` inside its network) |
| `MCP_TRANSPORT` | *(stdio)* | `http` = same as `--http` |
| `ALLOWED_ORIGINS` | *(empty)* | HTTP mode: extra browser origins allowed to call `/mcp`, comma-separated (requests without `Origin` and from localhost are always allowed) |
| `MCP_WEATHER_KEY_NOTE` | *(on)* | `off` = no one-time note about missing optional API keys |

### Adding API keys

The server tells you what is missing: if optional keys are not set, the first answer carries a one-time note, and
`get_weather_source_status` lists each missing key with a free sign-up link and how to set it. To add a key:

- **Docker:** put `KEY=value` in `.env` next to `docker-compose.yml` and run `docker compose up -d`.
- **Local (stdio):** add the key to the `env` block of this server in your MCP client configuration and restart the client.

### Resource limits and runtime image

Every provider uses the same bounded HTTPS client: deadlines cover the complete decoded body and waiting time,
response bytes and concurrency are capped, and redirects are rejected. Syke pagination stays within its HTTPS API.
Coordinates must be within latitude −90…90 and longitude −180…180, location inputs are capped at 200 characters,
and invalid numeric configuration fails at startup.

The container runs one bundled JavaScript file without `node_modules`, npm, or a compiler. A production dependency
SBOM is included at `/app/sbom.cdx.json`; CI scans that SBOM as well as the image so bundling does not hide vulnerable
libraries. The Node and scanner images are pinned by digest. The runtime is non-root and Compose uses a read-only
filesystem, dropped capabilities and no-new-privileges. Cached responses and in-flight work are shared across clients.

### Sources by API Key Requirement

| Source | Requires Key | Data Provided |
|--------|-------------|---------------|
| FMI (Finnish Meteorological Institute) | No | Measured current conditions and air quality in Finland, the meteorologist-edited forecast, sea level and its forecast, wave buoys, METAR fallback for Finnish airports, warnings (CAP), aurora R-index |
| MET Norway | No | Radar nowcast, MET Nordic analysis (current weather in Norway), Oceanforecast (waves), warnings in Norway (MetAlerts); the MET Nordic model behind the Nordic forecast |
| SMHI | No | Station observations, sea level, water temperature and waves, warnings in Sweden |
| DMI | No | Station observations, sea level and water temperature in Denmark |
| Icelandic Met Office | No | Station observations in Iceland |
| LHMT (meteo.lt) | No | Station observations in Lithuania |
| Estonian Environment Agency | No | Station observations in Estonia |
| Kartverket | No | Sea level and its forecast in Norway |
| Syke (Finnish Environment Institute) | No | Lake and river water levels, surface water temperature, ice thickness in Finland |
| Fintraffic Digitraffic | No | Road weather stations and road condition forecast in Finland |
| MeteoAlarm (EUMETNET) | No | Warnings in Denmark, Iceland, Estonia, Latvia, Lithuania |
| NOAA SWPC | No | Planetary Kp, observed and forecast |
| Open-Meteo | No | Current, forecast (MET Nordic model in the Nordic area), air quality, pollen, cloud cover, wave model (Marine) |
| wttr.in | No | Current conditions |
| METAR | No | Aviation weather |
| OpenWeatherMap | Yes | Current conditions |
| WeatherAPI | Yes | Current conditions |
| Tomorrow.io | Yes | Current conditions (pauses 15 min after the free-tier rate limit; the free tier has no air quality fields) |

### FMI observations

FMI open data does not publish METAR messages, so the `get_metar` fallback for Finnish airports (EF**) is the
airport weather station's observation (temperature, dew point, wind, gusts, visibility, cloud cover, pressure).
The output says clearly that it is not a METAR: there is no raw message, flight category or cloud base height.
FMI data is used under [CC BY 4.0](https://en.ilmatieteenlaitos.fi/open-data-licence); outputs that contain it credit the
Finnish Meteorological Institute.

### How values are chosen

- **Current weather:** sources are merged field by field in a fixed order. The national station measurement within
  15 km comes first (in Norway the MET Nordic analysis), then the MET Nordic analysis in Finland, Sweden and Denmark,
  then the models, so measured values win and the models only fill fields the station does not measure. The output
  names the station, its provider, its distance and the observation time. Norway's station API (Frost) needs a
  registered client id and Latvia publishes bulk files only, so they have no station observations here.
- **Sea level:** each country measures against its own reference: FMI the theoretical mean sea level, SMHI RH 2000,
  DMI DVR90, Kartverket the mean sea level. The output names the reference, so values from different countries are
  not compared as if they were the same. A tide gauge within 60 km, water temperature within 40 km and a wave buoy
  within 100 km are used; the wave model covers the open sea and Iceland.
- **Lakes:** Syke publishes daily values. A water level gauge reads against its own zero, so the answer also gives
  the height above sea level (N2000) where Syke publishes the gauge's offset. The normal is the mean, lowest and highest
  value of the same calendar day in the previous 30 years. A lake name matches stations named after it or filed under it,
  then the basins Syke files as part of it ("Haukivesi (Saimaa …)"). A place uses the nearest water level station within
  25 km that still reports. Water temperature comes from the same lake (or a basin of it) within 150 km first, because
  the same water body describes the point better than a nearer different lake, then from the nearest station within
  50 km. Ice is local, so the nearest ice stations within 50 km come first, then the same lake. Ice is measured about
  every 10 days, so a thickness is shown when measured in the last 25 days and weak ice (too thin to measure, the first
  or last note of a winter) for 12 days; out of season the answer names the station that measured last winter.
  Each water level and temperature carries `ageDays` and `status`: `current` (at most 3 days old), `missing` (older,
  although the station measured on this calendar day in at least half of the last 10 years with data, so the data has
  stopped coming) or `off_season` (not normally measured now: water temperature is measured in the open-water season,
  at Saimaa roughly from late April to December). A water level is measured all year, so an old one is `missing`; after
  60 days the gauge is taken as stopped and left out.
- **Road weather:** the nearest station with data from the last hour within 30 km; a faulty road surface sensor is
  skipped (the second sensor or the optical one is used). The road condition forecast shows the worst condition per
  step over the road sections within 10 km and the roads and reasons behind a poor one. Sweden and Norway publish road
  weather only with registered keys, so the tool covers Finland.
- **Forecast in Finland:** FMI's hourly forecast is summed into local days (highest and lowest temperature, total
  precipitation, highest probability, highest wind, speed-weighted wind direction, the most severe weather symbol).
  A day comes from FMI only when FMI covers at least 18 of its hours, so today (already partly past) stays with the
  model; UV and sunrise/sunset always come from the model. Each day carries its `source`.
- **Air quality:** each pollutant is labelled *measured* or *model*, and the European AQI is computed from the values
  shown (EEA concentration bands, the highest sub-index), so the index always agrees with them.
- **Locations:** Finnish aliases and ICAO codes resolve locally; other names are geocoded in seven languages
  (en, fi, sv, de, fr, it, es), so both `Roma` and `Lontoo` work.

### Data sources and licences

Outputs name the sources they used and the new Nordic tools also return an `attribution` field. FMI data (including
the municipal air quality networks it distributes), MET Norway, SMHI, DMI, the Icelandic Met Office, Kartverket,
Syke, Fintraffic (digitraffic.fi), MeteoAlarm (data provided by EUMETNET members) and Open-Meteo data are licensed under
CC BY 4.0, LHMT (meteo.lt) data under CC BY-SA 4.0, and the Estonian Environment Agency's data may be used when
Keskkonnaagentuur is credited with a link to ilmateenistus.ee (both are in the output); METAR and Kp come from the US NOAA (public domain). Requests to
MET Norway follow its terms: an identifying User-Agent, coordinates with at most 4 decimals, no new request before the
`Expires` time and conditional requests with `If-Modified-Since`. Country outlines for locating coordinates are from
Natural Earth (public domain). The free Open-Meteo API is for non-commercial use; see
[Open-Meteo's terms](https://open-meteo.com/en/terms) for commercial use. wttr.in and the optional sources
(OpenWeatherMap, WeatherAPI, Tomorrow.io) are subject to their providers' terms. Keys for the optional sources are
read from the environment and are never written to output.

## Shared load, budgets and compact AI access

All HTTP clients share source work, caches and provider budgets within one service process. Use one process per
state directory: public reusable station/geocoding/model datasets survive restarts, while time-sensitive warnings
are fetched under their normal freshness rules. Separate weather and metadata LRU/byte budgets prevent a burst of
locations from evicting all station catalogs. Open-Meteo model/cache coordinates use at most four decimals; forecast day counts and cloud
windows reuse common representations. Current weather consults national observations first, then only the sources
needed for missing essential/requested fields. Optional `fields: ["temperature", "conditions"]` saves upstream work;
full-mode output stays compatible. Additional sources are not called just to fill optional UV or visibility fields.

`/mcp` and default stdio keep the original twelve tools, readable text, output schemas and `structuredContent`.
AI clients can instead use **`/mcp/compact`**, or stdio `node build/index.js --compact` (`MCP_PROFILE=compact`).
Compact discovery omits verbose output schemas, but successful outputs are still validated internally. Results
contain one JSON text block, optional top-level `fields`, and provenance/time/units/safety information that selectors
cannot remove. `detail: "full"` includes optional API-key setup help. Field selection for other tools reduces result
size after retrieval; it does not claim to reduce their provider calls. These profiles share the same backend.
Protocol-byte savings do not imply identical model-token savings: some clients already hide schemas/duplicates.

The central HTTP client reuses fresh responses and conditionally revalidates known ETag/Last-Modified bodies. A304
or redirect still spends a network attempt; no HEAD+GET polling is used. It honors no-store/private/cache expiry,
limits same-origin HTTPS redirects and uses one deadline across queue, redirects and response decoding.

`WEATHER_QUOTAS_JSON` overrides application safety ceilings by provider ID (`open-meteo`, `openweathermap`,
`weatherapi`, `tomorrow-io`, or another provider's DNS hostname), for example:

```bash
WEATHER_QUOTAS_JSON='{"tomorrow-io":{"minute":5,"hour":10,"day":100,"month":2500}}'
```

Defaults:30/minute,200/hour,1000/UTC-day,10000/UTC-calendar-month per provider/account; Tomorrow.io defaults
10/minute,20/hour,200/day,5000/month. Open-Meteo and Syke allow60/minute (other default windows unchanged) to
accommodate cold catalog/geocoding work. Minute/hour windows roll. These are **self-imposed ceilings, not provider plan
entitlements**. Lower them for actual account limits, rolling-day limits and other consumers. Open-Meteo reservations conservatively round up variable/duration/model/location weighting to whole budget units
([provider calculation](https://open-meteo.com/en/pricing)); other providers count attempts. These counters are not
a billing reconciliation. Each reserved dispatch
is persisted before network access, including failures/304/redirects; Retry-After and failure circuits survive restart.
No allowance is shared automatically across hosts/volumes: partition a shared account's budget between installations.
`get_weather_source_status` exposes local remaining hour/day ceilings without credentials or account fingerprints.

Keep `MCP_STATE_DIR` across upgrades (native default `~/.cache/mcp-weather`; Docker `/var/lib/mcp-weather` on
`weather-state`). Files are private. Corrupt/unwritable state fails closed rather than resetting quota. An interrupted
transaction can leave `quota.lock`: inspect it and confirm no active owner before removing only the stale lock;
never clear `quota.json` to regain allowance. Do not run several cache writers against one dataset file. Cache
persistence is best-effort; quota persistence is mandatory before dispatch. Back up state alongside configuration.

Default weather limits are200 entries/16MiB, metadata128 entries/8MiB; see `.env.example` for all tunables. No Redis,
external cache service or additional runtime dependency is required.

## Architecture

```
src/
  index.ts              # entry point: stdio or --http
  server.ts             # tool registration and the Streamable HTTP server
  version.ts            # version (serverInfo and the User-Agent sent to providers)
  keys.ts               # optional API keys: what is missing and how to set it
  config.ts             # Environment variable loading
  cache.ts              # LRU cache with stampede prevention
  types.ts              # Shared TypeScript interfaces
  tools/
    current-weather.ts  # get_current_weather
    forecast.ts         # get_weather_forecast
    nowcast.ts          # get_precipitation_nowcast
    warnings.ts         # get_weather_warnings
    marine.ts           # get_marine_conditions
    lake.ts             # get_lake_conditions
    road-weather.ts     # get_road_weather
    aurora.ts           # get_aurora_forecast
    air-quality.ts      # get_air_quality
    metar.ts            # get_metar
    astronomy.ts        # get_astronomy
    source-status.ts    # get_weather_source_status
  sources/
    open-meteo.ts       # Open-Meteo (current, forecast incl. MET Nordic model, AQI, pollen, cloud cover)
    met-norway.ts       # MET Norway client (User-Agent, 4 decimals, Expires, If-Modified-Since)
    warnings.ts         # FMI CAP, SMHI, MET Norway MetAlerts, MeteoAlarm
    space-weather.ts    # FMI R-index, NOAA Kp
    national-obs.ts     # station observations: SMHI, DMI, IMO, LHMT, Estonia; MET Nordic analysis
    marine.ts           # sea level, water temperature, waves: FMI, SMHI, DMI, Kartverket; wave models
    road-weather.ts     # Fintraffic Digitraffic road weather stations and road condition forecast
    syke.ts             # Syke hydrology: lake and river water levels, water temperature, ice
    wttr-in.ts          # wttr.in (current)
    openweathermap.ts   # OpenWeatherMap (current)
    weatherapi.ts       # WeatherAPI (current)
    tomorrow-io.ts      # Tomorrow.io (current)
    metar.ts            # aviationweather.gov (METAR)
    fmi.ts              # Finnish Meteorological Institute open data (station observations)
    fmi-forecast.ts     # FMI meteorologist-edited forecast (daily values for Finland)
    fmi-airquality.ts   # FMI / municipal air quality stations (measured hourly averages)
  utils/
    aggregator.ts       # Multi-source data merging
    finnish-locations.ts # Finnish/Nordic city alias map
    finnish-airports.ts # Finnish airport reference points (FMI station lookup)
    suncalc.ts          # Local sun and moon calculations
    location.ts         # Location resolution (alias -> geocode -> coords)
    units.ts            # Unit conversions and WMO weather codes
    region.ts           # Nordic/Baltic country of a point, time zones
    http.ts             # GET with timeout and identifying User-Agent
  data/
    nordic-borders.ts   # simplified Natural Earth country outlines (public domain)
```

## Tests

```bash
npm run build && npm test                                 # offline unit tests (recorded responses of every provider in test/fixtures)
npm run test:live -- "node build/index.js"                # live acceptance test over stdio, real network
npm run test:live -- http://localhost:3015/mcp            # ... or against the Docker endpoint
```

The unit tests also run the tools through a real MCP client (structuredContent is validated against each tool's
`outputSchema`) and exercise the HTTP server on a local port.

The live test checks the answers against the real sources (e.g. the FMI value against the FMI API directly), so it
needs network access; with API keys in the environment it also covers the optional sources.

## Transport

Two transports from the same server:

- **stdio** (default) for local MCP clients such as desktop apps, IDE extensions and command-line agents.
- **Streamable HTTP** with `--http` (or `MCP_TRANSPORT=http`): the SDK's own transport in stateless JSON mode. Clients POST to `/mcp`; `GET /health` answers `ok`. Responses are always JSON (no Server-Sent Events), so clients that accept only `application/json` work too. One process serves every client, so all of them share the cache. The Docker image runs this mode as a non-root user on port 3000 (mapped to 3015 in docker-compose).

Every tool returns readable text and the same data as `structuredContent` that matches the tool's `outputSchema`; failures set `isError`. All tools are annotated read-only.

The Streamable HTTP endpoint has no authentication of its own: run it on a trusted network or behind a reverse proxy
that adds authentication. Browser requests from other origins are rejected (403) to prevent DNS rebinding; allow
specific origins with `ALLOWED_ORIGINS`.

## Contributing

Issues and pull requests are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md) and the
[Code of Conduct](CODE_OF_CONDUCT.md). Changes are listed in [CHANGELOG.md](CHANGELOG.md). Please report security
problems privately as described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
