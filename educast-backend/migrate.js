const crypto = require('crypto');
if (!global.crypto) global.crypto = crypto.webcrypto;
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const mongoose = require('mongoose');
const libre = require('libreoffice-convert');

const convertAsync = promisify(libre.convert);
const MONGODB_URI = 'mongodb://localhost:27017/educast';

const courseSchema = new mongoose.Schema({}, { strict: false });
const Course = mongoose.model('Course', courseSchema, 'courses');

const librePath = 'C:\\Program Files\\LibreOffice\\program\\soffice.exe';
if (fs.existsSync(librePath)) {
  process.env.SOFFICE_PATH = librePath;
}

async function run() {
  await mongoose.connect(MONGODB_URI);
  console.log('Connected to MongoDB.');

  const courses = await Course.find({
    sourceFileUrl: { $regex: /\.(pptx|docx)$/i }
  });

  console.log(`Found ${courses.length} courses with .pptx or .docx files.`);

  for (const course of courses) {
    const fileUrl = course.get('sourceFileUrl');
    const ext = path.extname(fileUrl);
    const basename = path.basename(fileUrl);
    const filePath = path.join(__dirname, 'uploads', basename);

    console.log(`\nProcessing: ${basename}`);

    if (!fs.existsSync(filePath)) {
      console.log(`File not found: ${filePath}, skipping.`);
      continue;
    }

    try {
      const fileBuffer = fs.readFileSync(filePath);
      console.log(`Converting ${basename} to PDF...`);
      
      const pdfBuf = await convertAsync(fileBuffer, '.pdf', undefined);
      
      const newBasename = basename.replace(new RegExp(`\\${ext}$`, 'i'), '.pdf');
      const newFilePath = path.join(__dirname, 'uploads', newBasename);
      
      fs.writeFileSync(newFilePath, pdfBuf);
      console.log(`Saved new PDF to ${newFilePath}`);
      
      // Update DB
      const newUrl = `/uploads/${newBasename}`;
      await Course.updateOne(
        { _id: course._id },
        { $set: { sourceFileUrl: newUrl } }
      );
      console.log(`Updated course in DB with new URL: ${newUrl}`);

      // Optional: Delete old file
      // fs.unlinkSync(filePath);
    } catch (err) {
      console.error(`Error processing ${basename}:`, err);
    }
  }

  console.log('\nMigration complete.');
  await mongoose.disconnect();
}

run().catch(console.error);
