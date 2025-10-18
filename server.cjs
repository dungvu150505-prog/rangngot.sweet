const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const multer = require('multer');

const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || '';
const TTL_HOURS = parseInt(process.env.TTL_HOURS || '72', 10); // thời gian sống link/file

// CORS
app.use(cors({
  origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : true
}));

// Thư mục & biến tiện dụng
const ROOT_DIR   = __dirname;
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const UPLOAD_DIR = path.join(ROOT_DIR, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Map: id -> { path, expiresAt }
const MAP_PATH = path.join(UPLOAD_DIR, 'map.json');
let urlMap = {};
try {
  if (fs.existsSync(MAP_PATH)) urlMap = JSON.parse(fs.readFileSync(MAP_PATH, 'utf8') || '{}');
} catch { urlMap = {}; }

const nowMs = () => Date.now();
const inMs  = (h) => h * 60 * 60 * 1000;
const isExpired = (e) => !e || e.expiresAt <= nowMs();

const saveMap = () => { try { fs.writeFileSync(MAP_PATH, JSON.stringify(urlMap, null, 2)); } catch {} };

// Cron đơn giản: dọn file quá hạn + map
function cleanupExpired() {
  let changed = false;
  for (const id of Object.keys(urlMap)) {
    const entry = urlMap[id];
    if (!entry) continue;
    if (isExpired(entry)) {
      try {
        const abs = path.join(ROOT_DIR, entry.path.replace(/^\//, ''));
        if (abs.startsWith(UPLOAD_DIR) && fs.existsSync(abs)) fs.unlinkSync(abs);
      } catch {}
      delete urlMap[id];
      changed = true;
    }
  }
  if (changed) saveMap();

  // Xoá file rơi rớt > TTL
  try {
    const listed = new Set(Object.values(urlMap).map(e => e.path));
    for (const f of fs.readdirSync(UPLOAD_DIR)) {
      if (f === path.basename(MAP_PATH)) continue;
      const rel = '/uploads/' + f;
      if (!listed.has(rel)) {
        const abs = path.join(UPLOAD_DIR, f);
        const stat = fs.statSync(abs);
        if (nowMs() - stat.mtimeMs > inMs(TTL_HOURS)) {
          try { fs.unlinkSync(abs); } catch {}
        }
      }
    }
  } catch {}
}
cleanupExpired();
setInterval(cleanupExpired, 60 * 60 * 1000); // mỗi giờ

// Multer: ảnh / audio / video, ~30MB
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const safe = Date.now() + '-' + (file.originalname || 'file').replace(/[^\w.\-]/g, '_');
    cb(null, safe);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 30 * 1024 * 1024 }, // ~30MB
  fileFilter: (req, file, cb) => {
    const type = (file.mimetype || '');
    if (type.startsWith('image/') || type.startsWith('audio/') || type.startsWith('video/')) cb(null, true);
    else cb(new Error('Chỉ nhận ảnh, âm thanh hoặc video'));
  }
});

// Static public
app.use(express.static(PUBLIC_DIR));

// Guard /uploads: chỉ phục vụ file còn hạn
app.use('/uploads', (req, res, next) => {
  const reqPath = '/uploads' + req.path;
  const ok = Object.values(urlMap).some(e => e.path === reqPath && !isExpired(e));
  if (!ok) return res.status(404).send('File không tồn tại hoặc đã hết hạn.');
  express.static(UPLOAD_DIR, { setHeaders: r => r.setHeader('Accept-Ranges', 'bytes') })(req, res, next);
});

// Upload (hỗ trợ field 'audio' hoặc 'file')
const fields = upload.fields([{ name: 'audio', maxCount: 1 }, { name: 'file', maxCount: 1 }]);
app.post('/upload', fields, (req, res) => {
  const picked =
    (req.files?.audio?.[0]) ||
    (req.files?.file?.[0]) || null;
  if (!picked) return res.status(400).json({ success: false, message: 'Không có file' });

  const shortId  = (nowMs().toString(36) + Math.random().toString(36).slice(2, 6)).toLowerCase();
  const shortUrl = `/r/${shortId}`;
  const filePath = '/uploads/' + picked.filename;

  urlMap[shortId] = { path: filePath, expiresAt: nowMs() + inMs(TTL_HOURS) };
  saveMap();

  res.json({
    success: true,
    receiverUrl: shortUrl,
    absoluteReceiverUrl: PUBLIC_BASE_URL ? `${PUBLIC_BASE_URL}${shortUrl}` : undefined,
    expiresAt: urlMap[shortId].expiresAt
  });
});

// Link rút gọn -> kiểm tra hạn -> điều hướng
app.get('/r/:id', (req, res) => {
  const entry = urlMap[req.params.id];
  if (!entry) return res.redirect(`/expired.html?reason=notfound&ttl=${TTL_HOURS}`);

  if (isExpired(entry)) {
    // dọn luôn
    try {
      const abs = path.join(__dirname, entry.path.replace(/^\//, ''));
      if (abs.startsWith(UPLOAD_DIR) && fs.existsSync(abs)) fs.unlinkSync(abs);
    } catch {}
    delete urlMap[req.params.id];
    saveMap();
    return res.redirect(`/expired.html?reason=expired&ttl=${TTL_HOURS}`);
  }

  return res.redirect(`/receiver.html?file=${encodeURIComponent(entry.path)}`);
});

// Fallback SPA
app.get('*', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

// Start
app.listen(PORT, () => console.log(`Server chạy: http://localhost:${PORT} (TTL ${TTL_HOURS}h)`));
