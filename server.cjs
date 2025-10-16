const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const multer = require('multer');

const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || '';

// CORS
app.use(cors({
  origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : true
}));

// Thư mục tĩnh và uploads
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOAD_DIR, { setHeaders: r => r.setHeader('Accept-Ranges','bytes') }));

// Lưu map shortURL -> đường dẫn file, có PERSIST vào uploads/map.json
const MAP_PATH = path.join(UPLOAD_DIR, 'map.json');
let urlMap = {};
try {
  if (fs.existsSync(MAP_PATH)) urlMap = JSON.parse(fs.readFileSync(MAP_PATH, 'utf8') || '{}');
} catch { urlMap = {}; }
const saveMap = () => { try { fs.writeFileSync(MAP_PATH, JSON.stringify(urlMap, null, 2)); } catch {} };

// Multer: nhận audio hoặc video, giới hạn 30MB
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const safe = Date.now() + '-' + (file.originalname || 'file').replace(/[^\w.\-]/g, '_');
    cb(null, safe);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 30 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const type = (file.mimetype || '');
    if (type.startsWith('audio/') || type.startsWith('video/')) cb(null, true);
    else cb(new Error('Chỉ nhận file âm thanh hoặc video'));
  }
});

// API: Upload -> trả link ngắn
app.post('/upload', upload.single('audio'), (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, message: 'Không có file' });

  const shortId = (Date.now().toString(36) + Math.random().toString(36).slice(2, 6)).toLowerCase();
  const shortPath = `/r/${shortId}`;
  const filePath = '/uploads/' + req.file.filename;

  urlMap[shortId] = filePath;
  saveMap();

  res.json({
    success: true,
    receiverUrl: shortPath,
    absoluteReceiverUrl: PUBLIC_BASE_URL ? `${PUBLIC_BASE_URL}${shortPath}` : undefined
  });
});

// Mở link ngắn -> chuyển sang trang nhận
app.get('/r/:id', (req, res) => {
  const filePath = urlMap[req.params.id];
  if (!filePath) return res.status(404).send('Liên kết không tồn tại hoặc đã hết hạn 😢');
  res.redirect(`/receiver.html?audio=${encodeURIComponent(filePath)}`);
});

// Fallback
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// Start server
app.listen(PORT, () => console.log(`Server chạy: http://localhost:${PORT}`));
