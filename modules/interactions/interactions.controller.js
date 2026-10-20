const interactionsQueries = require('./interactions.queries');
const { successResponse, errorResponse } = require('../../shared/response.helper');

// تسجيل تواصل جديد - مع منع إغلاق مباشر لغير المصرح
async function create(req, res) {
  try {
    const { isNewClient, clientName, partyId, stageId } = req.body;
    const authenticatedUsername = req.auth?.username || req.user?.Username;
    const createdBy = authenticatedUsername || req.body.createdBy;
    const actorRole = req.auth?.role || req.user?.Role || req.body.actorRole || req.headers['x-user-role'];

    if (isNewClient && !String(clientName || '').trim()) {
      return errorResponse(res, 'اسم العميل مطلوب', 400);
    }

    if (!isNewClient && !partyId) {
      return errorResponse(res, 'يجب اختيار عميل', 400);
    }

    if (!createdBy) {
      return errorResponse(res, 'اسم المستخدم مطلوب', 400);
    }

    // مرحلتا الخسارة/غير مهتم فقط تحتاجان موافقة لغير الإدارة.
    // Stage 3 (تم البيع) إغلاق مباشر لجميع المستخدمين المصرح لهم.
    const requiresClosureApproval = stageId == 4 || stageId == 5;
    if (requiresClosureApproval) {
      const roleNorm = String(actorRole || '')
        .toLowerCase()
        .replace(/[\s_-]+/g, '');
      const canDirect = ['admin', 'salesmanager', 'generalmanager', 'gm', 'general'].includes(roleNorm);
      if (!canDirect) {
        return res.json({
          success: false,
          requiresApproval: true,
          needsClosureRequest: true,
          message: 'تحويل الفرصة إلى خسارة أو غير مهتم يحتاج موافقة الإدارة.',
        });
      }
    }

    const result = await interactionsQueries.createInteraction({
      ...req.body,
      createdBy,
      actorRole,
    });

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