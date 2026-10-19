const authQueries = require('./auth.queries');
const bcrypt = require('bcryptjs');
const { successResponse, errorResponse } = require('../../shared/response.helper');
const { issueAccessToken } = require('../../core/auth.middleware');

function serializePermissions(rows) {
  const permissions = {};
  const claims = [];

  for (const perm of rows) {
    const formName = String(perm.FormName || '').trim();
    if (!formName) continue;

    const value = {
      permissionId: perm.PermissionID || 0,
      permissionName: perm.PermissionName || '',
      category: perm.Category || '',
      canView: perm.CanView === true || perm.CanView === 1,
      canAdd: perm.CanAdd === true || perm.CanAdd === 1,
      canEdit: perm.CanEdit === true || perm.CanEdit === 1,
      canDelete: perm.CanDelete === true || perm.CanDelete === 1,
    };
    permissions[formName] = value;
    if (value.canView) claims.push(`${formName}:View`);
    if (value.canAdd) claims.push(`${formName}:Add`);
    if (value.canEdit) claims.push(`${formName}:Edit`);
    if (value.canDelete) claims.push(`${formName}:Delete`);
  }

  return { permissions, claims };
}

function safeUserFrom(user, token = null) {
  const safeUser = { ...user };
  delete safeUser.Password;
  delete safeUser.HashedPassword;
  if (token) safeUser.Token = token; // توافق مؤقت مع Flutter القديم
  return safeUser;
}

// تسجيل الدخول + إصدار Access Token موثوق
async function login(req, res) {
  try {
    const { username, password, rememberMe } = req.body;

    if (!username || !password) {
      return errorResponse(res, 'اسم المستخدم وكلمة المرور مطلوبين', 400);
    }

    const user = await authQueries.findUserByCredentials(username, password);
    if (!user) {
      return res.json({
        success: false,
        message: 'اسم المستخدم أو كلمة المرور غير صحيحة'
      });
    }

    const permissionsResult = await authQueries.getUserPermissions(user.UserID);
    const { permissions, claims } = serializePermissions(permissionsResult);
    const accessToken = issueAccessToken(user, { rememberMe: rememberMe === true });

    return res.json({
      success: true,
      accessToken,
      tokenType: 'Bearer',
      user: safeUserFrom(user, accessToken),
      permissions,
      claims,
    });

  } catch (err) {
    console.error('خطأ في تسجيل الدخول:', err);
    return errorResponse(res, 'خطأ في السيرفر', 500, err.message);
  }
}

// استعادة الجلسة من Token بدون حفظ كلمة المرور على الجهاز
async function me(req, res) {
  try {
    const auth = req.auth;
    return res.json({
      success: true,
      user: safeUserFrom(auth.user),
      permissions: auth.permissions,
      claims: Array.from(auth.claims || []),
    });
  } catch (err) {
    console.error('auth.me:', err);
    return errorResponse(res, 'تعذر استعادة الجلسة', 500, err.message);
  }
}

// حفظ FCM Token - المستخدم يؤخذ من الجلسة الموثوقة عند توفرها
async function saveFcmToken(req, res) {
  try {
    const userId = req.auth?.userId || req.body.userId;
    const { fcmToken } = req.body;

    if (!userId || !fcmToken) {
      return errorResponse(res, 'المستخدم وFCM Token مطلوبان', 400);
    }

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

    // ── تحقق ذكي من كلمة المرور الحالية ──────────────────
    let isValid = false;

    if (user.HashedPassword) {
      // عنده تشفير → bcrypt
      isValid = await bcrypt.compare(currentPassword, user.HashedPassword);
    } else {
      // قديم → plain + ترحيل تلقائي بعد التحقق
      isValid = user.Password === currentPassword;
    }

    if (!isValid) {
      return res.status(400).json({ success: false, message: 'كلمة المرور الحالية غير صحيحة' });
    }

    // 2. تشفير الجديدة وحفظها (hash + plain مؤقت للتوافق)
    const hashedNew = await bcrypt.hash(newPassword, 10);
    await authQueries.updateUserPassword(userId, newPassword, hashedNew);

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
  me,
  saveFcmToken,
  getEmployeeByUserId,
  changePassword
};