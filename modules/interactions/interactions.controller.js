const interactionsQueries = require('./interactions.queries');
const { successResponse, errorResponse } = require('../../shared/response.helper');

// تسجيل تواصل جديد - مع منع إغلاق مباشر لغير المصرح
async function create(req, res) {
  try {
    const { isNewClient, clientName, partyId, createdBy, stageId, actorRole } = req.body;

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

    // ── منع إغلاق مباشر (بيع/خسارة) لغير GM/SalesManager/Admin - إنشاء طلب موافقة مع إشعار ──
    const isClosure = stageId == 3 || stageId == 4 || stageId == 5;
    if (isClosure) {
      const roleNorm = (actorRole || req.headers['x-user-role'] || '').toString().toLowerCase().replace(/\s+/g, '').replace(/_/g, '');
      const canDirect = roleNorm === 'admin' || roleNorm === 'salesmanager' || roleNorm === 'generalmanager' || roleNorm === 'gm' || roleNorm === 'general';
      if (!canDirect && roleNorm) {
        // بدل المنع، ننشئ طلب موافقة إغلاق مع إشعار للـ GM
        try {
          const opportunitiesQueries = require('../opportunities/opportunities.queries');
          // للفرص الجديدة، نحتاج partyId أولا؟ نستخدم -1 مؤقتا وسينشأ الطلب بعد إنشاء الفرصة في queries
          // هنا نرجع requiresApproval ليقوم الفلاتر بإرسال طلب منفصل بعد الإنشاء
          return res.json({
            success: false,
            requiresApproval: true,
            needsClosureRequest: true,
            message: stageId == 3 ? 'إغلاق الفرصة كـ تم البيع يحتاج موافقة المدير العام أو مدير المبيعات - سيتم إرسال طلب' : 'تحويل الفرصة لخسارة/غير مهتم يحتاج موافقة المدير العام - سيتم إرسال طلب مع إشعار',
          });
        } catch (e) {
          console.error('closure check:', e.message);
        }
      }
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