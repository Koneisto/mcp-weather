# 🇪🇺🇫🇮 mcp-weather

A [Model Context Protocol](https://modelcontextprotocol.io/) (MCP) server that aggregates weather data from 6 sources, optimized for European and Nordic/Baltic locations. Works out of the box with zero API keys -- add optional keys to unlock more sources.

## Features

- **6 weather sources** -- Open-Meteo, wttr.in, METAR, OpenWeatherMap, WeatherAPI, Tomorrow.io
- **6 MCP tools** -- current weather, forecast, air quality, aviation METAR, astronomy, source status
- **Nordic/Finnish focus** -- 30+ Finnish cities with instant alias resolution (e.g. `hki`, `tre`, `stadi`), Nordic/Baltic capitals included
- **Multi-source aggregation** -- merges data from all available sources for more complete and accurate results
- **Zero-config start** -- 3 sources work without any API keys (Open-Meteo, wttr.in, METAR)
- **Smart caching** -- LRU cache with stampede prevention, configurable TTL

## MCP Tools

| Tool | Description |
|------|-------------|
| `get_current_weather` | Current conditions from up to 5 sources, merged into one result |
| `get_weather_forecast` | 1-7 day daily forecast (temperature, precipitation, wind, UV) |
| `get_air_quality` | European AQI with PM2.5, PM10, NO2, O3, SO2, CO levels |
| `get_metar` | Aviation weather (raw + decoded) from aviationweather.gov |
| `get_astronomy` | Sunrise, sunset, day length, moon phase and illumination |
| `get_weather_source_status` | Health check for all sources + cache statistics |

## Location Input

The server accepts multiple location formats:

| Format | Example | Notes |
|--------|---------|-------|
| Finnish alias | `hki`, `tre`, `stadi`, `turku` | 30+ cities with ICAO codes |
| Nordic capital | `stockholm`, `oslo`, `tallinn` | Finnish names work too (`tukholma`) |
| City name | `London`, `Berlin`, `Tokyo` | Geocoded via Open-Meteo |
| Coordinates | `60.17,24.94` | Latitude, longitude |
| ICAO code | `EFHK`, `ESSA` | For METAR tool |

## Quick Start

### Docker (recommended)

```bash
git clone https://github.com/Koneisto/mcp-weather.git
cd mcp-weather
cp .env.example .env          # optionally add API keys
npm install && npm run build  # build TypeScript
docker compose up -d
```

The server will be available at `http://localhost:3015` via [supergateway](https://github.com/nichochar/supergateway) (Streamable HTTP transport).

### Local Development

```bash
git clone https://github.com/Koneisto/mcp-weather.git
cd mcp-weather
npm install
npm run build
node build/index.js           # runs on stdio transport
```

### Claude Desktop / Claude Code

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

### Sources by API Key Requirement

| Source | Requires Key | Data Provided |
|--------|-------------|---------------|
| Open-Meteo | No | Current, forecast, air quality |
| wttr.in | No | Current conditions |
| METAR | No | Aviation weather |
| OpenWeatherMap | Yes | Current conditions |
| WeatherAPI | Yes | Current conditions, astronomy (moon) |
| Tomorrow.io | Yes | Current conditions, air quality |

## Architecture

```
src/
  index.ts              # MCP server entry point (stdio transport)
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
    weatherapi.ts       # WeatherAPI (current, astronomy)
    tomorrow-io.ts      # Tomorrow.io (current, AQI)
    metar.ts            # aviationweather.gov (METAR)
  utils/
    aggregator.ts       # Multi-source data merging
    finnish-locations.ts # Finnish/Nordic city alias map
    location.ts         # Location resolution (alias -> geocode -> coords)
    units.ts            # Unit conversions and WMO weather codes
```

## Transport

The server uses **stdio** transport natively. The Docker setup wraps it with [supergateway](https://github.com/nichochar/supergateway) to expose it as a **Streamable HTTP** endpoint on port 3000 (mapped to 3015 in docker-compose).

## License

[MIT](LICENSE)
