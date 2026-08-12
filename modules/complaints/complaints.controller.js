const complaintsQueries = require('./complaints.queries');
const { successResponse, errorResponse, notFoundResponse } = require('../../shared/response.helper');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// ===================================
// رفع المرفقات (نفس امتدادات بلازور)
// ===================================
const UPLOAD_FOLDER = 'uploads/complaints';
const ALLOWED_EXT = ['.jpg', '.jpeg', '.png', '.gif', '.pdf', '.doc', '.docx', '.xlsx', '.xls'];
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB زي بلازور بالظبط

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (!ALLOWED_EXT.includes(ext)) {
      return cb(new Error('صيغة الملف غير مدعومة'));
    }
    cb(null, true);
  }
}).single('file');

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
      escalated: req.query.escalated,
      search: req.query.search,
      dateFrom: req.query.dateFrom,
      dateTo: req.query.dateTo,
      openOnly: req.query.openOnly,
      partyId: req.query.partyId
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
      escalatedDate: getEgyptTime(),
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
// 📊 إحصائيات الشكاوى
// ===================================
async function getStats(req, res) {
  try {
    const stats = await complaintsQueries.getComplaintStats(req.query);
    return res.json({ success: true, data: stats });
  } catch (err) {
    console.error('خطأ في جلب الإحصائيات:', err);
    return errorResponse(res, 'فشل جلب الإحصائيات', 500, err.message);
  }
}

// ===================================
// 👤 إسناد شكوى لموظف
// ===================================
async function assign(req, res) {
  try {
    const { id } = req.params;
    const { assignedTo, updatedBy } = req.body;
    await complaintsQueries.assignComplaint(id, assignedTo, updatedBy || req.headers['x-user']);
    return res.json({ success: true, message: 'تم إسناد الشكوى بنجاح' });
  } catch (err) {
    console.error('خطأ في إسناد الشكوى:', err);
    return errorResponse(res, 'فشل إسناد الشكوى', 500, err.message);
  }
}

// ===================================
// 🔄 تغيير حالة الشكوى (مع الحل)
// ===================================
async function changeStatus(req, res) {
  try {
    const { id } = req.params;
    const { newStatus, solution, updatedBy } = req.body;
    if (!newStatus) return errorResponse(res, 'الحالة الجديدة مطلوبة', 400);
    await complaintsQueries.changeComplaintStatus(id, newStatus, solution, updatedBy || req.headers['x-user']);
    return res.json({ success: true, message: 'تم تحديث حالة الشكوى بنجاح' });
  } catch (err) {
    console.error('خطأ في تغيير الحالة:', err);
    return errorResponse(res, 'فشل تغيير الحالة', 500, err.message);
  }
}

// ===================================
// ⭐ تقييم رضا العميل
// ===================================
async function rate(req, res) {
  try {
    const { id } = req.params;
    const { satisfactionLevel, updatedBy } = req.body;
    if (!satisfactionLevel) return errorResponse(res, 'التقييم مطلوب', 400);
    await complaintsQueries.rateComplaint(id, satisfactionLevel, updatedBy || req.headers['x-user']);
    return res.json({ success: true, message: 'تم تسجيل التقييم بنجاح' });
  } catch (err) {
    console.error('خطأ في تسجيل التقييم:', err);
    return errorResponse(res, 'فشل تسجيل التقييم', 500, err.message);
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
  escalate,
  getStats,
  assign,
  changeStatus,
  rate,
  upload,
  getAttachments,
  uploadAttachment,
  getAttachmentFile,
  deleteAttachment
};

// ═══════════════════════════════════════════════
// 📎 المرفقات (مطابقة لبلازور: رفع/عرض/حذف)
// ═══════════════════════════════════════════════

// جلب مرفقات شكوى
async function getAttachments(req, res) {
  try {
    const { complaintId } = req.params;
    const exists = await complaintsQueries.checkComplaintExists(complaintId);
    if (!exists) return notFoundResponse(res, 'الشكوى غير موجودة');

    const attachments = await complaintsQueries.getComplaintAttachments(complaintId);
    return res.json(attachments.map(a => ({
      ...a,
      IsImage: (a.MimeType || '').toLowerCase().startsWith('image/'),
      FileSizeFormatted: formatFileSize(a.FileSize)
    })));
  } catch (err) {
    console.error('خطأ في جلب المرفقات:', err);
    return errorResponse(res, 'فشل جلب المرفقات', 500, err.message);
  }
}

// رفع مرفق جديد
async function uploadAttachment(req, res) {
  try {
    const { complaintId } = req.params;
    const exists = await complaintsQueries.checkComplaintExists(complaintId);
    if (!exists) return notFoundResponse(res, 'الشكوى غير موجودة');

    if (!req.file) return errorResponse(res, 'الملف مطلوب', 400);
    if (req.file.size === 0) return errorResponse(res, 'الملف فارغ', 400);
    if (req.file.size > MAX_FILE_SIZE) return errorResponse(res, 'الحجم يتجاوز 10 ميجا', 400);

    const ext = path.extname(req.file.originalname).toLowerCase();
    const safeName = `${require('crypto').randomBytes(16).toString('hex')}${ext}`;
    const filePath = `/${UPLOAD_FOLDER}/${safeName}`;

    // 🗂️ نحفظ الملف على قرص السيرفر (من غير أي عمود جديد في الداتابيز)
    try {
      const localDir = path.join(process.cwd(), UPLOAD_FOLDER);
      fs.mkdirSync(localDir, { recursive: true });
      fs.writeFileSync(path.join(localDir, safeName), req.file.buffer);
    } catch (localErr) {
      return errorResponse(res, 'فشل حفظ الملف على السيرفر', 500, localErr.message);
    }

    const attachmentId = await complaintsQueries.insertComplaintAttachment({
      complaintId: Number(complaintId),
      fileName: safeName,
      originalFileName: req.file.originalname,
      filePath,
      fileSize: req.file.size,
      mimeType: req.file.mimetype || 'application/octet-stream',
      uploadedByUserId: req.body.uploadedByUserId || null
    });

    return res.json({
      success: true,
      attachmentId,
      message: 'تم رفع المرفق بنجاح'
    });
  } catch (err) {
    console.error('خطأ في رفع المرفق:', err);
    if (err.message === 'صيغة الملف غير مدعومة') {
      return errorResponse(res, 'صيغة الملف غير مدعومة (المسموح: صور، PDF، Word، Excel)', 400);
    }
    if (err.code === 'LIMIT_FILE_SIZE') {
      return errorResponse(res, 'الحجم يتجاوز 10 ميجا', 400);
    }
    return errorResponse(res, 'فشل رفع المرفق', 500, err.message);
  }
}

// تشغيل/تحميل المرفق: من قرص السيرفر الأول، وبعدين من سيرفر بلازور
async function getAttachmentFile(req, res) {
  try {
    const { attachmentId } = req.params;
    const att = await complaintsQueries.getComplaintAttachment(attachmentId);
    if (!att) return notFoundResponse(res, 'المرفق غير موجود');

    const mime = att.MimeType || 'application/octet-stream';
    const filename = encodeURIComponent(att.OriginalFileName || 'file');
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${filename}`);

    // 1️⃣ ملف محلي على نفس السيرفر (المرفوع من الموبايل)
    const localPath = path.join(process.cwd(), att.FilePath.replace(/^\//, ''));
    if (fs.existsSync(localPath)) {
      return res.sendFile(localPath);
    }

    // 2️⃣ الملف على سيرفر بلازور (المرفوع من الويب) — نعمل Proxy
    const upstreamUrl = `https://cocobolo.runasp.net${att.FilePath}`;
    const upstreamRes = await fetch(upstreamUrl);
    if (!upstreamRes.ok) {
      return errorResponse(res, 'الملف غير متاح', 404);
    }
    const buffer = Buffer.from(await upstreamRes.arrayBuffer());
    return res.send(buffer);
  } catch (err) {
    console.error('خطأ في تشغيل المرفق:', err);
    return errorResponse(res, 'فشل تشغيل المرفق', 500, err.message);
  }
}

// حذف مرفق
async function deleteAttachment(req, res) {
  try {
    const { complaintId, attachmentId } = req.params;
    const exists = await complaintsQueries.checkComplaintExists(complaintId);
    if (!exists) return notFoundResponse(res, 'الشكوى غير موجودة');

    const deleted = await complaintsQueries.deleteComplaintAttachment(attachmentId);
    if (!deleted) return notFoundResponse(res, 'المرفق غير موجود');

    // نشيل النسخة المحلية لو موجودة
    try {
      const localPath = path.join(process.cwd(), deleted.FilePath.replace(/^\//, ''));
      if (fs.existsSync(localPath)) fs.unlinkSync(localPath);
    } catch (e) { /* مش مشكلة */ }

    return res.json({ success: true, message: 'تم حذف المرفق بنجاح' });
  } catch (err) {
    console.error('خطأ في حذف المرفق:', err);
    return errorResponse(res, 'فشل حذف المرفق', 500, err.message);
  }
}

// ===================================
// تنسيق حجم الملف (زي بلازور)
// ===================================
function formatFileSize(size) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  return `${(size / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}