/* server.cjs — RangNgot (Supabase Storage + short links + signed URL)
   - Upload ảnh/audio/video lên Supabase Storage
   - Trả về link ngắn /r/<slug> (8 ký tự). Giữ tương thích /r/<HMAC-ID> cũ.
   - Ép đúng Content-Type cho video (tránh bị audio/mp4)
*/
const path = require('path');
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const PORT = process.env.PORT || 3000;

// Public base (để trả link tuyệt đối)
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || '';

// CORS: danh sách origin, phân tách dấu phẩy; nếu trống => true
const CORS_ORIGIN = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map((s) => s.trim())
  : true;

// Supabase
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_BUCKET = process.env.SUPABASE_BUCKET || 'rangngot';

// TTL & secret cho link HMAC (tương thích bản cũ)
const LINK_SECRET = process.env.LINK_SECRET || 'change-me';
const LINK_TTL_HOURS = Number(process.env.LINK_TTL_HOURS || 72);

// Kiểm tra env bắt buộc
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('[FATAL] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// Express
const app = express();
app.disable('x-powered-by');
app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Static public (index.html, receiver.html, expired.html, style.css, ...)
const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR, { maxAge: '1h' }));

// Multer: lưu trên RAM, giới hạn ~26MB (an toàn dưới 25MB client)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 26 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    const ok = ['image/', 'audio/', 'video/'].some((p) =>
      (file.mimetype || '').startsWith(p)
    );
    cb(ok ? null : new Error('Unsupported file type'), ok);
  },
});

// ==== Utils chung ====
const now = () => Math.floor(Date.now() / 1000);

// HMAC ID (tương thích bản cũ, không cần DB)
const b64url = {
  enc: (buf) =>
    Buffer.from(buf)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, ''),
  dec: (str) =>
    Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64'),
};
const hmac = (data) =>
  crypto.createHmac('sha256', LINK_SECRET).update(data).digest();
const makeId = (obj) => {
  const j = Buffer.from(JSON.stringify(obj));
  const s = hmac(j);
  return `${b64url.enc(j)}.${b64url.enc(s)}`;
};
const parseId = (id) => {
  const [p, s] = String(id).split('.');
  if (!p || !s) throw 0;
  const pj = b64url.dec(p),
    sj = b64url.dec(s),
    ex = hmac(pj);
  if (!crypto.timingSafeEqual(sj, ex)) throw 0;
  return JSON.parse(pj.toString('utf8'));
};

// Slug ngắn (base62)
const B62 = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
function randSlug(len = 8) {
  const buf = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < buf.length; i++) out += B62[buf[i] % 62];
  return out;
}
async function createUniqueSlug() {
  for (let i = 0; i < 5; i++) {
    const id = randSlug(8);
    const { data, error } = await supabase
      .from('rn_links')
      .select('id')
      .eq('id', id)
      .maybeSingle();
    if (!error && !data) return id; // chưa tồn tại
  }
  return randSlug(10); // quá xui thì tăng độ dài
}

// MIME fix cho video (tránh bị audio/mp4)
const STRONG_VIDEO_EXTS = new Set(['mp4', 'mov', 'm4v', '3gp', '3gpp']);

// ===== Route: Upload (field name 'audio' để tương thích UI hiện tại) =====
app.post('/upload', upload.single('audio'), async (req, res) => {
  try {
    const f = req.file;
    if (!f) return res.status(400).json({ success: false, message: 'No file' });

    // Tên file sạch
    const cleanName = (f.originalname || 'file').replace(/[^\w.\-]+/g, '_');
    const key = `u/${Date.now()}-${Math.random().toString(36).slice(2)}-${cleanName}`;

    // Ép MIME cho video (đặc biệt .mp4) => tránh bị audio/mp4
    const ext = cleanName.split('.').pop()?.toLowerCase() || '';
    const contentType = STRONG_VIDEO_EXTS.has(ext)
      ? 'video/mp4'
      : f.mimetype || 'application/octet-stream';

    // Upload lên Supabase Storage
    const { error: upErr } = await supabase
      .storage
      .from(SUPABASE_BUCKET)
      .upload(key, f.buffer, { contentType, upsert: false });

    if (upErr) {
      console.error('[UPLOAD:storage]', upErr);
      return res.status(500).json({ success: false, message: 'Upload failed' });
    }

    // Tạo hạn
    const exp = now() + LINK_TTL_HOURS * 3600;

    // Tạo slug ngắn & lưu DB
    let shortId = await createUniqueSlug();
    const { error: dbErr } = await supabase.from('rn_links').insert({
      id: shortId,
      bucket: SUPABASE_BUCKET,
      obj_key: key,
      exp,
    });
    if (dbErr) {
      console.error('[DB insert rn_links]', dbErr);
      // fallback: nếu lỗi DB, vẫn có HMAC ID để dùng
      shortId = null;
    }

    // HMAC ID tương thích (dài), phòng khi slug tạo/lưu lỗi
    const compatId = makeId({ b: SUPABASE_BUCKET, k: key, exp });

    // Link ưu tiên: slug ngắn
    const pathR = `/r/${shortId || compatId}`;
    const absolute = PUBLIC_BASE_URL
      ? `${PUBLIC_BASE_URL}${pathR}`
      : `${req.protocol}://${req.get('host')}${pathR}`;

    return res.json({
      success: true,
      receiverUrl: pathR,
      absoluteReceiverUrl: absolute,
      // debug optional:
      legacyId: `/r/${compatId}`,
    });
  } catch (e) {
    console.error('[UPLOAD]', e);
    const msg = /Unsupported/.test(String(e))
      ? 'Unsupported file type'
      : 'Upload failed';
    return res.status(500).json({ success: false, message: msg });
  }
});

// ===== Route: Resolve /r/:id (slug ngắn HOẶC HMAC cũ) =====
app.get('/r/:id', async (req, res) => {
  const raw = String(req.params.id || '');
  const t = now();

  // 1) Thử parse theo HMAC (ID dài) để tương thích backward
  try {
    const { b, k, exp } = parseId(raw);
    if (!b || !k || !exp) throw 0;
    if (t >= exp)
      return res.redirect(
        302,
        `/expired.html?reason=expired&ttl=${LINK_TTL_HOURS}`
      );

    const remain = Math.max(30, Math.min(exp - t, 7 * 24 * 3600));
    const { data: signed, error } = await supabase
      .storage
      .from(b)
      .createSignedUrl(k, remain);

    if (error || !signed?.signedUrl)
      return res.redirect(302, `/expired.html?reason=notfound`);

    return res.redirect(
      302,
      `/receiver.html?file=${encodeURIComponent(signed.signedUrl)}`
    );
  } catch {
    // không phải HMAC → coi như slug
  }

  // 2) Slug ngắn: lookup DB
  const { data: row, error: qErr } = await supabase
    .from('rn_links')
    .select('bucket, obj_key, exp')
    .eq('id', raw)
    .maybeSingle();

  if (qErr || !row)
    return res.redirect(302, `/expired.html?reason=notfound`);
  if (t >= Number(row.exp || 0))
    return res.redirect(
      302,
      `/expired.html?reason=expired&ttl=${LINK_TTL_HOURS}`
    );

  const remain2 = Math.max(30, Math.min(Number(row.exp) - t, 7 * 24 * 3600));
  const { data: signed2, error: sErr } = await supabase
    .storage
    .from(row.bucket)
    .createSignedUrl(row.obj_key, remain2);

  if (sErr || !signed2?.signedUrl)
    return res.redirect(302, `/expired.html?reason=notfound`);

  return res.redirect(
    302,
    `/receiver.html?file=${encodeURIComponent(signed2.signedUrl)}`
  );
});

// ===== Health check =====
app.get('/healthz', (req, res) =>
  res.json({ ok: true, time: new Date().toISOString() })
);

// 404 -> expired
app.use((req, res) =>
  res.status(404).sendFile(path.join(PUBLIC_DIR, 'expired.html'))
);

// Start
app.listen(PORT, () =>
  console.log('RangNgot listening on :' + PORT)
);
