const { put, list, head, del } = require('@vercel/blob');
const VALID_KEYS = ['park_intel','dining_intel','events_intel','park_hours_intel'];
const EXPIRY_DAYS = {park_intel:10,dining_intel:30,events_intel:7,park_hours_intel:7};
const memCache = {};

async function blobGet(key) {
  try {
    const {blobs} = await list({prefix:'twize/'+key});
    if(!blobs||!blobs.length) return null;
    const blob = blobs.sort((a,b)=>new Date(b.uploadedAt)-new Date(a.uploadedAt))[0];
    const r = await fetch(blob.downloadUrl||blob.url);
    return await r.json();
  } catch(e) { console.warn('blobGet err:',e.message); return memCache[key]||null; }
}

async function blobSet(key,value) {
  const data = {value,ts:Date.now()};
  try {
    await put('twize/'+key+'.json', JSON.stringify(data), {
      addRandomSuffix:false,
      contentType:'application/json',
      allowOverwrite:true
    });
    return {ok:true};
  } catch(e) {
    console.warn('blobSet err:',e.message);
    return {ok:false,err:e.message};
  }
}

module.exports = async function handler(req,res) {
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if(req.method==='OPTIONS') return res.status(200).end();
  const {key} = req.query;
  if(!key||!VALID_KEYS.includes(key)) return res.status(400).json({error:'Invalid cache key'});
  if(req.method==='GET') {
    try {
      const data = await blobGet(key);
      if(!data) return res.status(200).json({hit:false});
      const ageDays = (Date.now()-data.ts)/864e5;
      if(ageDays>EXPIRY_DAYS[key]) return res.status(200).json({hit:false,expired:true});
      return res.status(200).json({hit:true,data:data.value,ts:data.ts,key,ageDays:Math.round(ageDays*10)/10});
    } catch(e) { return res.status(200).json({hit:false}); }
  }
  if(req.method==='POST') {
    try {
      const {value} = req.body;
      if(value===undefined) return res.status(400).json({error:'Missing value'});
      const result = await blobSet(key,value);
      return res.status(200).json({ok:result.ok,key,ts:Date.now(),blobErr:result.err||null});
    } catch(e) { return res.status(500).json({error:e.message}); }
  }
  return res.status(405).json({error:'Method not allowed'});
};