# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.3.1] - 2026-10-15

### Fixed

- When aviationweather.gov does not answer, an upper-case airport code (e.g. `ESSA`) is reported as not resolvable instead
  of being geocoded to an unrelated place with the same name (Essa, Congo). Mixed-case place names still geocode.

## [1.3.0] - 2026-10-15

### Added

- `get_lake_conditions` (Finland, Syke): daily water level of lakes and rivers with the height above sea level (N2000),
  the change in a week and the normal for the date (mean, lowest and highest of the previous 30 years), surface water
  temperature against its normal, and ice thickness with snow on the ice in winter. By lake name (a lake includes the
  basins Syke files under it, so `Saimaa` also covers Haukivesi, Pihlajavesi and Orivesi-Pyhäselkä) or by place.
- Snow depth measured at the FMI station in `get_current_weather` (shown when there is snow).

## [1.2.0] - 2026-10-15

### Added

- `get_marine_conditions`: measured sea level against each country's reference (FMI theoretical mean sea level, SMHI
  RH 2000, DMI DVR90, Kartverket mean sea level) with the forecast high and low in Finland (FMI) and Norway
  (Kartverket, tide plus weather effect), water temperature (FMI, SMHI, DMI), wave buoys (FMI, SMHI) and a wave model
  anywhere at sea (MET Norway Oceanforecast in Norway, Open-Meteo Marine elsewhere).
- `get_road_weather` (Finland): the nearest Fintraffic road weather station with road surface temperature and state,
  friction, slipperiness warning, precipitation, visibility and wind, a frost-risk flag, and Fintraffic's road
  condition forecast for the next 12 hours with the roads and reasons behind poor conditions.
- Station observations for current weather from the national weather services: SMHI (Sweden), DMI (Denmark), the
  Icelandic Met Office, LHMT (Lithuania) and the Estonian Environment Agency, alongside FMI; in Norway the MET Nordic
  analysis (observations and radar on a 1 km grid).

### Changed

- `get_weather_forecast` in Finland uses FMI's meteorologist-edited forecast for the full days it covers (today and UV,
  sunrise and sunset stay with the MET Nordic model); each day names its source.
- `get_current_weather` names the provider with the station ("Measured at: Stockholm-Observatoriekullen A (SMHI, …)"),
  uses the MET Nordic analysis between stations in Finland, Sweden and Denmark, and returns an `attribution` list.

## [1.1.0] - 2026-10-15

### Added

- `get_weather_warnings`: official weather warnings in Finland (FMI CAP, matched to the location by warning polygons),
  Sweden (SMHI impact-based warnings, GeoJSON areas), Norway (MET Norway MetAlerts by coordinates) and Denmark, Iceland,
  Estonia, Latvia and Lithuania (MeteoAlarm, per country with area names). English, Finnish, Swedish or Norwegian text.
- `get_precipitation_nowcast`: radar-based precipitation for the next 2 hours in 5-minute steps (MET Norway Nowcast 2.0).
- `get_aurora_forecast`: northern lights chance hour by hour from the Kp needed at the latitude, the NOAA Kp forecast,
  the FMI R-index measured now (Finland), darkness (sun below -12°) and cloud cover.
- Pollen (alder, birch, grass, mugwort, ragweed) with levels in `get_air_quality` (CAMS via Open-Meteo, Europe).
- Country of a point for the Nordic and Baltic countries from simplified Natural Earth outlines (coastal points count).

### Changed

- In the Nordic and Baltic countries `get_weather_forecast` uses MET Norway's MET Nordic model (Open-Meteo
  `metno_seamless`); the source is named in the output.
- Every provider gets an identifying User-Agent; MET Norway requests follow its terms (4 decimals, Expires,
  If-Modified-Since).

## [1.0.2] - 2026-10-15

### Added

- Missing optional API keys are explained: server instructions name them, the first successful answer of a process
  carries a one-time note (`MCP_WEATHER_KEY_NOTE=off` silences it), and `get_weather_source_status` lists each missing
  key with a free sign-up link and how to set it (also as `structuredContent.apiKeys`).

### Changed

- Streamable HTTP serves clients that accept only `application/json`; the server never sends Server-Sent Events.

### Security

- Streamable HTTP validates the `Origin` header (MCP specification, DNS rebinding protection): requests without an
  origin and from localhost are allowed, other browser origins only via `ALLOWED_ORIGINS`, the rest get 403.

## [1.0.1] - 2026-10-14

### Security

- Container image: the runtime stage no longer contains npm, npx or corepack (their bundled dependencies were the only
  JavaScript findings in an image scan), and Alpine packages are upgraded at build time (OpenSSL, zlib).

### Changed

- The Dockerfile is a self-contained multi-stage build: TypeScript is compiled inside the image, so a plain
  `docker build .` works from a fresh clone.
- CI builds the container image, fails on fixable high or critical vulnerabilities (Trivy) and smoke-tests `/health`.
- Dependabot also keeps the Docker base image up to date.

## [1.0.0] - 2026-10-14

First public release.

### Added

- Six MCP tools: `get_current_weather`, `get_weather_forecast`, `get_air_quality`, `get_metar`, `get_astronomy` and
  `get_weather_source_status`.
- Seven weather sources. FMI, Open-Meteo, wttr.in and METAR work without API keys; OpenWeatherMap, WeatherAPI and
  Tomorrow.io are optional and need a key.
- Measured weather in Finland: current weather comes from FMI station observations (stations within 15 km) before any
  model or commercial source. The nearest station within 50 km is shown for reference when none is close enough.
- Measured air quality in Finland: PM2.5, PM10, NO2 and O3 from municipal and background stations within 10 km,
  completed with model values. Every value is marked measured or model, and the index uses the European AQI scale
  (EEA bands).
- METAR with a fallback: for Finnish airfields (EF**) an FMI observation from the airport station is returned when no
  METAR is available, clearly labelled as not being a METAR.
- Locations: Finnish aliases, Nordic and Baltic capitals, coordinates and ICAO codes. Geocoding runs in seven languages
  and picks the best exact match, so `Roma` is Italy and `Lontoo` is London.
- Local astronomy (suncalc): sunrise, sunset, twilight, day length, moon phase, midnight sun and polar night for the
  local solar day. Invalid dates and time zones are rejected.
- MCP interface: tools registered with titles, read-only annotations, output schemas and `structuredContent`;
  failures are returned with `isError`.
- Two transports: stdio, and native stateless Streamable HTTP (`--http`) serving `POST /mcp` and `GET /health` from one
  process with a shared cache.
- LRU cache with stampede prevention. A Tomorrow.io rate limit (429) pauses that source for 15 minutes.
- Finnish number formatting and 24-hour time in all output.
- Docker image running as a non-root user with a healthcheck; docker-compose with a memory limit.
- 30 offline tests (`npm test`) and a live acceptance test against a running server
  (`npm run test:live -- <stdio command | http://host:port/mcp>`).

[Unreleased]: https://github.com/Koneisto/mcp-weather/compare/v1.3.1...HEAD
[1.3.1]: https://github.com/Koneisto/mcp-weather/compare/v1.3.0...v1.3.1
[1.3.0]: https://github.com/Koneisto/mcp-weather/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/Koneisto/mcp-weather/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/Koneisto/mcp-weather/compare/v1.0.2...v1.1.0
[1.0.2]: https://github.com/Koneisto/mcp-weather/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/Koneisto/mcp-weather/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/Koneisto/mcp-weather/releases/tag/v1.0.0
