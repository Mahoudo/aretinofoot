/**
 * api/betclic.js — Fonction serverless Vercel (remplace le proxy Render mort)
 *
 * Route : GET /api/betclic?league=angl-premier-league-c3
 *         GET /api/betclic?ls=PL
 *
 * Zéro dépendance (https natif). Pas de spin-down, same-origin, cache edge 2 min.
 * Le code de scraping est identique au proxy local betclic-proxy.js (éprouvé).
 */
const https = require('https');

// Betclic CI → league slugs (chemin après /football-sfootball/)
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

// Récupère une URL en suivant les redirections, renvoie le texte
function fetchPage(targetUrl, depth = 0) {
  return new Promise((resolve, reject) => {
    if (depth > 5) return reject(new Error('Too many redirects'));
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'fr-FR,fr;q=0.9',
        'Cache-Control': 'no-cache',
      }
    };
    https.get(targetUrl, options, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchPage(res.headers.location, depth + 1).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

// Parse tous les marchés 1X2 + métadonnées événement depuis le HTML Betclic
function parseOdds(html) {
  const results = [];

  // 1) Métadonnées événement (nom, date, classement, forme, logo)
  const eventRe = /"name":"([A-ZÀ-ɏ][^"]+ - [A-ZÀ-ɏ][^"]+)","matchDateUtc":"([^"]+)","isLive":(true|false)[^}]{0,3000}?"contestants":\[(\{[^[]{0,2000}\})\]/g;
  const eventsMap = {};
  let em;
  while ((em = eventRe.exec(html)) !== null) {
    const name    = em[1];
    const dateUtc = em[2];
    const isLive  = em[3] === 'true';
    const contRaw = em[4];

    const contMatch = contRaw.match(/"contestantId":"(\d+)","name":"([^"]+)"[^}]*"ranking":"([^"]*)"[^}]*"formResults":\[([^\]]*)\]/);
    const homeId    = contMatch ? contMatch[1] : null;
    const homeName  = contMatch ? contMatch[2] : name.split(' - ')[0];
    const homeRank  = contMatch ? contMatch[3] : '';
    const homeForm  = contMatch ? contMatch[4].split(',').map(Number) : [];

    const dt      = new Date(dateUtc);
    const timeStr = dt.getHours().toString().padStart(2,'0') + ':' + dt.getMinutes().toString().padStart(2,'0');
    const dateStr = dt.toISOString().split('T')[0];

    eventsMap[name] = { name, dateUtc, timeStr, dateStr, isLive, homeId, homeName, homeRank, homeForm };
  }

  // 2) Triplets de cotes 1X2
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

  // Grouper en triplets (Dom / Nul / Ext)
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

// ── Handler Vercel ────────────────────────────────────────────
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  try {
    const q = req.query || {};
    let slug = q.league;
    if (!slug && q.ls) slug = LEAGUE_SLUGS[String(q.ls).toUpperCase()];

    // ── Mode debug : voir ce que Betclic renvoie réellement à Vercel ──
    if (q.debug) {
      const dslug = slug || 'angl-premier-league-c3';
      const html = await fetchPage(`https://www.betclic.ci/football-sfootball/${dslug}`);
      res.status(200).json({
        slug: dslug,
        htmlLen: html.length,
        hasOddsMarker: html.includes('"odds":'),
        hasEventMarker: html.includes('matchDateUtc'),
        hasContestants: html.includes('contestants'),
        title: ((html.match(/<title>([^<]*)<\/title>/i) || [])[1] || '').slice(0, 120),
        looksBlocked: /captcha|datadome|access denied|forbidden|blocked|are you human|unusual traffic/i.test(html),
        snippet: html.slice(0, 400)
      });
      return;
    }

    if (!slug) {
      res.status(400).json({ error: 'Missing ?league= or ?ls= param', available: LEAGUE_SLUGS });
      return;
    }

    const pageUrl = `https://www.betclic.ci/football-sfootball/${slug}`;
    const html    = await fetchPage(pageUrl);
    const matches = parseOdds(html);

    // Cache edge 2 min (sert la même réponse aux visiteurs, allège Betclic)
    res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=300');
    res.status(200).json(matches);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
