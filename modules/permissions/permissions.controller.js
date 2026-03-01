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
async function notifyEmployee(targetUserId, title, message, relatedId) {
  try {
    const pool = await connectDB();
    
    // 1. نجيب EmployeeID من UserID (عشان الإشعار يتربط بالموظف)
    const empRes = await pool.request()
      .input('uid', sql.Int, targetUserId)
      .query('SELECT EmployeeID FROM Users WHERE UserID = @uid');
      
    const empId = empRes.recordset[0]?.EmployeeID;

    if (!empId) return; // لو مفيش موظف، متبعتش

    // 2. إرسال الإشعار للموظف مباشرة (Direct Insert)
    // لاحظ: بنحط Role = NULL وبنحدد TargetEmployeeID
    await pool.request()
      .input('title', sql.NVarChar(255), title)
      .input('msg', sql.NVarChar(MAX), message)
      .input('form', sql.VarChar(50), 'frm_MyPermissions')
      .input('relId', sql.Int, relatedId)
      .input('empId', sql.Int, empId) // 👈 ده المهم
      .query(`
        INSERT INTO Notifications (
          Title, Message, CreatedBy, FormName, RelatedId, 
          TargetEmployeeID, IsRead, CreatedAt
        )
        VALUES (
          @title, @msg, 'System', @form, @relId, 
          @empId, 0, GETDATE()
        )
      `);
      
    console.log(`Notification sent to User ${targetUserId} (Emp ${empId})`);

  } catch (err) {
    console.error('Notify Employee Error:', err);
  }
}

// --- الدوال الرئيسية ---

// 1. تقديم طلب إذن
async function requestPermission(req, res) {
  try {
    // ⚠️ مش بناخد employeeId من الموبايل هنا
    const { userId, permissionDate, type, reason, createdAt, fromTime, toTime } = req.body;

    // ✅ 1. الباك اند بيجيب رقم الموظف بنفسه
    const empId = await getEmployeeIdFromUser(userId);

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

// 2. عرض الطلبات
async function listPermissions(req, res) {
  try {
    const { userId, role, status, employeeName } = req.query;
    
    const managerRoles = ['Admin', 'HR', 'AccountManager', 'SalesManager'];
    const isManager = managerRoles.some(r => r.toLowerCase() === (role || '').toLowerCase());

    let filters = { status, employeeName };

    if (!isManager) {
      // ✅ لو موظف عادي: الباك اند يجيب رقمه ويفلتر بيه
      const empId = await getEmployeeIdFromUser(userId);
      if (!empId) return res.json([]); // لو مش موظف ملوش بيانات
      filters.employeeId = empId;
    }

    const data = await permissionsQueries.getPermissionsList(filters);
    return res.json(data);

  } catch (err) {
    return errorResponse(res, 'فشل تحميل الطلبات', 500);
  }
}

// 3. اتخاذ إجراء (زي ما هي)
async function takeAction(req, res) {
  try {
    const { permissionId, status, comment, userId } = req.body;

    if (!['Approved', 'Rejected'].includes(status)) {
      return errorResponse(res, 'حالة غير صحيحة', 400);
    }

    await permissionsQueries.updatePermissionStatus({ permissionId, status, comment, userId });
    
    const permDetails = await permissionsQueries.getPermissionById(permissionId);
    if (permDetails && permDetails.RequesterUserID) {
        const msg = status === 'Approved' ? 'تمت الموافقة على طلبك ✅' : 'تم رفض طلبك ❌';
        await notifyEmployee(permDetails.RequesterUserID, 'تحديث حالة الطلب', msg, permissionId);
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