const notificationsQueries = require('./notifications.queries');
const { sendPushNotification, isFirebaseReady } = require('../../core/firebase');
const { successResponse, errorResponse } = require('../../shared/response.helper');

// جلب الإشعارات غير المقروءة
async function getUnread(req, res) {
  try {
    const { username } = req.query;

    if (!username) {
      return errorResponse(res, 'اسم المستخدم مطلوب', 400);
    }

    const notifications = await notificationsQueries.getUnreadNotifications(username);

    return res.json({
      count: notifications.length,
      notifications: notifications
    });
  } catch (err) {
    console.error('خطأ في جلب الإشعارات:', err);
    return errorResponse(res, 'فشل تحميل الإشعارات', 500, err.message);
  }
}

// جلب كل الإشعارات
async function getAll(req, res) {
  try {
    const { username } = req.query;

    if (!username) {
      return errorResponse(res, 'اسم المستخدم مطلوب', 400);
    }

    const notifications = await notificationsQueries.getAllNotifications(username);
    return res.json(notifications);
  } catch (err) {
    console.error('خطأ في جلب الإشعارات:', err);
    return errorResponse(res, 'فشل تحميل الإشعارات', 500, err.message);
  }
}

// تحديد كل الإشعارات كمقروءة
async function markAllAsRead(req, res) {
  try {
    const { username } = req.body;

    if (!username) {
      return errorResponse(res, 'اسم المستخدم مطلوب', 400);
    }

    await notificationsQueries.markAllAsRead(username);

    return res.json({
      success: true,
      message: 'تم تحديد الكل كمقروء'
    });
  } catch (err) {
    console.error('خطأ في تحديث الإشعارات:', err);
    return errorResponse(res, 'فشل تحديث الإشعارات', 500, err.message);
  }
}

// تحديد إشعار واحد كمقروء
async function markAsRead(req, res) {
  try {
    const { id } = req.params;

    await notificationsQueries.markAsRead(id);

    return res.json({
      success: true,
      message: 'تم تحديد الإشعار كمقروء'
    });
  } catch (err) {
    console.error('خطأ في تحديث الإشعار:', err);
    return errorResponse(res, 'فشل تحديث الإشعار', 500, err.message);
  }
}

// إنشاء إشعار جديد
async function create(req, res) {
  try {
    const { title, message, recipientUser, createdBy } = req.body;

    if (!title || !message || !recipientUser) {
      return errorResponse(res, 'العنوان والرسالة والمستلم مطلوبين', 400);
    }

    const notificationId = await notificationsQueries.createNotification(req.body);

    return res.json({
      success: true,
      notificationId: notificationId,
      message: 'تم إرسال الإشعار بنجاح'
    });
  } catch (err) {
    console.error('خطأ في إرسال الإشعار:', err);
    return errorResponse(res, 'فشل إرسال الإشعار', 500, err.message);
  }
}

// إرسال Push Notification
async function sendPush(req, res) {
  try {
    const { recipientUser, title, message, data } = req.body;

    if (!recipientUser || !title || !message) {
      return errorResponse(res, 'البيانات ناقصة', 400);
    }

    // التحقق من تفعيل Firebase
    if (!isFirebaseReady()) {
      return res.json({
        success: false,
        message: 'Firebase غير مفعل'
      });
    }

    // جلب FCM Token
    const token = await notificationsQueries.getFcmToken(recipientUser);

    if (!token) {
      return res.json({
        success: false,
        message: 'المستخدم لا يملك توكن FCM'
      });
    }

    // إرسال الإشعار
    const result = await sendPushNotification(token, title, message, data || {});

    if (result.success) {
      return res.json({
        success: true,
        message: 'تم إرسال الإشعار بنجاح'
      });
    } else {
      return res.json({
        success: false,
        message: result.error
      });
    }
  } catch (err) {
    console.error('خطأ في إرسال Push:', err);
    return errorResponse(res, 'فشل إرسال الإشعار', 500, err.message);
  }
}

// تصدير الدوال
module.exports = {
  getUnread,
  getAll,
  markAllAsRead,
  markAsRead,
  create,
  sendPush
};