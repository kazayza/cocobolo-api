const interactionsQueries = require('./interactions.queries');
const { successResponse, errorResponse } = require('../../shared/response.helper');

// تسجيل تواصل جديد
async function create(req, res) {
  try {
    const { isNewClient, clientName, partyId, createdBy } = req.body;

    // التحقق من البيانات
    if (isNewClient && !clientName) {
      return errorResponse(res, 'اسم العميل مطلوب', 400);
    }

    if (!isNewClient && !partyId) {
      return errorResponse(res, 'يجب اختيار عميل', 400);
    }

    if (!createdBy) {
      return errorResponse(res, 'اسم المستخدم مطلوب', 400);
    }

    const result = await interactionsQueries.createInteraction(req.body);

    return res.json({
      success: true,
      data: result,
      message: 'تم تسجيل التواصل بنجاح'
    });
  } catch (err) {
    console.error('خطأ في تسجيل التواصل:', err);
    return errorResponse(res, 'فشل تسجيل التواصل', 500, err.message);
  }
}

// تصدير الدوال
module.exports = {
  create
};