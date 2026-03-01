const permissionsQueries = require('./permissions.queries');
const notificationsQueries = require('../notifications/notifications.queries');
const { getBioCodeByUserId } = require('../attendance/attendance.queries'); 
const { successResponse, errorResponse } = require('../../shared/response.helper');

// --- دوال مساعدة للإشعارات ---

// 🔔 إشعار للمديرين (طلب جديد)
async function notifyManagers(title, message, relatedId) {
  try {
    const roles = ['Admin', 'HR', 'AccountManager', 'SalesManager'];
    for (const role of roles) {
      await notificationsQueries.createNotificationSmart({
        title,
        message,
        createdBy: 'System',
        formName: 'frm_PermissionsList', // الشاشة اللي المدير هيفتحها
        relatedId
      }, role);
    }
  } catch (err) {
    console.error('Notify Managers Error:', err);
  }
}

// 🔔 إشعار للموظف (تم الرد)
async function notifyEmployee(targetUserId, title, message, relatedId) {
  try {
    // نفترض دالة createNotification تقبل UserID مباشرة
    // لو معندكش، استخدم المنطق المتاح في notificationsQueries
    await notificationsQueries.createNotificationSmart({
      title,
      message,
      createdBy: 'System',
      formName: 'frm_MyPermissions',
      relatedId
    }, null, targetUserId); // نبعت لليوزر ده تحديداً
  } catch (err) {
    console.error('Notify Employee Error:', err);
  }
}

// --- الدوال الرئيسية ---

// 1. تقديم طلب إذن
async function requestPermission(req, res) {
  try {
    const { userId, employeeId, permissionDate, type, reason, createdAt, fromTime, toTime } = req.body;

    // لو الموبايل مبعتش employeeId، نحاول نجيبه (اختياري)
    // بس الأفضل الموبايل يبعته لأنه مخزنه
    if (!employeeId) return errorResponse(res, 'رقم الموظف مطلوب', 400);

    const permissionId = await permissionsQueries.createPermission({
      employeeId,
      permissionDate,
      type,
      fromTime,
      toTime,
      reason,
      createdAt: createdAt || new Date()
    });

    // إرسال إشعار للمديرين
    await notifyManagers(
      'طلب إذن جديد 📩',
      `يوجد طلب إذن ${type} جديد، يرجى المراجعة.`,
      permissionId
    );

    return res.json({ success: true, message: 'تم إرسال الطلب بنجاح', permissionId });

  } catch (err) {
    console.error(err);
    return errorResponse(res, 'فشل إرسال الطلب', 500);
  }
}

// 2. عرض الطلبات
async function listPermissions(req, res) {
  try {
    const { role, status, employeeName, employeeId } = req.query;
    
    // تحديد الصلاحيات
    const managerRoles = ['Admin', 'HR', 'AccountManager', 'SalesManager'];
    const isManager = managerRoles.some(r => r.toLowerCase() === (role || '').toLowerCase());

    let filters = { status, employeeName };

    if (!isManager) {
      // موظف عادي -> يشوف طلباته بس
      filters.employeeId = employeeId;
    }

    const data = await permissionsQueries.getPermissionsList(filters);
    return res.json(data);

  } catch (err) {
    return errorResponse(res, 'فشل تحميل الطلبات', 500);
  }
}

// 3. اتخاذ إجراء (موافقة/رفض)
async function takeAction(req, res) {
  try {
    const { permissionId, status, comment, userId } = req.body;

    if (!['Approved', 'Rejected'].includes(status)) {
      return errorResponse(res, 'حالة غير صحيحة', 400);
    }

    // تنفيذ التحديث
    await permissionsQueries.updatePermissionStatus({ permissionId, status, comment, userId });
    
    // إشعار الموظف بالنتيجة
    const permDetails = await permissionsQueries.getPermissionById(permissionId);
    if (permDetails && permDetails.RequesterUserID) {
        const msg = status === 'Approved' ? 'تمت الموافقة على طلبك ✅' : 'تم رفض طلبك ❌';
        await notifyEmployee(
            permDetails.RequesterUserID, 
            'تحديث حالة الطلب', 
            msg, 
            permissionId
        );
    }

    return res.json({ success: true, message: 'تم تنفيذ الإجراء بنجاح' });

  } catch (err) {
    console.error(err);
    return errorResponse(res, 'فشل تنفيذ الإجراء', 500);
  }
}

module.exports = {
  requestPermission,
  listPermissions,
  takeAction
};