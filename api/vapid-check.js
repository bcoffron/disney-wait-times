// TEMPORARY diagnostic - verifies VAPID env vars are present and well-formed.
// Reports SHAPE ONLY for the private key (never its value). Delete after verification.

function b64urlLen(s) {
  if (!s) return 0;
  // bytes decoded from base64url (no padding)
  const clean = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = clean.length % 4 === 0 ? 0 : 4 - (clean.length % 4);
  try {
    return Buffer.from(clean + '='.repeat(pad), 'base64').length;
  } catch (e) {
    return -1;
  }
}

async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const pub = process.env.VAPID_PUBLIC_KEY || '';
  const priv = process.env.VAPID_PRIVATE_KEY || '';
  const subj = process.env.VAPID_SUBJECT || '';

  const report = {
    VAPID_PUBLIC_KEY: {
      present: !!pub,
      chars: pub.length,
      decodedBytes: b64urlLen(pub),
      startsWith0x04: b64urlLen(pub) === 65 ? (Buffer.from(pub.replace(/-/g,'+').replace(/_/g,'/') + '==', 'base64')[0] === 4) : false,
      // public key is safe to echo - lets Claude confirm it matches the generated one
      value: pub,
      okShape: pub.length === 87 && b64urlLen(pub) === 65
    },
    VAPID_PRIVATE_KEY: {
      present: !!priv,
      chars: priv.length,
      decodedBytes: b64urlLen(priv),
      // NEVER echo the private value
      okShape: priv.length === 43 && b64urlLen(priv) === 32
    },
    VAPID_SUBJECT: {
      present: !!subj,
      startsWithMailto: subj.indexOf('mailto:') === 0,
      value: subj,
      okShape: subj.indexOf('mailto:') === 0
    },
    checkedAt: new Date().toISOString()
  };

  report.allGood = report.VAPID_PUBLIC_KEY.okShape &&
                   report.VAPID_PRIVATE_KEY.okShape &&
                   report.VAPID_SUBJECT.okShape;

  console.log('[vapid-check] allGood:', report.allGood,
    '| pub:', report.VAPID_PUBLIC_KEY.okShape,
    '| priv:', report.VAPID_PRIVATE_KEY.okShape,
    '| subj:', report.VAPID_SUBJECT.okShape);

  return res.status(200).json(report);
}

export default handler;
