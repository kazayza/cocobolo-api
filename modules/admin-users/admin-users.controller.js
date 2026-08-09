const adminUsersQueries = require('./admin-users.queries');
const { successResponse, errorResponse, notFoundResponse } = require('../../shared/response.helper');
const bcrypt = require('bcryptjs');

// ═══════════════════════════════════════════════════════════
// دوال مساعدة
// ═══════════════════════════════════════════════════════════

// التحقق من بيانات المدخلات المشتركة
function validateUserInput(body, { isEdit }) {
  const { username, fullName, password, email, role, isActive, employeeId } = body;

  if (!isEdit && (!username || !username.trim())) {
    return 'اسم المستخدم مطلوب';
  }
  if (!fullName || !fullName.trim()) {
    return 'الاسم الكامل مطلوب';
  }
  if (!isEdit && (!password || password.length < 8)) {
    return 'كلمة المرور مطلوبة (8 أحرف على الأقل)';
  }
  if (isEdit && password && password.length < 8) {
    return 'كلمة المرور الجديدة يجب أن تكون 8 أحرف على الأقل';
  }
  if (email && email.trim() && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) {
    return 'البريد الإلكتروني غير صالح';
  }
  return null;
}

// ═══════════════════════════════════════════════════════════
// قائمة المستخدمين
// GET /api/admin/users
// ═══════════════════════════════════════════════════════════
async function listUsers(req, res) {
  try {
    const users = await adminUsersQueries.getAllUsers();

    // إخفاء أي بيانات حساسة
    const safeUsers = users.map(u => ({
      userId: u.UserID,
      username: u.Username,
      fullName: u.FullName,
      email: u.Email,
      role: u.Role,
      isActive: u.IsActive === 1 || u.IsActive === true,
      createdBy: u.CreatedBy,
      createdAt: u.CreatedAt,
      lastLogin: u.LastLogin,
      employeeId: u.employeeID,
      employeeName: u.EmployeeName,
      permissionsCount: u.PermissionsCount || 0,
    }));

    return successResponse(res, safeUsers, 'تم جلب المستخدمين بنجاح');
  } catch (err) {
    console.error('❌ listUsers:', err.message);
    return errorResponse(res, 'خطأ في جلب المستخدمين', 500, err.message);
  }
}

// ═══════════════════════════════════════════════════════════
// مستخدم واحد
// GET /api/admin/users/:id
// ═══════════════════════════════════════════════════════════
async function getUser(req, res) {
  try {
    const userId = parseInt(req.params.id, 10);
    if (!userId) return errorResponse(res, 'معرّف مستخدم غير صالح', 400);

    const user = await adminUsersQueries.getUserById(userId);
    if (!user) return notFoundResponse(res, 'المستخدم غير موجود');

    const permissions = await adminUsersQueries.getUserPermissions(userId);
    const permMap = {};
    for (const p of permissions) {
      permMap[p.PermissionID] = {
        canView: p.CanView === 1 || p.CanView === true,
        canAdd: p.CanAdd === 1 || p.CanAdd === true,
        canEdit: p.CanEdit === 1 || p.CanEdit === true,
        canDelete: p.CanDelete === 1 || p.CanDelete === true,
      };
    }

    return successResponse(res, {
      userId: user.UserID,
      username: user.Username,
      fullName: user.FullName,
      email: user.Email,
      role: user.Role,
      isActive: user.IsActive === 1 || user.IsActive === true,
      createdBy: user.CreatedBy,
      createdAt: user.CreatedAt,
      lastLogin: user.LastLogin,
      employeeId: user.employeeID,
      permissions: permMap,
    }, 'تم جلب المستخدم بنجاح');
  } catch (err) {
    console.error('❌ getUser:', err.message);
    return errorResponse(res, 'خطأ في جلب المستخدم', 500, err.message);
  }
}

// ═══════════════════════════════════════════════════════════
// إضافة مستخدم جديد
// POST /api/admin/users
// ═══════════════════════════════════════════════════════════
async function createUser(req, res) {
  try {
    const validationError = validateUserInput(req.body, { isEdit: false });
    if (validationError) return errorResponse(res, validationError, 400);

    const { username, fullName, password, email, role, isActive, employeeId } = req.body;

    // التحقق من عدم التكرار
    const exists = await adminUsersQueries.usernameExists(username.trim(), null);
    if (exists) return errorResponse(res, 'اسم المستخدم موجود بالفعل', 409);

    // تشفير كلمة المرور بـ bcrypt
    const hashedPassword = await bcrypt.hash(password, 10);

    const newUserId = await adminUsersQueries.createUser({
      username: username.trim(),
      hashedPassword,
      plainPassword: password, // مؤقت — للتوافق مع login القديم (يُحذف بعد ترحيل التشفير)
      fullName: fullName.trim(),
      email: email ? email.trim() : null,
      role: role || 'User',
      isActive: isActive !== false,
      employeeId: employeeId || null,
      createdBy: req.body.createdBy || req.body.assignedBy || 'System',
    });

    if (!newUserId) return errorResponse(res, 'فشل إضافة المستخدم', 500);

    return successResponse(res, { userId: newUserId }, 'تم إضافة المستخدم بنجاح', 201);
  } catch (err) {
    console.error('❌ createUser:', err.message);
    return errorResponse(res, 'خطأ في إضافة المستخدم', 500, err.message);
  }
}

// ═══════════════════════════════════════════════════════════
// تعديل مستخدم
// PUT /api/admin/users/:id
// ═══════════════════════════════════════════════════════════
async function updateUser(req, res) {
  try {
    const userId = parseInt(req.params.id, 10);
    if (!userId) return errorResponse(res, 'معرّف مستخدم غير صالح', 400);

    const validationError = validateUserInput(req.body, { isEdit: true });
    if (validationError) return errorResponse(res, validationError, 400);

    const existing = await adminUsersQueries.getUserById(userId);
    if (!existing) return notFoundResponse(res, 'المستخدم غير موجود');

    const { fullName, password, email, role, isActive, employeeId } = req.body;

    let hashedPassword = null;
    let plainPassword = null;
    if (password && password.trim()) {
      hashedPassword = await bcrypt.hash(password, 10);
      plainPassword = password; // مؤقت — للتوافق مع login القديم
    }

    await adminUsersQueries.updateUser(userId, {
      fullName: fullName ? fullName.trim() : existing.FullName,
      email: email ? email.trim() : null,
      role: role || existing.Role || 'User',
      isActive: isActive !== undefined ? isActive : existing.IsActive,
      employeeId: employeeId !== undefined ? employeeId : existing.employeeID,
      hashedPassword,
      plainPassword,
    });

    return successResponse(res, null, 'تم تحديث المستخدم بنجاح');
  } catch (err) {
    console.error('❌ updateUser:', err.message);
    return errorResponse(res, 'خطأ في تعديل المستخدم', 500, err.message);
  }
}

// ═══════════════════════════════════════════════════════════
// حذف مستخدم
// DELETE /api/admin/users/:id
// ═══════════════════════════════════════════════════════════
async function deleteUser(req, res) {
  try {
    const userId = parseInt(req.params.id, 10);
    if (!userId) return errorResponse(res, 'معرّف مستخدم غير صالح', 400);

    const existing = await adminUsersQueries.getUserById(userId);
    if (!existing) return notFoundResponse(res, 'المستخدم غير موجود');

    await adminUsersQueries.deleteUser(userId);
    return successResponse(res, null, 'تم حذف المستخدم بنجاح');
  } catch (err) {
    console.error('❌ deleteUser:', err.message);
    return errorResponse(res, 'خطأ في حذف المستخدم', 500, err.message);
  }
}

// ═══════════════════════════════════════════════════════════
// كل صلاحيات النظام
// GET /api/admin/permissions
// ═══════════════════════════════════════════════════════════
async function listPermissions(req, res) {
  try {
    const permissions = await adminUsersQueries.getAllPermissions();

    const safePermissions = permissions.map(p => ({
      permissionId: p.PermissionID,
      permissionName: p.PermissionName,
      description: p.Description,
      category: p.Category,
      formName: p.FormName,
    }));

    return successResponse(res, safePermissions, 'تم جلب الصلاحيات بنجاح');
  } catch (err) {
    console.error('❌ listPermissions:', err.message);
    return errorResponse(res, 'خطأ في جلب الصلاحيات', 500, err.message);
  }
}

// ═══════════════════════════════════════════════════════════
// صلاحيات مستخدم
// GET /api/admin/users/:id/permissions
// ═══════════════════════════════════════════════════════════
async function getUserPermissions(req, res) {
  try {
    const userId = parseInt(req.params.id, 10);
    if (!userId) return errorResponse(res, 'معرّف مستخدم غير صالح', 400);

    const existing = await adminUsersQueries.getUserById(userId);
    if (!existing) return notFoundResponse(res, 'المستخدم غير موجود');

    const permissions = await adminUsersQueries.getUserPermissions(userId);
    return successResponse(res, permissions.map(p => ({
      permissionId: p.PermissionID,
      canView: p.CanView === 1 || p.CanView === true,
      canAdd: p.CanAdd === 1 || p.CanAdd === true,
      canEdit: p.CanEdit === 1 || p.CanEdit === true,
      canDelete: p.CanDelete === 1 || p.CanDelete === true,
    })), 'تم جلب صلاحيات المستخدم بنجاح');
  } catch (err) {
    console.error('❌ getUserPermissions:', err.message);
    return errorResponse(res, 'خطأ في جلب الصلاحيات', 500, err.message);
  }
}

// ═══════════════════════════════════════════════════════════
// حفظ صلاحيات مستخدم
// PUT /api/admin/users/:id/permissions
// Body: { permissions: [{ permissionId, canView, canAdd, canEdit, canDelete }] }
// ═══════════════════════════════════════════════════════════
async function saveUserPermissions(req, res) {
  try {
    const userId = parseInt(req.params.id, 10);
    if (!userId) return errorResponse(res, 'معرّف مستخدم غير صالح', 400);

    const existing = await adminUsersQueries.getUserById(userId);
    if (!existing) return notFoundResponse(res, 'المستخدم غير موجود');

    const { permissions } = req.body;
    if (!Array.isArray(permissions)) {
      return errorResponse(res, 'الصلاحيات يجب أن تكون مصفوفة', 400);
    }

    // تنظيف البيانات
    const clean = permissions.map(p => ({
      permissionId: parseInt(p.permissionId, 10),
      canView: !!p.canView,
      canAdd: !!p.canAdd,
      canEdit: !!p.canEdit,
      canDelete: !!p.canDelete,
    })).filter(p => p.permissionId > 0);

    await adminUsersQueries.replaceUserPermissions(
      userId,
      clean,
      req.body.assignedBy || req.body.createdBy || 'System',
    );

    return successResponse(res, null, 'تم حفظ الصلاحيات بنجاح');
  } catch (err) {
    console.error('❌ saveUserPermissions:', err.message);
    return errorResponse(res, 'خطأ في حفظ الصلاحيات', 500, err.message);
  }
}

module.exports = {
  listUsers,
  getUser,
  createUser,
  updateUser,
  deleteUser,
  listPermissions,
  getUserPermissions,
  saveUserPermissions,
};
