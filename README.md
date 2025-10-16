# Răng Ngọt 20/10 — Gửi lời chúc bằng âm thanh 💞

Một mini web giúp bạn **tải lên lời chúc (audio)** và tạo **link/QR** để người đặc biệt mở và nghe ngay trong giao diện pastel ngọt ngào.

## ✨ Tính năng
- Upload file âm thanh (`audio/*`) từ trang **Gửi**
- Trả về **đường link người nhận** + **QR** để chia sẻ
- Trang **Nhận** phát đúng file vừa upload
- Giao diện **đồng bộ** (logo, màu, hiệu ứng tim bay)
- Hỗ trợ deploy nhanh lên **Render** (có **Persistent Disk** để không mất file)

## 🗂 Cấu trúc thư mục
project/
├─ public/
│ ├─ index.html
│ ├─ receiver.html
│ └─ style.css
├─ uploads/
│ └─ .gitkeep
├─ server.cjs
├─ package.json
└─ README.md
## 🚀 Chạy local
npm install
npm startMở [http://localhost:3000](http://localhost:3000)

## ☁️ Deploy lên Render
1. Push code lên GitHub.
2. Tạo Web Service mới trên [render.com](https://render.com)
3. Build command: _(để trống)_
4. Start command: `node server.cjs`
5. Add Disk: `/opt/render/project/src/uploads`
6. Done 🎉

## 📄 .gitignore (gợi ý)
node_modules/
uploads/*
!uploads/.gitkeep
.DS_Store
