const authQueries = require('./auth.queries');
const { successResponse, errorResponse } = require('../../shared/response.helper');

// تسجيل الدخول
async function login(req, res) {
  try {
    const { username, password } = req.body;

    // التحقق من وجود البيانات
    if (!username || !password) {
      return errorResponse(res, 'اسم المستخدم وكلمة المرور مطلوبين', 400);
    }

    // البحث عن المستخدم
    const user = await authQueries.findUserByCredentials(username, password);

    if (!user) {
      return res.json({
        success: false,
        message: 'اسم المستخدم أو كلمة المرور غير صحيحة'
      });
    }

    // جلب الصلاحيات
    const permissionsResult = await authQueries.getUserPermissions(user.UserID);

    // تحويل الصلاحيات لـ object
    const permissions = {};
    permissionsResult.forEach(perm => {
      permissions[perm.FormName] = {
        permissionId: perm.PermissionID,
        permissionName: perm.PermissionName,
        category: perm.Category,
        canView: perm.CanView,
        canAdd: perm.CanAdd,
        canEdit: perm.CanEdit,
        canDelete: perm.CanDelete
      };
    });

    // إرجاع البيانات
    return res.json({
      success: true,
      user: user,
      permissions: permissions
    });

  } catch (err) {
    console.error('خطأ في تسجيل الدخول:', err);
    return errorResponse(res, 'خطأ في السيرفر', 500, err.message);
  }
}

// حفظ FCM Token
async function saveFcmToken(req, res) {
  try {
    const { userId, fcmToken } = req.body;

    // التحقق من وجود البيانات
    if (!userId || !fcmToken) {
      return errorResponse(res, 'userId و fcmToken مطلوبين', 400);
    }

    // حفظ التوكن
    await authQueries.saveFcmToken(userId, fcmToken);

    return successResponse(res, null, 'تم حفظ التوكن بنجاح');

  } catch (err) {
    console.error('خطأ في حفظ FCM Token:', err);
    return errorResponse(res, 'خطأ في السيرفر', 500, err.message);
  }
}

// جلب بيانات الموظف المرتبط بالمستخدم
async function getEmployeeByUserId(req, res) {
  try {
    const { userId } = req.params;

    const employee = await authQueries.getEmployeeByUserId(userId);

    return successResponse(res, employee || { employeeID: null, FullName: null });

  } catch (err) {
    console.error('خطأ في جلب الموظف:', err);
    return errorResponse(res, 'خطأ في السيرفر', 500, err.message);
  }
}

async function changePassword(req, res) {
  try {
    const { userId, currentPassword, newPassword } = req.body;

    if (!userId || !currentPassword || !newPassword) {
      return res.status(400).json({ success: false, message: 'بيانات ناقصة' });
    }

    // 1. التحقق من كلمة المرور الحالية
    const user = await authQueries.getUserById(userId);
    
    if (!user) {
      return res.status(404).json({ success: false, message: 'مستخدم غير موجود' });
    }

    // مقارنة مباشرة (بدون تشفير)
    if (user.Password !== currentPassword) {
      return res.status(400).json({ success: false, message: 'كلمة المرور الحالية غير صحيحة' });
    }

    // 2. تحديث كلمة المرور
    await authQueries.updateUserPassword(userId, newPassword);

    return res.json({ success: true, message: 'تم تغيير كلمة المرور بنجاح' });

  } catch (err) {
    console.error('Change Password Error:', err);
    return res.status(500).json({ success: false, message: 'فشل تغيير كلمة المرور' });
  }
}

// ولا تنسى تصدر الدالة في module.exports تحت
// تصدير الدوال
module.exports = {
  login,
  saveFcmToken,
  getEmployeeByUserId,
  changePassword
};