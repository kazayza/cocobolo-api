// دالة للرد الناجح
function successResponse(res, data = null, message = 'تمت العملية بنجاح', statusCode = 200) {
  return res.status(statusCode).json({
    success: true,
    message: message,
    data: data
  });
}

// دالة للرد بخطأ
function errorResponse(res, message = 'حدث خطأ', statusCode = 500, error = null) {
  return res.status(statusCode).json({
    success: false,
    message: message,
    error: error
  });
}

// دالة للرد بعدم وجود البيانات
function notFoundResponse(res, message = 'البيانات غير موجودة') {
  return res.status(404).json({
    success: false,
    message: message,
    data: null
  });
}

// دالة للرد بخطأ في الصلاحيات
function unauthorizedResponse(res, message = 'غير مصرح لك بهذا الإجراء') {
  return res.status(401).json({
    success: false,
    message: message
  });
}

// تصدير الدوال
module.exports = {
  successResponse,
  errorResponse,
  notFoundResponse,
  unauthorizedResponse
};