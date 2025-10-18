/* server.cjs — RangNgot (Supabase Storage + signed URL 72h)
   - Upload ảnh/audio/video lên Supabase Storage
   - Trả về link ngắn /r/:id; khi mở sẽ redirect sang receiver.html?file=<signedUrl>
   - FIX: Ép đúng Content-Type cho video (tránh bị audio/mp4)
*/
const path = require('path');
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const PORT = process.env.PORT || 3000;

// Cấu hình public base URL (để trả link tuyệt đối cho client)
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || '';

// CORS: chấp nhận danh sách domain, phân tách bởi dấu phẩy
const CORS_ORIGIN = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map(s => s.trim())
  : true;

// Supabase
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_BUCKET = process.env.SUPABASE_BUCKET || 'rangngot';

// Link TTL & ký HMAC (id ngắn gọn, không cần DB)
const LINK_SECRET = process.env.LINK_SECRET || 'change-me';
const LINK_TTL_HOURS = Number(process.env.LINK_TTL_HOURS || 72);

// Kiểm tra biến môi trường bắt buộc
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
    const ok = ['image/', 'audio/', 'video/'].some(p =>
      (file.mimetype || '').startsWith(p)
    );
    cb(ok ? null : new Error('Unsupported file type'), ok);
  }
});

// ==== Utils (HMAC ID) ====
const b64url = {
  enc: (buf) =>
    Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
  dec: (str) =>
    Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
};
const hmac = (data) => crypto.createHmac('sha256', LINK_SECRET).update(data).digest();
const makeId = (obj) => {
  const j = Buffer.from(JSON.stringify(obj));
  const s = hmac(j);
  return `${b64url.enc(j)}.${b64url.enc(s)}`;
};
const parseId = (id) => {
  const [p, s] = String(id).split('.');
  if (!p || !s) throw 0;
  const pj = b64url.dec(p), sj = b64url.dec(s), ex = hmac(pj);
  if (!crypto.timingSafeEqual(sj, ex)) throw 0;
  return JSON.parse(pj.toString('utf8'));
};
const now = () => Math.floor(Date.now() / 1000);

// Danh sách đuôi video cần ép MIME chuẩn video/mp4 (để tránh bị audio/mp4)
const STRONG_VIDEO_EXTS = new Set(['mp4', 'mov', 'm4v', '3gp', '3gpp']);

// ===== Route: Upload (field name 'audio' để tương thích UI hiện tại) =====
app.post('/upload', upload.single('audio'), async (req, res) => {
  try {
    const f = req.file;
    if (!f) return res.status(400).json({ success: false, message: 'No file' });

    // Tên file sạch
    const cleanName = (f.originalname || 'file').replace(/[^\w.\-]+/g, '_');
    const key = `u/${Date.now()}-${Math.random().toString(36).slice(2)}-${cleanName}`;

    // 👉 FIX MIME CHO VIDEO
    const ext = cleanName.split('.').pop()?.toLowerCase() || '';
    const contentType = STRONG_VIDEO_EXTS.has(ext)
      ? 'video/mp4'                            // buộc là video/mp4 cho mp4/mov/m4v/3gp/3gpp
      : (f.mimetype || 'application/octet-stream');

    // Upload lên Supabase Storage với contentType đã chuẩn hoá
    const { error: upErr } = await supabase
      .storage
      .from(SUPABASE_BUCKET)
      .upload(key, f.buffer, { contentType, upsert: false });

    if (upErr) {
      console.error('[UPLOAD:storage]', upErr);
      return res.status(500).json({ success: false, message: 'Upload failed' });
    }

    // Tạo id ngắn gọn có hạn
    const exp = now() + LINK_TTL_HOURS * 3600;
    const id = makeId({ b: SUPABASE_BUCKET, k: key, exp });

    const pathR = `/r/${id}`;
    const absolute =
      PUBLIC_BASE_URL
        ? `${PUBLIC_BASE_URL}${pathR}`
        : `${req.protocol}://${req.get('host')}${pathR}`;

    return res.json({
      success: true,
      receiverUrl: pathR,
      absoluteReceiverUrl: absolute
    });
  } catch (e) {
    console.error('[UPLOAD]', e);
    const msg = /Unsupported/.test(String(e)) ? 'Unsupported file type' : 'Upload failed';
    return res.status(500).json({ success: false, message: msg });
  }
});

// ===== Route: Resolve link /r/:id -> redirect receiver.html?file=<signedUrl> =====
app.get('/r/:id', async (req, res) => {
  try {
    const { b, k, exp } = parseId(req.params.id);
    const t = now();

    if (!b || !k || !exp) {
      return res.redirect(302, `/expired.html?reason=notfound`);
    }
    if (t >= exp) {
      return res.redirect(302, `/expired.html?reason=expired&ttl=${LINK_TTL_HOURS}`);
    }

    // signed URL thời gian còn lại (tối thiểu 30s, tối đa 7 ngày)
    const remain = Math.max(30, Math.min(exp - t, 7 * 24 * 3600));
    const { data: signed, error } = await supabase
      .storage
      .from(b)
      .createSignedUrl(k, remain);

    if (error || !signed?.signedUrl) {
      console.error('[SIGNED_URL]', error);
      return res.redirect(302, `/expired.html?reason=notfound`);
    }

    // Giao cho receiver.html phát tuỳ loại
    return res.redirect(302, `/receiver.html?file=${encodeURIComponent(signed.signedUrl)}`);
  } catch (e) {
    console.error('[RESOLVE]', e);
    return res.redirect(302, `/expired.html?reason=notfound`);
  }
});

// ===== Health check =====
app.get('/healthz', (req, res) =>
  res.json({ ok: true, time: new Date().toISOString() })
);

// 404 -> expired
app.use((req, res) => res.status(404).sendFile(path.join(PUBLIC_DIR, 'expired.html')));

// Start
app.listen(PORT, () => console.log('RangNgot listening on :' + PORT));
