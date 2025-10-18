const path = require('path');
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');
const { nanoid } = require('nanoid');

const PORT = process.env.PORT || 3000;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || '';
const CORS_ORIGIN = process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',').map(s=>s.trim()) : true;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_BUCKET = process.env.SUPABASE_BUCKET || 'rangngot';
const LINK_TTL_HOURS = Number(process.env.LINK_TTL_HOURS || 72);

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('[FATAL] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY'); process.exit(1);
}
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const app = express();
app.disable('x-powered-by');
app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR, { maxAge: '1h' }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 26 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    const ok = ['image/','audio/','video/'].some(p => (file.mimetype||'').startsWith(p));
    cb(ok ? null : new Error('Unsupported file type'), ok);
  }
});

const now = () => Math.floor(Date.now()/1000);

// 🩷 Upload
app.post('/upload', upload.single('audio'), async (req, res) => {
  try {
    const f = req.file;
    if (!f) return res.status(400).json({ success:false, message:'No file' });
    const clean = (f.originalname || 'file').replace(/[^\w.\-]+/g,'_');
    const key = `u/${Date.now()}-${Math.random().toString(36).slice(2)}-${clean}`;

    const { error: upErr } = await supabase.storage.from(SUPABASE_BUCKET).upload(key, f.buffer, { contentType: f.mimetype, upsert: false });
    if (upErr) throw upErr;

    const exp = now() + LINK_TTL_HOURS * 3600;
    const id  = nanoid(10);
    const { error: dbErr } = await supabase.from('rn_links').insert({ id, bucket: SUPABASE_BUCKET, obj_key: key, exp });
    if (dbErr) throw dbErr;

    const pathR = `/r/${id}`;
    const absolute = PUBLIC_BASE_URL ? `${PUBLIC_BASE_URL}${pathR}` : `${req.protocol}://${req.get('host')}${pathR}`;
    res.json({ success:true, receiverUrl:pathR, absoluteReceiverUrl:absolute });
  } catch (e) {
    console.error('[UPLOAD]', e);
    res.status(500).json({ success:false, message:'Upload failed' });
  }
});

// 💌 Resolve link
app.get('/r/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const { data, error } = await supabase.from('rn_links').select('bucket,obj_key,exp').eq('id', id).single();
    if (error || !data) return res.redirect(302, `/expired.html?reason=notfound`);

    const { bucket, obj_key, exp } = data;
    const t = now();
    if (t >= exp) {
      await supabase.from('rn_links').delete().eq('id', id);
      return res.redirect(302, `/expired.html?reason=expired&ttl=${LINK_TTL_HOURS}`);
    }

    const remain = Math.max(30, Math.min(exp - t, 7 * 24 * 3600));
    const { data: signed, error: signErr } = await supabase.storage.from(bucket).createSignedUrl(obj_key, remain);
    if (signErr || !signed?.signedUrl) return res.redirect(302, `/expired.html?reason=notfound`);
    return res.redirect(302, `/receiver.html?file=${encodeURIComponent(signed.signedUrl)}`);
  } catch (e) {
    console.error('[RESOLVE]', e);
    return res.redirect(302, `/expired.html?reason=notfound`);
  }
});

// 🔧 Cleanup (tuỳ chọn)
app.post('/admin/cleanup', async (req,res)=>{
  const nowSec = now();
  const { data, error } = await supabase.from('rn_links').select('id,bucket,obj_key').lt('exp', nowSec).limit(500);
  if (error) return res.status(500).json({ ok:false, error:String(error) });
  for (const row of data||[]) {
    await supabase.storage.from(row.bucket).remove([row.obj_key]).catch(()=>{});
    await supabase.from('rn_links').delete().eq('id', row.id).catch(()=>{});
  }
  res.json({ ok:true, deleted:(data||[]).length });
});

app.get('/healthz',(req,res)=>res.json({ok:true,time:new Date().toISOString()}));
app.use((req,res)=>res.status(404).sendFile(path.join(PUBLIC_DIR,'expired.html')));
app.listen(PORT, ()=>console.log('🍰 RangNgot listening on :' + PORT));
