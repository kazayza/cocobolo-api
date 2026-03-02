const complaintsQueries = require('./complaints.queries');
const { successResponse, errorResponse, notFoundResponse } = require('../../shared/response.helper');

// ===================================
// دوال مساعدة لضبط الوقت بتوقيت مصر
// ===================================
function getEgyptTime() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Africa/Cairo' }));
}

function getEgyptDateOnly() {
  const now = new Date();
  const egyptTime = new Date(now.toLocaleString('en-US', { timeZone: 'Africa/Cairo' }));
  return new Date(egyptTime.getFullYear(), egyptTime.getMonth(), egyptTime.getDate());
}

// ===================================
// إنشاء شكوى جديدة
// ===================================
async function create(req, res) {
  try {
    const {
      partyId,
      opportunityId,
      typeId,
      subject,
      details,
      priority,
      status,
      assignedTo,
      complaintDate  // 👈 تمت الإضافة هنا
    } = req.body;

    // التحقق من الحقول المطلوبة
    if (!partyId) {
      return errorResponse(res, 'معرف العميل مطلوب', 400);
    }

    if (!typeId) {
      return errorResponse(res, 'نوع الشكوى مطلوب', 400);
    }

    if (!subject) {
      return errorResponse(res, 'عنوان الشكوى مطلوب', 400);
    }

    if (!details) {
      return errorResponse(res, 'تفاصيل الشكوى مطلوبة', 400);
    }

    if (!priority) {
      return errorResponse(res, 'الأولوية مطلوبة', 400);
    }

    // تجهيز البيانات للإضافة
    const complaintData = {
      partyId,
      opportunityId: opportunityId || null,
      typeId,
      subject,
      details,
      priority,
      status: status || 1, // 1 = جديدة
      assignedTo: assignedTo || null,
      complaintDate: complaintDate || getEgyptDateOnly(), // 👈 استخدام التاريخ المرسل أو تاريخ اليوم
      createdBy: req.body.createdBy || req.user?.Username || req.user?.FullName || 'System',
      createdAt: getEgyptTime()
    };

    // إضافة الشكوى
    const complaintId = await complaintsQueries.createComplaint(complaintData);

    return res.json({
      success: true,
      complaintId: complaintId,
      message: 'تم إضافة الشكوى بنجاح'
    });

  } catch (err) {
    console.error('خطأ في إضافة الشكوى:', err);
    return errorResponse(res, 'فشل إضافة الشكوى', 500, err.message);
  }
}

// ===================================
// جلب كل الشكاوى
// ===================================
async function getAll(req, res) {
  try {
    const filters = {
      status: req.query.status,
      priority: req.query.priority,
      typeId: req.query.typeId,
      assignedTo: req.query.assignedTo,
      escalated: req.query.escalated
    };

    const complaints = await complaintsQueries.getAllComplaints(filters);
    return res.json(complaints);

  } catch (err) {
    console.error('خطأ في جلب الشكاوى:', err);
    return errorResponse(res, 'فشل تحميل الشكاوى', 500, err.message);
  }
}

// ===================================
// جلب شكوى واحدة بالـ ID
// ===================================
async function getById(req, res) {
  try {
    const { id } = req.params;

    // التحقق من صحة الرقم
    const numericId = parseInt(id, 10);
    if (isNaN(numericId)) {
      return errorResponse(res, 'معرف الشكوى غير صالح', 400);
    }

    const complaint = await complaintsQueries.getComplaintById(numericId);

    if (!complaint) {
      return notFoundResponse(res, 'الشكوى غير موجودة');
    }

    return res.json(complaint);

  } catch (err) {
    console.error('خطأ في جلب تفاصيل الشكوى:', err);
    return errorResponse(res, 'فشل تحميل بيانات الشكوى', 500, err.message);
  }
}

// ===================================
// تعديل شكوى
// ===================================
async function update(req, res) {
  try {
    const { id } = req.params;
    const updateData = req.body;

    // التحقق من وجود الشكوى
    const exists = await complaintsQueries.checkComplaintExists(id);
    if (!exists) {
      return notFoundResponse(res, 'الشكوى غير موجودة');
    }

    // تعديل الشكوى
    await complaintsQueries.updateComplaint(id, updateData);

    return res.json({
      success: true,
      message: 'تم تعديل الشكوى بنجاح'
    });

  } catch (err) {
    console.error('خطأ في تعديل الشكوى:', err);
    return errorResponse(res, 'فشل تعديل الشكوى', 500, err.message);
  }
}

// ===================================
// حذف شكوى
// ===================================
async function remove(req, res) {
  try {
    const { id } = req.params;

    // التحقق من وجود الشكوى
    const exists = await complaintsQueries.checkComplaintExists(id);
    if (!exists) {
      return notFoundResponse(res, 'الشكوى غير موجودة');
    }

    // حذف الشكوى
    await complaintsQueries.deleteComplaint(id);

    return res.json({
      success: true,
      message: 'تم حذف الشكوى بنجاح'
    });

  } catch (err) {
    console.error('خطأ في حذف الشكوى:', err);
    return errorResponse(res, 'فشل حذف الشكوى', 500, err.message);
  }
}

// ===================================
// جلب أنواع الشكاوى
// ===================================
async function getTypes(req, res) {
  try {
    const types = await complaintsQueries.getComplaintTypes();
    return res.json(types);

  } catch (err) {
    console.error('خطأ في جلب أنواع الشكاوى:', err);
    return errorResponse(res, 'فشل تحميل أنواع الشكاوى', 500, err.message);
  }
}

// ===================================
// تصعيد شكوى
// ===================================
async function escalate(req, res) {
  try {
    const { id } = req.params;
    const { escalatedTo, reason } = req.body;

    if (!escalatedTo) {
      return errorResponse(res, 'يجب تحديد الموظف المراد التصعيد إليه', 400);
    }

    if (!reason) {
      return errorResponse(res, 'سبب التصعيد مطلوب', 400);
    }

    // التحقق من وجود الشكوى
    const exists = await complaintsQueries.checkComplaintExists(id);
    if (!exists) {
      return notFoundResponse(res, 'الشكوى غير موجودة');
    }

    const escalateData = {
      escalated: true,
      escalatedTo,
      escalatedBy: req.user?.employeeID || null,
      escalatedAt: getEgyptTime(),
      escalationReason: reason,
      status: 6 // 6 = مصعدة
    };

    await complaintsQueries.updateComplaint(id, escalateData);

    return res.json({
      success: true,
      message: 'تم تصعيد الشكوى بنجاح'
    });

  } catch (err) {
    console.error('خطأ في تصعيد الشكوى:', err);
    return errorResponse(res, 'فشل تصعيد الشكوى', 500, err.message);
  }
}

// ===================================
// تصدير الدوال
// ===================================
module.exports = {
  create,
  getAll,
  getById,
  update,
  remove,
  getTypes,
  escalate
};