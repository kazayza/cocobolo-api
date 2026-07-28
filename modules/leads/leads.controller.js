const leadsQueries = require('./leads.queries');
const { successResponse, errorResponse } = require('../../shared/response.helper');

// جلب كل الـ Leads
async function getAll(req, res) {
  try {
    const leads = await leadsQueries.getLeads(req.query);
    return res.json(leads);
  } catch (err) {
    console.error('خطأ في جلب الـ Leads:', err);
    return errorResponse(res, 'فشل تحميل العملاء المحتملين', 500, err.message);
  }
}

// جلب تفاصيل Lead برقم الـ ID
async function getById(req, res) {
  try {
    const lead = await leadsQueries.getLeadById(req.params.id);
    if (!lead) {
      return errorResponse(res, 'العميل المحتمل غير موجود', 404);
    }
    return res.json(lead);
  } catch (err) {
    console.error('خطأ في جلب تفاصيل الـ Lead:', err);
    return errorResponse(res, 'فشل جلب تفاصيل العميل', 500, err.message);
  }
}

// تحديث حالة أو بيانات الـ Lead
async function update(req, res) {
  try {
    await leadsQueries.updateLead(req.params.id, req.body);
    return successResponse(res, null, 'تم تحديث بيانات العميل المحتمل بنجاح');
  } catch (err) {
    console.error('خطأ في تحديث الـ Lead:', err);
    return errorResponse(res, 'فشل تحديث البيانات', 500, err.message);
  }
}

// تحويل الـ Lead إلى عميل رسمي (Party + Opportunity)
async function convertToClient(req, res) {
  try {
    const { userName } = req.body;
    const result = await leadsQueries.convertLeadToClient(req.params.id, req.body, userName || 'Admin');
    return successResponse(res, result, 'تم تحويل العميل المحتمل إلى عميل رسمي بنجاح 🎉');
  } catch (err) {
    console.error('خطأ في تحويل الـ Lead:', err);
    return errorResponse(res, 'فشل تحويل العميل المحتمل', 500, err.message);
  }
}

// جلب تفاعلات الـ Lead
async function getInteractions(req, res) {
  try {
    const interactions = await leadsQueries.getLeadInteractions(req.params.id);
    return res.json(interactions);
  } catch (err) {
    console.error('خطأ في جلب تفاعلات الـ Lead:', err);
    return errorResponse(res, 'فشل تحميل سجل التفاعلات', 500, err.message);
  }
}

// إضافة تفاعل جديد
async function addInteraction(req, res) {
  try {
    const { userName, notes } = req.body;
    if (!notes) {
      return errorResponse(res, 'محتوى التفاعل أو الملاحظة مطلوب', 400);
    }
    const interactionId = await leadsQueries.addLeadInteraction(req.params.id, req.body, userName || 'Admin');
    return successResponse(res, { interactionId }, 'تم تسجيل التفاعل بنجاح');
  } catch (err) {
    console.error('خطأ في إضافة التفاعل:', err);
    return errorResponse(res, 'فشل تسجيل التفاعل', 500, err.message);
  }
}

module.exports = {
  getAll,
  getById,
  update,
  convertToClient,
  getInteractions,
  addInteraction
};