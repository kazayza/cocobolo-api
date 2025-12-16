// Middleware للتعامل مع الأخطاء
function globalErrorHandler(err, req, res, next) {
  // طباعة الخطأ في الـ console للتتبع
  console.error('❌ خطأ:', err.message);
  console.error('📍 المسار:', req.path);
  console.error('📋 التفاصيل:', err.stack);

  // تحديد نوع الخطأ والرد المناسب
  const statusCode = err.statusCode || 500;
  const message = err.message || 'حدث خطأ في السيرفر';

  return res.status(statusCode).json({
    success: false,
    message: message,
    error: process.env.NODE_ENV === 'development' ? err.stack : null
  });
}

// Middleware للتعامل مع الـ routes غير الموجودة
function notFoundHandler(req, res, next) {
  return res.status(404).json({
    success: false,
    message: `المسار غير موجود: ${req.originalUrl}`
  });
}

// دالة لإنشاء خطأ مخصص
function createError(message, statusCode = 500) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

// تصدير الدوال
module.exports = {
  globalErrorHandler,
  notFoundHandler,
  createError
};