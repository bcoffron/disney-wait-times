module.exports = async function handler(req, res) {
  // Handle preflight OPTIONS request
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    const r = await fetch('https://www.parksavers.com/live-disneyland-resort-wait-times-api/', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://www.parksavers.com/',
      }
    });

    if (!r.ok) {
      return res.status(502).json({ error: 'Could not fetch Park Savers', status: r.status });
    }

    const html = await r.text();

    const rides = [];
    const rowRegex = /<tr[^>]*>\s*<td[^>]*>([^<]+)<\/td>\s*<td[^>]*>(\d+)\s*minutes?<\/td>\s*<td[^>]*>(Open|Closed)<\/td>/gi;
    let match;
    while ((match = rowRegex.exec(html)) !== null) {
      const name = match[1].trim();
      const wait = parseInt(match[2]);
      const isOpen = match[3].toLowerCase() === 'open';
      if (name.toLowerCase().includes('single rider')) continue;
      rides.push({
        name,
        wait: isOpen ? wait : null,
        status: isOpen ? 'OPERATING' : 'CLOSED',
      });
    }

    if (rides.length === 0) {
      return res.status(502).json({ error: 'Could not parse wait times', htmlLength: html.length });
    }

    return res.status(200).json({
      rides,
      updated: new Date().toISOString(),
      source: 'ParkSavers.com',
      count: rides.length,
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
