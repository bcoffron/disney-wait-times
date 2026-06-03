import { list } from '@vercel/blob';

const STABLE_SECTIONS = [
  'LAND_MAP', 'WAIT_PATTERNS', 'CROWD_FLOW', 'ROPE_DROP_STRATEGY',
  'LIGHTNING_LANE_STRATEGY', 'WALKING_ROUTES', 'DINING_TIMING',
  'SHOW_AND_ENTERTAINMENT', 'FAMILY_AND_ACCESSIBILITY',
  'PHOTO_AND_EXPERIENCE', 'PARK_HOP_STRATEGY', 'WEATHER_AND_COMFORT'
];

const DYNAMIC_SECTIONS = [
  'CURRENT_CLOSURES', 'SPECIAL_EVENTS', 'CURRENT_LL_PRICING', 'TRIP_CONTEXT'
];

async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const report = {
    stable: { found: false, sectionsPresent: [], sectionsMissing: [], totalSections: 0 },
    dynamic: { found: false, sectionsPresent: [], sectionsMissing: [], totalSections: 0 },
    checkedAt: new Date().toISOString()
  };

  // Check stable blob
  try {
    const { blobs: sb } = await list({ prefix: 'twize/park_intel_dl_stable.json' });
    if (sb && sb.length) {
      const fetchUrl = sb[0].downloadUrl || sb[0].url;
      const stableData = await fetch(fetchUrl).then(r => r.json());
      const sections = (stableData.data && stableData.data.sections) || {};
      const keys = Object.keys(sections);
      report.stable.found = true;
      report.stable.sectionsPresent = STABLE_SECTIONS.filter(s => keys.includes(s));
      report.stable.sectionsMissing = STABLE_SECTIONS.filter(s => !keys.includes(s));
      report.stable.totalSections = keys.length;
    } else {
      report.stable.sectionsMissing = [...STABLE_SECTIONS];
    }
  } catch (e) {
    console.error('[cache-health] stable error:', e.message);
    report.stable.sectionsMissing = [...STABLE_SECTIONS];
    report.stable.error = e.message;
  }

  // Check dynamic blob
  try {
    const { blobs: db } = await list({ prefix: 'twize/park_intel_dl_dynamic.json' });
    if (db && db.length) {
      const fetchUrl = db[0].downloadUrl || db[0].url;
      const dynamicData = await fetch(fetchUrl).then(r => r.json());
      const sections = (dynamicData.data && dynamicData.data.sections) || {};
      const keys = Object.keys(sections);
      report.dynamic.found = true;
      report.dynamic.sectionsPresent = DYNAMIC_SECTIONS.filter(s => keys.includes(s));
      report.dynamic.sectionsMissing = DYNAMIC_SECTIONS.filter(s => !keys.includes(s));
      report.dynamic.totalSections = keys.length;
    } else {
      report.dynamic.sectionsMissing = [...DYNAMIC_SECTIONS];
    }
  } catch (e) {
    console.error('[cache-health] dynamic error:', e.message);
    report.dynamic.sectionsMissing = [...DYNAMIC_SECTIONS];
    report.dynamic.error = e.message;
  }

  // Determine status
  const stableOk = report.stable.found && report.stable.sectionsMissing.length === 0;
  const dynamicOk = report.dynamic.found && report.dynamic.sectionsMissing.length === 0;
  const stableFound = report.stable.found;
  const dynamicFound = report.dynamic.found;

  if (stableOk && dynamicOk) {
    report.status = 'healthy';
  } else if (!stableFound || !dynamicFound) {
    report.status = 'failed';
  } else {
    report.status = 'degraded';
  }

  console.log('[cache-health] status:', report.status,
    '| stable:', report.stable.sectionsPresent.length + '/' + STABLE_SECTIONS.length,
    '| dynamic:', report.dynamic.sectionsPresent.length + '/' + DYNAMIC_SECTIONS.length);

  return res.status(200).json(report);
}

module.exports = handler;