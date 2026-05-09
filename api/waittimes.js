export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const DL_ID = '7340550b-c14d-4def-80bb-acdb51d49a66';
  const DCA_ID = '832fcd51-ea19-4e77-85c7-75d5843b127c';

  try {
    const [dlResp, dcaResp] = await Promise.all([
      fetch('https://api.themeparks.wiki/v1/entity/' + DL_ID + '/live'),
      fetch('https://api.themeparks.wiki/v1/entity/' + DCA_ID + '/live')
    ]);

    const [dlData, dcaData] = await Promise.all([dlResp.json(), dcaResp.json()]);

    const mapRide = (r, park) => ({
      name: r.name,
      wait: r.queue?.STANDBY?.waitTime ?? null,
      status: r.status,
      park
    });

    const dlRides = (dlData.liveData || [])
      .filter(r => r.entityType === 'ATTRACTION')
      .map(r => mapRide(r, 'DL'));

    const dcaRides = (dcaData.liveData || [])
      .filter(r => r.entityType === 'ATTRACTION')
      .map(r => mapRide(r, 'DCA'));

    const allRides = [...dlRides, ...dcaRides];

    return res.json({
      rides: allRides,
      count: allRides.length,
      updated: new Date().toISOString(),
      source: 'ThemeParks.wiki'
    });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}
