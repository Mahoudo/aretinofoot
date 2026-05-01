/**
 * betclic-proxy.js — Proxy local Betclic.ci pour Aretinofoot
 * Lance avec: node betclic-proxy.js
 * Écoute sur: http://localhost:5502
 *
 * Endpoints:
 *   GET /betclic?league=angl-premier-league-c3   → cotes PL
 *   GET /betclic?league=espa-primera-division-c4  → cotes La Liga
 *   GET /betclic/all                              → toutes les compétitions mappées
 *   GET /betclic/leagues                          → liste des compétitions dispo
 */
const http  = require('http');
const https = require('https');
const url   = require('url');

const PORT = process.env.PORT || 5502;

// Betclic CI → league slugs (URL path after /football-sfootball/)
const LEAGUE_SLUGS = {
  'PL':  'angl-premier-league-c3',
  'LL':  'espa-primera-division-c4',
  'SA':  'ital-serie-a-c5',
  'BL':  'alle-bundesliga-c6',
  'L1':  'fran-ligue-1-c7',
  'UCL': 'euro-uefa-champions-league-c23',
  'EL':  'euro-ligue-europa-c24',
  'PPL': 'port-primeira-liga-c17',
};

// Fetch a URL via HTTPS, follow redirects, return text
function fetchPage(targetUrl) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'fr-FR,fr;q=0.9',
        'Cache-Control': 'no-cache',
      }
    };
    https.get(targetUrl, options, res => {
      // Follow redirect
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchPage(res.headers.location).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

// Parse all 1X2 markets + event metadata from Betclic HTML
function parseOdds(html) {
  const results = [];

  // 1) Extract event metadata (name, date, ranking, formResults, logo)
  const eventRe = /"name":"([A-ZÀ-ɏ][^"]+ - [A-ZÀ-ɏ][^"]+)","matchDateUtc":"([^"]+)","isLive":(true|false)[^}]{0,3000}?"contestants":\[(\{[^[]{0,2000}\})\]/g;
  const eventsMap = {};
  let em;
  while ((em = eventRe.exec(html)) !== null) {
    const name    = em[1];
    const dateUtc = em[2];
    const isLive  = em[3] === 'true';
    const contRaw = em[4];

    // Parse first contestant (home)
    const contMatch = contRaw.match(/"contestantId":"(\d+)","name":"([^"]+)"[^}]*"ranking":"([^"]*)"[^}]*"formResults":\[([^\]]*)\]/);
    const homeId    = contMatch ? contMatch[1] : null;
    const homeName  = contMatch ? contMatch[2] : name.split(' - ')[0];
    const homeRank  = contMatch ? contMatch[3] : '';
    const homeForm  = contMatch ? contMatch[4].split(',').map(Number) : [];

    // Date → local time
    const dt      = new Date(dateUtc);
    const timeStr = dt.getHours().toString().padStart(2,'0') + ':' + dt.getMinutes().toString().padStart(2,'0');
    const dateStr = dt.toISOString().split('T')[0];

    eventsMap[name] = { name, dateUtc, timeStr, dateStr, isLive, homeId, homeName, homeRank, homeForm };
  }

  // 2) Extract 1X2 odds triplets
  const oddsRe = /\{"id":"(\d+)","isLive":(true|false),"keys":\["contestant:(\d+)","contestant:(\d+)"\],"name":"([^"]+)","betslipName":"[^"]+","odds":([\d.]+)/g;
  const raw = [];
  let om;
  while ((om = oddsRe.exec(html)) !== null) {
    raw.push({
      id: om[1], isLive: om[2]==='true',
      keyA: om[3], keyB: om[4],
      name: om[5], odds: parseFloat(om[6])
    });
  }

  // Group into triplets (H / Nul / A)
  let i = 0;
  while (i < raw.length) {
    const trio = raw.slice(i, i+3);
    if (trio.length === 3 && (trio[1].name === 'Nul' || trio[1].name === 'X')) {
      const home = trio[0].name;
      const away = trio[2].name;
      const matchKey = Object.keys(eventsMap).find(k =>
        k.includes(home) && k.includes(away)
      );
      const meta = eventsMap[matchKey] || {};

      results.push({
        home,
        away,
        oddH: trio[0].odds,
        oddD: trio[1].odds,
        oddA: trio[2].odds,
        isLive: trio[0].isLive,
        time: meta.timeStr || '?',
        date: meta.dateStr || new Date().toISOString().split('T')[0],
        homeRank: meta.homeRank || '',
        homeForm: meta.homeForm || [],
        marketId: trio[0].id,
        source: 'betclic.ci',
      });
      i += 3;
    } else {
      i++;
    }
  }
  return results;
}

// Handle HTTP requests
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const parsed   = url.parse(req.url, true);
  const pathname = parsed.pathname;
  const query    = parsed.query;

  try {
    // GET /betclic/leagues → list supported leagues
    if (pathname === '/betclic/leagues') {
      res.writeHead(200);
      res.end(JSON.stringify({ leagues: LEAGUE_SLUGS }));
      return;
    }

    // GET /betclic/all → fetch all mapped leagues
    if (pathname === '/betclic/all') {
      const allMatches = [];
      for (const [ls, slug] of Object.entries(LEAGUE_SLUGS)) {
        try {
          const pageUrl = `https://www.betclic.ci/football-sfootball/${slug}`;
          console.log(`Fetching ${ls}: ${pageUrl}`);
          const html    = await fetchPage(pageUrl);
          const matches = parseOdds(html);
          matches.forEach(m => { m.ls = ls; });
          allMatches.push(...matches);
          console.log(`  → ${matches.length} matches`);
        } catch(e) {
          console.warn(`  ! Error fetching ${ls}:`, e.message);
        }
      }
      res.writeHead(200);
      res.end(JSON.stringify(allMatches));
      return;
    }

    // GET /betclic?league=slug  OR  /betclic?ls=PL
    if (pathname === '/betclic') {
      let slug = query.league;
      if (!slug && query.ls) slug = LEAGUE_SLUGS[query.ls.toUpperCase()];
      if (!slug) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Missing ?league= or ?ls= param', available: LEAGUE_SLUGS }));
        return;
      }
      const pageUrl = `https://www.betclic.ci/football-sfootball/${slug}`;
      console.log(`Fetching: ${pageUrl}`);
      const html    = await fetchPage(pageUrl);
      const matches = parseOdds(html);
      console.log(`  → ${matches.length} matches parsed`);
      res.writeHead(200);
      res.end(JSON.stringify(matches));
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Not found. Use /betclic?ls=PL or /betclic/all' }));

  } catch(err) {
    console.error('Proxy error:', err);
    res.writeHead(500);
    res.end(JSON.stringify({ error: err.message }));
  }
});

server.listen(PORT, () => {
  console.log(`\n✅ Betclic proxy lancé → http://localhost:${PORT}`);
  console.log('Endpoints:');
  console.log(`  GET http://localhost:${PORT}/betclic?ls=PL        → Premier League`);
  console.log(`  GET http://localhost:${PORT}/betclic?ls=LL        → La Liga`);
  console.log(`  GET http://localhost:${PORT}/betclic?ls=UCL       → Champions League`);
  console.log(`  GET http://localhost:${PORT}/betclic/all          → Toutes les compétitions`);
  console.log(`  GET http://localhost:${PORT}/betclic/leagues      → Liste des ligues`);
  console.log('\nPour arrêter: Ctrl+C\n');
});
