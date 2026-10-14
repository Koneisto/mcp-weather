interface LocationEntry {
  lat: number;
  lon: number;
  icao?: string;
  displayName: string;
}

const locations: Array<[string[], LocationEntry]> = [
  // Finnish cities
  [['helsinki', 'helsingfors', 'hki', 'stadi'], { lat: 60.17, lon: 24.94, icao: 'EFHK', displayName: 'Helsinki' }],
  [['espoo', 'esbo'], { lat: 60.21, lon: 24.66, displayName: 'Espoo' }],
  [['vantaa', 'vanda'], { lat: 60.29, lon: 25.04, icao: 'EFHK', displayName: 'Vantaa' }],
  [['tampere', 'tammerfors', 'tre', 'mansen'], { lat: 61.50, lon: 23.79, icao: 'EFTP', displayName: 'Tampere' }],
  [['turku', 'åbo', 'tku'], { lat: 60.45, lon: 22.27, icao: 'EFTU', displayName: 'Turku' }],
  [['oulu', 'uleåborg'], { lat: 65.01, lon: 25.47, icao: 'EFOU', displayName: 'Oulu' }],
  [['jyväskylä', 'jyvaskyla', 'jkl'], { lat: 62.24, lon: 25.75, icao: 'EFJY', displayName: 'Jyväskylä' }],
  [['kuopio', 'kuo'], { lat: 62.89, lon: 27.68, icao: 'EFKU', displayName: 'Kuopio' }],
  [['lahti', 'lahtis'], { lat: 60.98, lon: 25.66, displayName: 'Lahti' }],
  [['pori', 'björneborg'], { lat: 61.49, lon: 21.80, icao: 'EFPO', displayName: 'Pori' }],
  [['joensuu'], { lat: 62.60, lon: 29.76, icao: 'EFJO', displayName: 'Joensuu' }],
  [['lappeenranta', 'villmanstrand', 'lpr'], { lat: 61.06, lon: 28.19, icao: 'EFLP', displayName: 'Lappeenranta' }],
  [['vaasa', 'vasa'], { lat: 63.10, lon: 21.62, icao: 'EFVA', displayName: 'Vaasa' }],
  [['kotka'], { lat: 60.47, lon: 26.94, displayName: 'Kotka' }],
  [['rovaniemi', 'roi'], { lat: 66.50, lon: 25.72, icao: 'EFRO', displayName: 'Rovaniemi' }],
  [['seinäjoki', 'seinajoki'], { lat: 62.79, lon: 22.84, displayName: 'Seinäjoki' }],
  [['mikkeli', 'st michel'], { lat: 61.69, lon: 27.27, icao: 'EFMI', displayName: 'Mikkeli' }],
  [['kouvola'], { lat: 60.87, lon: 26.70, displayName: 'Kouvola' }],
  [['hämeenlinna', 'hameenlinna', 'tavastehus'], { lat: 60.99, lon: 24.46, displayName: 'Hämeenlinna' }],
  [['kajaani', 'kajana'], { lat: 64.23, lon: 27.73, icao: 'EFKI', displayName: 'Kajaani' }],
  [['kokkola', 'karleby'], { lat: 63.84, lon: 23.13, displayName: 'Kokkola' }],
  [['rauma', 'raumo'], { lat: 61.13, lon: 21.51, displayName: 'Rauma' }],
  [['savonlinna', 'nyslott'], { lat: 61.87, lon: 28.88, icao: 'EFSA', displayName: 'Savonlinna' }],
  [['sodankylä', 'sodankyla'], { lat: 67.42, lon: 26.59, icao: 'EFSO', displayName: 'Sodankylä' }],
  [['ivalo'], { lat: 68.66, lon: 27.55, icao: 'EFIV', displayName: 'Ivalo' }],
  [['enontekiö', 'enontekio', 'hetta'], { lat: 68.41, lon: 23.64, icao: 'EFET', displayName: 'Enontekiö' }],
  [['inari'], { lat: 69.07, lon: 27.03, displayName: 'Inari' }],
  [['utsjoki'], { lat: 69.91, lon: 27.03, displayName: 'Utsjoki' }],
  [['kilpisjärvi', 'kilpisjarvi'], { lat: 69.05, lon: 20.79, displayName: 'Kilpisjärvi' }],

  // Nordic capitals
  [['stockholm', 'tukholma'], { lat: 59.33, lon: 18.07, icao: 'ESSA', displayName: 'Stockholm' }],
  [['oslo'], { lat: 59.91, lon: 10.75, icao: 'ENGM', displayName: 'Oslo' }],
  [['copenhagen', 'köpenhamn', 'kööpenhamina'], { lat: 55.68, lon: 12.57, icao: 'EKCH', displayName: 'Copenhagen' }],
  [['reykjavik'], { lat: 64.13, lon: -21.90, icao: 'BIRK', displayName: 'Reykjavik' }],
  [['tallinn', 'tallinna'], { lat: 59.44, lon: 24.75, icao: 'EETN', displayName: 'Tallinn' }],
  [['riga', 'riika'], { lat: 56.95, lon: 24.11, icao: 'EVRA', displayName: 'Riga' }],
];

const finnishMap = new Map<string, LocationEntry>();
for (const [aliases, entry] of locations) {
  for (const alias of aliases) {
    finnishMap.set(alias.toLowerCase(), entry);
  }
}

export function lookupFinnishLocation(input: string): LocationEntry | undefined {
  return finnishMap.get(input.toLowerCase().trim());
}

export { type LocationEntry };
