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

// جلب سجل التفاعلات لفرصة
async function getByOpportunityId(req, res) {
  try {
    const { id } = req.params;
    const interactions = await interactionsQueries.getInteractionsByOpportunityId(id);
    return res.json(interactions);
  } catch (err) {
    console.error('خطأ في جلب سجل التفاعلات:', err);
    return errorResponse(res, 'فشل تحميل السجل', 500, err.message);
  }
}


// تصدير الدوال
module.exports = {
  create,
  getByOpportunityId // <--- ضيف دي
};