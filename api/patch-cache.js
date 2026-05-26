const { put, list } = require('@vercel/blob');

module.exports = async function(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  // Only allow POST with secret
  if (req.method !== 'POST') return res.status(405).end();
  
  const secret = req.headers['x-patch-secret'];
  if (secret !== 'PP2026patch') return res.status(401).json({error:'unauthorized'});
  
  const { key, sectionName, sectionData } = req.body;
  if (!key || !sectionName || !sectionData) return res.status(400).json({error:'missing params'});
  
  try {
    // Read existing blob
    const {blobs} = await list({prefix:'twize/' + key + '.json'});
    if (!blobs || !blobs.length) return res.status(404).json({error:'blob not found'});
    
    const blob = blobs[0];
    const fetchUrl = blob.downloadUrl || blob.url;
    const existing = await (await fetch(fetchUrl)).json();
    
    // Patch the section
    if (!existing.sections) existing.sections = {};
    if (!existing.section_meta) existing.section_meta = {};
    
    existing.sections[sectionName] = sectionData;
    existing.section_meta[sectionName] = {
      built: true,
      length: typeof sectionData === 'string' ? sectionData.length : JSON.stringify(sectionData).length,
      last_edited: new Date().toISOString(),
      edit_note: 'Direct blob patch'
    };
    existing.last_updated = new Date().toISOString();
    
    // Write back
    await put('twize/' + key + '.json', JSON.stringify(existing), {
      access: 'public',
      addRandomSuffix: false,
      contentType: 'application/json',
      allowOverwrite: true
    });
    
    return res.json({
      ok: true,
      key,
      sectionName,
      sectionLength: typeof sectionData === 'string' ? sectionData.length : JSON.stringify(sectionData).length
    });
  } catch(e) {
    return res.status(500).json({ok:false, error:e.message});
  }
};