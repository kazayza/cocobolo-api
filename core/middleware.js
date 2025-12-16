const cors = require('cors');
const express = require('express');

// دالة لتطبيق كل الـ middleware
function applyMiddleware(app) {
  // تفعيل CORS
  app.use(cors());

  // تفعيل JSON parsing مع زيادة الحد الأقصى للحجم
  app.use(express.json({ limit: '50mb' }));

  // تفعيل URL-encoded parsing
  app.use(express.urlencoded({ limit: '50mb', extended: true }));

  console.log('✅ Middleware تم تطبيقه بنجاح');
}

// تصدير الدالة
module.exports = {
  applyMiddleware
};