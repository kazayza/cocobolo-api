const cors = require('cors');
const express = require('express');

// دالة لتطبيق كل الـ middleware
function applyMiddleware(app) {
  // تفعيل CORS — Phase 0: الأصول قابلة للضبط من البيئة عبر ALLOWED_ORIGINS
  // (قائمة مفصولة بفواصل). عند غيابها يبقى السلوك الحالي كما هو (مفتوح) حتى لا تنكسر
  // أي واجهة ويب قائمة؛ عملاء الموبايل الأصليون لا يتأثرون بـ CORS أصلًا.
  const allowedOrigins = String(process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  if (allowedOrigins.length) {
    app.use(cors({
      origin(origin, callback) {
        // طلبات بلا Origin (تطبيقات أصلية/أدوات خادم) مسموحة؛ المتصفح يجب أن يكون في القائمة.
        if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
        return callback(new Error(`CORS: origin not allowed: ${origin}`));
      },
    }));
    console.log(`✅ CORS مقيد على: ${allowedOrigins.join(', ')}`);
  } else {
    app.use(cors());
  }

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