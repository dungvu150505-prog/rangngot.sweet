const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const multer = require('multer');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({
  origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : true
}));

const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const safe = Date.now() + '-' + file.originalname.replace(/[^\w.\-]/g, '_');
    cb(null, safe);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => ((file.mimetype || '').startsWith('audio/')) ? cb(null, true) : cb(new Error('Chỉ nhận audio/*'))
});

app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads'), { setHeaders: r => r.setHeader('Accept-Ranges','bytes') }));

app.post('/upload', upload.single('audio'), (req, res) => {
  if (!req.file) return res.status(400).json({ success:false, message:'Không có file' });
  const receiverPath = `/receiver.html?audio=${encodeURIComponent(`/uploads/${req.file.filename}`)}`;
  const absoluteBase = process.env.PUBLIC_BASE_URL || '';
  const absoluteReceiverUrl = absoluteBase ? `${absoluteBase}${receiverPath}` : undefined;
  res.json({ success:true, receiverUrl: receiverPath, absoluteReceiverUrl });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`Server chạy: http://localhost:${PORT}`));
