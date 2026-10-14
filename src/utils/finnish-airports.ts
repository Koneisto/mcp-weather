/**
 * Finnish airports (ICAO → aerodrome reference point). Used to find the airport's FMI weather station
 * when METAR is unavailable. FMI open data covers Finland only, so only EF** codes are listed.
 */
export const finnishAirports: Record<string, { name: string; lat: number; lon: number }> = {
  EFET: { name: 'Enontekiö', lat: 68.3626, lon: 23.4243 },
  EFHA: { name: 'Halli', lat: 61.8560, lon: 24.7867 },
  EFHK: { name: 'Helsinki-Vantaa', lat: 60.3172, lon: 24.9633 },
  EFIV: { name: 'Ivalo', lat: 68.6073, lon: 27.4053 },
  EFJO: { name: 'Joensuu', lat: 62.6629, lon: 29.6075 },
  EFJY: { name: 'Jyväskylä', lat: 62.3995, lon: 25.6783 },
  EFKA: { name: 'Kauhava', lat: 63.1271, lon: 23.0514 },
  EFKE: { name: 'Kemi-Tornio', lat: 65.7787, lon: 24.5821 },
  EFKI: { name: 'Kajaani', lat: 64.2855, lon: 27.6924 },
  EFKK: { name: 'Kokkola-Pietarsaari', lat: 63.7212, lon: 23.1431 },
  EFKS: { name: 'Kuusamo', lat: 65.9876, lon: 29.2394 },
  EFKT: { name: 'Kittilä', lat: 67.7010, lon: 24.8468 },
  EFKU: { name: 'Kuopio', lat: 63.0071, lon: 27.7978 },
  EFLP: { name: 'Lappeenranta', lat: 61.0446, lon: 28.1444 },
  EFMA: { name: 'Mariehamn', lat: 60.1222, lon: 19.8982 },
  EFMI: { name: 'Mikkeli', lat: 61.6866, lon: 27.2018 },
  EFOU: { name: 'Oulu', lat: 64.9301, lon: 25.3546 },
  EFPO: { name: 'Pori', lat: 61.4617, lon: 21.7999 },
  EFRO: { name: 'Rovaniemi', lat: 66.5648, lon: 25.8304 },
  EFSA: { name: 'Savonlinna', lat: 61.9431, lon: 28.9451 },
  EFSI: { name: 'Seinäjoki', lat: 62.6921, lon: 22.8323 },
  EFSO: { name: 'Sodankylä', lat: 67.3950, lon: 26.6191 },
  EFTP: { name: 'Tampere-Pirkkala', lat: 61.4141, lon: 23.6044 },
  EFTU: { name: 'Turku', lat: 60.5141, lon: 22.2628 },
  EFUT: { name: 'Utti', lat: 60.8964, lon: 26.9384 },
  EFVA: { name: 'Vaasa', lat: 63.0507, lon: 21.7622 },
  EFVR: { name: 'Varkaus', lat: 62.1711, lon: 27.8686 },
};
