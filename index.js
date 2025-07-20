const express = require('express');
const multer = require('multer');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;
const { nanoid } = require('nanoid');
const fs = require('fs');
const convert = require('heic-convert');
const sharp = require('sharp');

// Data storage functions

// Data file path
const dataFile = path.join(__dirname, 'data.json');

// Load data from JSON file
function loadData() {
  try {
    if (fs.existsSync(dataFile)) {
      const data = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
      return data.images || {};
    }
  } catch (error) {
    console.error('Error loading data:', error);
  }
  return {};
}

// Save data to JSON file
function saveData(imageMap) {
  try {
    const data = { images: imageMap };
    fs.writeFileSync(dataFile, JSON.stringify(data, null, 2));
  } catch (error) {
    console.error('Error saving data:', error);
  }
}

// Load existing data
const imageMap = loadData();

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
const upload = multer({ 
  storage: storage,
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB limit
  }
});

// Allow CORS and parse forms
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Error handling middleware for multer
app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'File size too large! Maximum size is 5MB.' });
    }
  }
  next(error);
});

// Image upload endpoint
app.post('/upload', upload.single('image'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }
  
  // Check file size (additional check)
  if (req.file.size > 5 * 1024 * 1024) {
    return res.status(400).json({ error: 'File size too large! Maximum size is 5MB.' });
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
  imageMap[id] = {
    filename: outputFilename,
    originalName: req.file.originalname,
    uploadTime: new Date().toISOString(),
    size: req.file.size
  };
  
  // Save to JSON file
  saveData(imageMap);
  
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
  const imageData = imageMap[req.params.id];
  if (!imageData) {
    return res.status(404).send('Image not found');
  }
  const filePath = path.join(__dirname, 'uploads', imageData.filename);
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

// Delete image endpoint
app.delete('/delete/:id', (req, res) => {
  const id = req.params.id;
  const imageData = imageMap[id];
  
  if (!imageData) {
    return res.status(404).json({ error: 'Image not found' });
  }
  
  try {
    // Delete file from uploads folder
    const filePath = path.join(__dirname, 'uploads', imageData.filename);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    
    // Remove from imageMap
    delete imageMap[id];
    
    // Save updated data to JSON file
    saveData(imageMap);
    
    res.json({ success: true, message: 'Image deleted successfully' });
  } catch (error) {
    console.error('Error deleting image:', error);
    res.status(500).json({ error: 'Failed to delete image' });
  }
});

// Get all images endpoint
app.get('/api/images', (req, res) => {
  const images = Object.keys(imageMap).map(id => ({
    id: id,
    filename: imageMap[id].filename,
    originalName: imageMap[id].originalName,
    uploadTime: imageMap[id].uploadTime,
    size: imageMap[id].size,
    url: `/img/${id}`,
    directUrl: `/uploads/${imageMap[id].filename}`
  }));
  
  res.json(images);
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
}); 