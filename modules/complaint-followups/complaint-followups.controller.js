const followUpsQueries = require('./complaint-followups.queries');
const complaintsQueries = require('../complaints/complaints.queries');
const { successResponse, errorResponse, notFoundResponse } = require('../../shared/response.helper');

// ===================================
// جلب متابعات شكوى
// ===================================
async function getByComplaintId(req, res) {
  try {
    const { complaintId } = req.params;

    const numericId = parseInt(complaintId, 10);
    if (isNaN(numericId)) {
      return errorResponse(res, 'معرف الشكوى غير صالح', 400);
    }

    // التحقق من وجود الشكوى
    const complaintExists = await complaintsQueries.checkComplaintExists(numericId);
    if (!complaintExists) {
      return notFoundResponse(res, 'الشكوى غير موجودة');
    }

    const followUps = await followUpsQueries.getFollowUpsByComplaintId(numericId);
    return res.json(followUps);

  } catch (err) {
    console.error('خطأ في جلب المتابعات:', err);
    return errorResponse(res, 'فشل تحميل المتابعات', 500, err.message);
  }
}

// ===================================
// إضافة متابعة جديدة
// ===================================
async function create(req, res) {
  try {
    const { complaintId } = req.params;
    const { notes, actionTaken, nextFollowUpDate } = req.body;

    const numericId = parseInt(complaintId, 10);
    if (isNaN(numericId)) {
      return errorResponse(res, 'معرف الشكوى غير صالح', 400);
    }

    // التحقق من وجود الشكوى
    const complaintExists = await complaintsQueries.checkComplaintExists(numericId);
    if (!complaintExists) {
      return notFoundResponse(res, 'الشكوى غير موجودة');
    }

    // التحقق من الحقول المطلوبة
    if (!notes) {
      return errorResponse(res, 'ملخص المتابعة مطلوب', 400);
    }

    if (!req.body.followUpBy) {
      return errorResponse(res, 'معرف الموظف المسجل مطلوب', 400);
    }

    const followUpData = {
      complaintId: numericId,
      followUpBy: req.body.followUpBy,
      notes,
      actionTaken: actionTaken || null,
      nextFollowUpDate: nextFollowUpDate || null,
      followUpDate: new Date()
    };

    const followUpId = await followUpsQueries.createFollowUp(followUpData);

    return res.json({
      success: true,
      followUpId: followUpId,
      message: 'تم إضافة المتابعة بنجاح'
    });

  } catch (err) {
    console.error('خطأ في إضافة المتابعة:', err);
    return errorResponse(res, 'فشل إضافة المتابعة', 500, err.message);
  }
}

// ===================================
// تعديل متابعة
// ===================================
async function update(req, res) {
  try {
    const { id } = req.params;
    const updateData = req.body;

    const numericId = parseInt(id, 10);
    if (isNaN(numericId)) {
      return errorResponse(res, 'معرف المتابعة غير صالح', 400);
    }

    const exists = await followUpsQueries.checkFollowUpExists(numericId);
    if (!exists) {
      return notFoundResponse(res, 'المتابعة غير موجودة');
    }

    await followUpsQueries.updateFollowUp(numericId, updateData);

    return res.json({
      success: true,
      message: 'تم تعديل المتابعة بنجاح'
    });

  } catch (err) {
    console.error('خطأ في تعديل المتابعة:', err);
    return errorResponse(res, 'فشل تعديل المتابعة', 500, err.message);
  }
}

// ===================================
// حذف متابعة
// ===================================
async function remove(req, res) {
  try {
    const { id } = req.params;

    const numericId = parseInt(id, 10);
    if (isNaN(numericId)) {
      return errorResponse(res, 'معرف المتابعة غير صالح', 400);
    }

    const exists = await followUpsQueries.checkFollowUpExists(numericId);
    if (!exists) {
      return notFoundResponse(res, 'المتابعة غير موجودة');
    }

    await followUpsQueries.deleteFollowUp(numericId);

    return res.json({
      success: true,
      message: 'تم حذف المتابعة بنجاح'
    });

  } catch (err) {
    console.error('خطأ في حذف المتابعة:', err);
    return errorResponse(res, 'فشل حذف المتابعة', 500, err.message);
  }
}

module.exports = {
  getByComplaintId,
  create,
  update,
  remove
};