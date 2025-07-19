const express = require('express');
const multer = require('multer');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;
const { nanoid } = require('nanoid');
const fs = require('fs');

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
app.post('/upload', upload.single('image'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }
  // Generate unique ID
  const id = nanoid(8);
  imageMap[id] = req.file.filename;
  // Return short link
  const imageUrl = `/img/${id}`;
  res.json({ url: imageUrl });
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

// New: Static file service for frontend
app.use(express.static(__dirname));

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
}); 