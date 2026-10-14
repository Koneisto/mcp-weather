# 🇪🇺🇫🇮 mcp-weather

[![CI](https://github.com/Koneisto/mcp-weather/actions/workflows/ci.yml/badge.svg)](https://github.com/Koneisto/mcp-weather/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/Koneisto/mcp-weather)](https://github.com/Koneisto/mcp-weather/releases/latest)
[![License: MIT](https://img.shields.io/github/license/Koneisto/mcp-weather)](LICENSE)
![Node.js](https://img.shields.io/badge/node-%3E%3D22-brightgreen)

A [Model Context Protocol](https://modelcontextprotocol.io/) (MCP) server that aggregates weather data from 7 sources, optimized for European and Nordic/Baltic locations. In Finland it uses measured data: weather and air quality from the nearest Finnish Meteorological Institute (FMI) and municipal stations, with models filling the gaps. Works out of the box with zero API keys -- add optional keys to unlock more sources.

## Features

- **7 weather sources** -- Finnish Meteorological Institute (FMI), Open-Meteo, wttr.in, METAR, OpenWeatherMap, WeatherAPI, Tomorrow.io
- **Measured data in Finland** -- current weather uses the 10-minute observation of the nearest FMI weather station within 15 km first, air quality the nearest air quality station within 10 km; models fill in what the station does not measure, and farther away the model for the exact point is used (the nearest weather station within 50 km is shown for reference)
- **6 MCP tools** -- current weather, forecast, air quality, aviation METAR, astronomy, source status
- **Nordic/Finnish focus** -- 30+ Finnish cities with instant alias resolution (e.g. `hki`, `tre`, `stadi`), Nordic/Baltic capitals included
- **Multi-source aggregation** -- merges data from all available sources for more complete and accurate results
- **Zero-config start** -- 4 sources work without any API keys (FMI, Open-Meteo, wttr.in, METAR)
- **Smart caching** -- LRU cache with stampede prevention, configurable TTL

## MCP Tools

| Tool | Description |
|------|-------------|
| `get_current_weather` | Current conditions from up to 6 sources, merged into one result; in Finland the nearest FMI station's measurement comes first |
| `get_weather_forecast` | 1-7 day daily forecast (temperature, precipitation, wind, UV) |
| `get_air_quality` | European AQI with PM2.5, PM10, NO2, O3, SO2, CO levels; in Finland measured at the nearest air quality station (within 10 km) |
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

Requires Node.js 22 or later (the Docker image builds from the compiled `build/` directory, so Docker also needs
Node.js on the host for `npm run build`).

### Docker (recommended)

```bash
git clone https://github.com/Koneisto/mcp-weather.git
cd mcp-weather
cp .env.example .env          # optionally add API keys
npm ci && npm run build       # build TypeScript
docker network create mcp-network   # once; docker-compose.yml expects this network
docker compose up -d
```

The server will be available at `http://localhost:3015/mcp` (Streamable HTTP), with a health check at `http://localhost:3015/health`.

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
| `HTTP_TIMEOUT_MS` | `10000` | HTTP request timeout in milliseconds |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | Listen address in HTTP mode |
| `MCP_TRANSPORT` | *(stdio)* | `http` = same as `--http` |

### Sources by API Key Requirement

| Source | Requires Key | Data Provided |
|--------|-------------|---------------|
| FMI (Finnish Meteorological Institute) | No | Measured current conditions and air quality in Finland, METAR fallback for Finnish airports |
| Open-Meteo | No | Current, forecast, air quality |
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

- **Current weather:** sources are merged field by field in a fixed order. In Finland the FMI station measurement
  comes first, so measured values win and the models only fill fields the station does not measure. The output names
  the station, its distance and the observation time.
- **Air quality:** each pollutant is labelled *measured* or *model*, and the European AQI is computed from the values
  shown (EEA concentration bands, the highest sub-index), so the index always agrees with them.
- **Locations:** Finnish aliases and ICAO codes resolve locally; other names are geocoded in seven languages
  (en, fi, sv, de, fr, it, es), so both `Roma` and `Lontoo` work.

### Data sources and licences

Outputs name the sources they used. FMI data (including the municipal air quality networks it distributes) and
Open-Meteo data are licensed under CC BY 4.0; METAR comes from the US NOAA Aviation Weather Center
(aviationweather.gov). The free Open-Meteo API is for non-commercial use; see
[Open-Meteo's terms](https://open-meteo.com/en/terms) for commercial use. wttr.in and the optional sources
(OpenWeatherMap, WeatherAPI, Tomorrow.io) are subject to their providers' terms. Keys for the optional sources are
read from the environment and are never written to output.

## Architecture

```
src/
  index.ts              # entry point: stdio or --http
  server.ts             # tool registration and the Streamable HTTP server
  config.ts             # Environment variable loading
  cache.ts              # LRU cache with stampede prevention
  types.ts              # Shared TypeScript interfaces
  tools/
    current-weather.ts  # get_current_weather
    forecast.ts         # get_weather_forecast
    air-quality.ts      # get_air_quality
    metar.ts            # get_metar
    astronomy.ts        # get_astronomy
    source-status.ts    # get_weather_source_status
  sources/
    open-meteo.ts       # Open-Meteo (current, forecast, AQI)
    wttr-in.ts          # wttr.in (current)
    openweathermap.ts   # OpenWeatherMap (current)
    weatherapi.ts       # WeatherAPI (current)
    tomorrow-io.ts      # Tomorrow.io (current)
    metar.ts            # aviationweather.gov (METAR)
    fmi.ts              # Finnish Meteorological Institute open data (station observations)
    fmi-airquality.ts   # FMI / municipal air quality stations (measured hourly averages)
  utils/
    aggregator.ts       # Multi-source data merging
    finnish-locations.ts # Finnish/Nordic city alias map
    finnish-airports.ts # Finnish airport reference points (FMI station lookup)
    suncalc.ts          # Local sun and moon calculations
    location.ts         # Location resolution (alias -> geocode -> coords)
    units.ts            # Unit conversions and WMO weather codes
```

## Tests

```bash
npm run build && npm test                                 # offline unit tests (recorded FMI responses in test/fixtures)
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
- **Streamable HTTP** with `--http` (or `MCP_TRANSPORT=http`): the SDK's own transport in stateless JSON mode. Clients POST to `/mcp`; `GET /health` answers `ok`. One process serves every client, so all of them share the cache. The Docker image runs this mode as a non-root user on port 3000 (mapped to 3015 in docker-compose).

Every tool returns readable text and the same data as `structuredContent` that matches the tool's `outputSchema`; failures set `isError`. All tools are annotated read-only.

The Streamable HTTP endpoint has no authentication of its own: run it on a trusted network or behind a reverse proxy
that adds authentication.

## Contributing

Issues and pull requests are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md) and the
[Code of Conduct](CODE_OF_CONDUCT.md). Changes are listed in [CHANGELOG.md](CHANGELOG.md). Please report security
problems privately as described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
