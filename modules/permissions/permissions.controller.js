const permissionsQueries = require('./permissions.queries');
const notificationsQueries = require('../notifications/notifications.queries');
const { sql, connectDB } = require('../../core/database'); // ✅ ضفنا دي عشان الاستعلام
const { successResponse, errorResponse } = require('../../shared/response.helper');

// --- دوال مساعدة ---

// ✅ دالة بتجيب رقم الموظف من رقم اليوزر
async function getEmployeeIdFromUser(userId) {
  try {
    const pool = await connectDB();
    const result = await pool.request()
      .input('uid', sql.Int, userId)
      // 👇👇 غيرنا EmployeeID لـ employeeID (أو الاسم الصح عندك)
      .query('SELECT employeeID FROM Users WHERE UserID = @uid'); 
    
    // 👇👇 وهنا كمان خليها زي اسم العمود بالظبط
    return result.recordset[0]?.employeeID; 
  } catch (err) {
    console.error('Error fetching EmployeeID:', err);
    return null;
  }
}

// 🔔 إشعار للمديرين
async function notifyManagers(title, message, relatedId) {
  try {
    const roles = ['Admin', 'HR', 'AccountManager', 'SalesManager'];
    for (const role of roles) {
      await notificationsQueries.createNotificationSmart({
        title, message, createdBy: 'System', formName: 'frm_PermissionsList', relatedId
      }, role);
    }
  } catch (err) { console.error('Notify Managers Error:', err); }
}

// 🔔 إشعار للموظف
// ✅ دالة إشعار الموظف (تم التعديل لضمان الوصول)
// ✅ دالة إشعار الموظف (تم تصحيح خطأ MAX)
// ✅ دالة إشعار الموظف (متوافقة مع جدول Notifications بتاعك)
async function notifyEmployee(targetUserId, title, message, relatedId) {
  try {
    const pool = await connectDB();
    
    // 1. محتاجين نجيب Username بتاع الموظف (لأن RecipientUser غالباً بياخد اسم المستخدم)
    // لو الجدول بياخد UserID (رقم)، يبقى نبعت targetUserId علطول
    // بس للأمان، هنجيب الـ Username
    const userRes = await pool.request()
      .input('uid', sql.Int, targetUserId)
      .query('SELECT Username FROM Users WHERE UserID = @uid');
      
    const username = userRes.recordset[0]?.Username;

    if (!username) return; 

    // 2. إرسال الإشعار
    await pool.request()
      .input('title', sql.NVarChar(255), title)
      .input('msg', sql.NVarChar(sql.MAX), message)
      .input('form', sql.VarChar(50), 'frm_MyPermissions') // اسم الشاشة
      .input('relId', sql.Int, relatedId)
      .input('recipient', sql.NVarChar(50), username) // 👈 بنبعت للـ Username
      .query(`
        INSERT INTO Notifications (
          Title, Message, CreatedBy, FormName, RelatedID, 
          RecipientUser, IsRead, CreatedAt
        )
        VALUES (
          @title, @msg, 'System', @form, @relId, 
          @recipient, 0, GETDATE()
        )
      `);
      
    console.log(`Notification sent to ${username}`);

  } catch (err) {
    console.error('Notify Employee Error:', err);
  }
}

// --- الدوال الرئيسية ---

// مرحلة صفر (أمن): الهوية والسلطة من التوكن فقط (req.auth) — أي
// userId/role في الجسم أو الاستعلام يُتجاهل تمامًا؛ كان أي مستخدم
// مصادَق يستطيع تقديم طلب باسم غيره والبتّ في طلبات الآخرين بنفسه.
const PERMISSION_MANAGER_ROLES = ['admin', 'hr', 'hrmanager', 'generalmanager', 'accountmanager', 'salesmanager'];
function isPermissionManager(auth) {
  return PERMISSION_MANAGER_ROLES.includes(String(auth?.role || '').toLowerCase().replace(/[\s_-]+/g, ''));
}

// 1. تقديم طلب إذن — لصاحب الجلسة نفسه فقط
async function requestPermission(req, res) {
  try {
    const { permissionDate, type, reason, createdAt, fromTime, toTime } = req.body;

    // ✅ 1. رقم الموظف من جلسة التوكن، لا من الجسم
    const empId = req.auth.employeeId || await getEmployeeIdFromUser(req.auth.userId);

    if (!empId) {
      return errorResponse(res, 'هذا المستخدم غير مرتبط بموظف، لا يمكن تقديم طلب.', 400);
    }

    // ✅ 2. بنستخدم الرقم اللي جبناه من الداتابيز
    const permissionId = await permissionsQueries.createPermission({
      employeeId: empId, 
      permissionDate,
      type,
      fromTime,
      toTime,
      reason,
      createdAt: createdAt || new Date()
    });

    // 3. إشعار للمديرين
    await notifyManagers(
      'طلب إذن جديد 📩',
      `يوجد طلب إذن ${type} جديد.`,
      permissionId
    );

    return res.json({ success: true, message: 'تم إرسال الطلب بنجاح', permissionId });

  } catch (err) {
    console.error(err);
    return errorResponse(res, 'فشل إرسال الطلب', 500);
  }
}

// 2. عرض الطلبات — الدور من التوكن؛ غير المدير يرى طلباته فقط
async function listPermissions(req, res) {
  try {
    const { status, employeeName } = req.query;

    const isManager = isPermissionManager(req.auth);

    let filters = { status, employeeName };

    if (!isManager) {
      // ✅ موظف عادي: مقيد برقم موظفه من الجلسة مهما أرسل
      const empId = req.auth.employeeId || await getEmployeeIdFromUser(req.auth.userId);
      if (!empId) return res.json([]); // لو مش موظف ملوش بيانات
      filters.employeeId = empId;
    } else if (req.query.employeeId) {
      const wanted = parseInt(req.query.employeeId, 10);
      if (!Number.isNaN(wanted)) filters.employeeId = wanted;
    }

    const data = await permissionsQueries.getPermissionsList(filters);
    return res.json(data);

  } catch (err) {
    return errorResponse(res, 'فشل تحميل الطلبات', 500);
  }
}

// 3. اتخاذ إجراء — مدير فقط، والطلب يجب أن يكون معلقًا،
// والمعتمِد هو صاحب الجلسة (لا userId من الجسم).
async function takeAction(req, res) {
  try {
    if (!isPermissionManager(req.auth)) {
      return errorResponse(res, 'ليس لديك صلاحية البت في طلبات الأذونات.', 403);
    }

    const { permissionId, status, comment } = req.body;

    if (!['Approved', 'Rejected'].includes(status)) {
      return errorResponse(res, 'حالة غير صحيحة', 400);
    }

    const existing = await permissionsQueries.getPermissionById(permissionId);
    if (!existing) {
      return errorResponse(res, 'الطلب غير موجود', 404);
    }
    if (existing.Status !== 'Pending') {
      return errorResponse(res, 'تم البت في هذا الطلب مسبقًا ولا يمكن إعادة البت فيه.', 400);
    }

    const affected = await permissionsQueries.updatePermissionStatus({
      permissionId, status, comment, userId: req.auth.userId
    });
    if (!affected) {
      return errorResponse(res, 'تم البت في هذا الطلب مسبقًا ولا يمكن إعادة البت فيه.', 400);
    }

    if (existing.RequesterUserID) {
        const msg = status === 'Approved' ? 'تمت الموافقة على طلبك ✅' : 'تم رفض طلبك ❌';
        await notifyEmployee(existing.RequesterUserID, 'تحديث حالة الطلب', msg, permissionId);
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