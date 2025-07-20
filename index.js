const express = require('express');
const multer = require('multer');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;
const { nanoid } = require('nanoid');
const fs = require('fs');
const convert = require('heic-convert');
const sharp = require('sharp');

// Rate limiting storage
const rateLimitStore = new Map();

// Rate limiting configuration
const RATE_LIMITS = {
  perMinute: 15,   // 每分钟最多15次上传
  perHour: 100,    // 每小时最多100次上传
  perDay: 150,     // 每天最多150次上传
  hourlySize: 50 * 1024 * 1024  // 每小时累计文件大小不超过50MB
};

// Rate limiting middleware
function rateLimitMiddleware(req, res, next) {
  const clientIP = req.ip || req.connection.remoteAddress || req.socket.remoteAddress || req.connection.socket?.remoteAddress || 'unknown';
  
  // Get or create rate limit data for this IP
  if (!rateLimitStore.has(clientIP)) {
    rateLimitStore.set(clientIP, {
      uploads: [],
      violations: 0,
      blockedUntil: null
    });
  }
  
  const rateData = rateLimitStore.get(clientIP);
  const now = Date.now();
  
  // Check if IP is blocked
  if (rateData.blockedUntil && now < rateData.blockedUntil) {
    const remainingTime = Math.ceil((rateData.blockedUntil - now) / 1000 / 60);
    return res.status(429).json({ 
      error: `Rate limit exceeded. Please try again in ${remainingTime} minutes.`,
      blockedUntil: rateData.blockedUntil
    });
  }
  
  // Clean old upload records (older than 24 hours)
  rateData.uploads = rateData.uploads.filter(upload => now - upload.timestamp < 24 * 60 * 60 * 1000);
  
  // Check limits
  const minuteUploads = rateData.uploads.filter(upload => now - upload.timestamp < 60 * 1000);
  const hourUploads = rateData.uploads.filter(upload => now - upload.timestamp < 60 * 60 * 1000);
  const dayUploads = rateData.uploads.filter(upload => now - upload.timestamp < 24 * 60 * 60 * 1000);
  
  const hourlySize = hourUploads.reduce((total, upload) => total + upload.size, 0);
  
  // Check violations
  let violation = false;
  let violationMessage = '';
  
  if (minuteUploads.length >= RATE_LIMITS.perMinute) {
    violation = true;
    violationMessage = 'Too many uploads per minute. Please wait before uploading again.';
  } else if (hourUploads.length >= RATE_LIMITS.perHour) {
    violation = true;
    violationMessage = 'Hourly upload limit reached. Please try again later.';
  } else if (dayUploads.length >= RATE_LIMITS.perDay) {
    violation = true;
    violationMessage = 'Daily upload limit reached. Please try again tomorrow.';
  } else if (hourlySize >= RATE_LIMITS.hourlySize) {
    violation = true;
    violationMessage = 'Hourly file size limit reached. Please try again later.';
  }
  
  if (violation) {
    rateData.violations++;
    
    // Progressive punishment
    let blockDuration = 0;
    if (rateData.violations === 1) {
      blockDuration = 5 * 60 * 1000; // 5 minutes
    } else if (rateData.violations === 2) {
      blockDuration = 15 * 60 * 1000; // 15 minutes
    } else if (rateData.violations === 3) {
      blockDuration = 60 * 60 * 1000; // 1 hour
    } else {
      blockDuration = 24 * 60 * 60 * 1000; // 24 hours
    }
    
    rateData.blockedUntil = now + blockDuration;
    
    console.log(`Rate limit violation for IP ${clientIP}: ${violationMessage}. Blocked for ${blockDuration/1000/60} minutes.`);
    
    return res.status(429).json({ 
      error: violationMessage,
      blockedUntil: rateData.blockedUntil,
      violations: rateData.violations
    });
  }
  
  // Add upload record (will be populated in upload endpoint)
  req.rateLimitData = rateData;
  req.clientIP = clientIP;
  
  next();
}

// Clean up old rate limit data periodically (every hour)
setInterval(() => {
  const now = Date.now();
  const oneDayAgo = now - 24 * 60 * 60 * 1000;
  
  for (const [ip, data] of rateLimitStore.entries()) {
    // Remove old upload records
    data.uploads = data.uploads.filter(upload => upload.timestamp > oneDayAgo);
    
    // Remove IP if no recent activity and not blocked
    if (data.uploads.length === 0 && (!data.blockedUntil || now > data.blockedUntil)) {
      rateLimitStore.delete(ip);
    }
  }
  
  console.log(`Rate limit cleanup: ${rateLimitStore.size} active IPs`);
}, 60 * 60 * 1000); // Run every hour

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
app.post('/upload', rateLimitMiddleware, upload.single('image'), async (req, res) => {
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
  
  // Record upload activity for rate limiting
  if (req.rateLimitData) {
    req.rateLimitData.uploads.push({
      timestamp: Date.now(),
      size: req.file.size,
      filename: outputFilename
    });
    
    // Reset violations on successful upload
    req.rateLimitData.violations = 0;
    req.rateLimitData.blockedUntil = null;
  }
  
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

// Rate limit status endpoint (for debugging)
app.get('/api/rate-limit-status', (req, res) => {
  const clientIP = req.ip || req.connection.remoteAddress || req.socket.remoteAddress || req.connection.socket?.remoteAddress || 'unknown';
  const rateData = rateLimitStore.get(clientIP);
  
  if (!rateData) {
    return res.json({
      ip: clientIP,
      status: 'No rate limit data',
      limits: RATE_LIMITS
    });
  }
  
  const now = Date.now();
  const minuteUploads = rateData.uploads.filter(upload => now - upload.timestamp < 60 * 1000);
  const hourUploads = rateData.uploads.filter(upload => now - upload.timestamp < 60 * 60 * 1000);
  const dayUploads = rateData.uploads.filter(upload => now - upload.timestamp < 24 * 60 * 60 * 1000);
  const hourlySize = hourUploads.reduce((total, upload) => total + upload.size, 0);
  
  res.json({
    ip: clientIP,
    status: {
      isBlocked: rateData.blockedUntil && now < rateData.blockedUntil,
      blockedUntil: rateData.blockedUntil,
      violations: rateData.violations,
      uploads: {
        lastMinute: minuteUploads.length,
        lastHour: hourUploads.length,
        lastDay: dayUploads.length,
        hourlySize: hourlySize
      }
    },
    limits: RATE_LIMITS
  });
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
}); 