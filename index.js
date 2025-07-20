const express = require('express');
const multer = require('multer');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;
const { nanoid } = require('nanoid');
const fs = require('fs');
const convert = require('heic-convert');
const sharp = require('sharp');

// Used to store image IDs and filenames (in-memory, lost after restart, enough for MVP)
const imageMap = {};

// Set up multer storage config
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, 'uploads/');
  },
  filename: function (req, file, cb) {
    // Generate unique filename
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});
const upload = multer({ storage: storage });

// Allow CORS and parse forms
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Image upload endpoint
app.post('/upload', upload.single('image'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }
  let filename = req.file.filename;
  let ext = path.extname(filename);
  let outputFilename = filename;

  if (/\.heic$/i.test(ext) || /\.heif$/i.test(ext)) {
    try {
      console.log('[HEIC] Detected HEIC/HEIF file:', filename);
      const inputBuffer = fs.readFileSync(req.file.path);
      let outputBuffer;
      let sharpSuccess = false;
      // 优先用sharp处理
      try {
        outputBuffer = await sharp(inputBuffer).jpeg({ quality: 90 }).toBuffer();
        sharpSuccess = true;
        console.log('[HEIC] Converted with sharp');
      } catch (err) {
        console.warn('[HEIC] sharp failed, fallback to heic-convert:', err.message);
      }
      // sharp失败时用heic-convert兜底
      if (!sharpSuccess) {
        outputBuffer = await convert({
          buffer: inputBuffer,
          format: 'JPEG',
          quality: 1
        });
        console.log('[HEIC] Converted with heic-convert');
      }
      outputFilename = filename.replace(/\.(heic|heif)$/i, '.jpg');
      const outputPath = path.join('uploads', outputFilename);
      fs.writeFileSync(outputPath, outputBuffer);
      console.log('[HEIC] Wrote JPG file:', outputFilename, 'size:', outputBuffer.length);
      fs.unlinkSync(req.file.path); // 删除原 heic 文件
      console.log('[HEIC] Deleted original HEIC file:', filename);
    } catch (err) {
      console.error('[HEIC] HEIC to JPG conversion failed:', err);
      return res.status(500).json({ error: 'HEIC to JPG conversion failed', detail: err.message });
    }
  }

  // Generate unique ID
  const id = nanoid(8);
  imageMap[id] = outputFilename;
  // Return both page link and image file link
  const pageUrl = `/img/${id}`;
  const imageUrl = `/uploads/${outputFilename}`;
  res.json({ 
    url: pageUrl,
    pageLink: pageUrl,
    imageLink: imageUrl
  });
});

// New: Access image via short link
app.get('/img/:id', (req, res) => {
  const filename = imageMap[req.params.id];
  if (!filename) {
    return res.status(404).send('Image not found');
  }
  const filePath = path.join(__dirname, 'uploads', filename);
  // Check if file exists
  fs.access(filePath, fs.constants.F_OK, (err) => {
    if (err) return res.status(404).send('Image not found');
    res.sendFile(filePath);
  });
});

// Static file service for uploaded images
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// New: Root path returns index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Static file service for frontend and root directory files
app.use(express.static(__dirname));
app.use('/', express.static(path.join(__dirname)));

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
}); 