const admin = require('firebase-admin');
require('dotenv').config();

let firebaseInitialized = false;

// تهيئة Firebase Admin SDK
function initializeFirebase() {
  try {
    // التحقق من وجود بيانات Firebase
    if (!process.env.FIREBASE_PROJECT_ID || 
        !process.env.FIREBASE_CLIENT_EMAIL || 
        !process.env.FIREBASE_PRIVATE_KEY) {
      console.log('⚠️ Firebase: بيانات الاعتماد غير موجودة - الإشعارات معطلة');
      return null;
    }

    // ✅ معالجة المفتاح لتصحيح الأسطر الجديدة تلقائياً وإزالة علامات التنصيص الزائدة
    let rawKey = process.env.FIREBASE_PRIVATE_KEY;
    if (rawKey.startsWith('"') && rawKey.endsWith('"')) {
      rawKey = rawKey.slice(1, -1);
    }
    const formattedKey = rawKey.replace(/\\n/g, '\n');

    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert({
          projectId: process.env.FIREBASE_PROJECT_ID,
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
          privateKey: formattedKey,
        }),
      });
      firebaseInitialized = true;
      console.log('✅ Firebase Admin SDK شغال بنجاح');
    }
    return admin;
  } catch (err) {
    console.log('⚠️ Firebase: فشل التهيئة - الإشعارات معطلة');
    console.log('   السبب:', err.message);
    return null;
  }
}

// دالة إرسال Push Notification
async function sendPushNotification(token, title, message, data = {}) {
  try {
    // التحقق من تهيئة Firebase
    if (!firebaseInitialized) {
      return { success: false, error: 'Firebase غير مفعل' };
    }

    // FCM يشترط أن تكون كل data values نصوصاً.
    const normalizedData = {};
    for (const [key, value] of Object.entries(data || {})) {
      normalizedData[key] = value == null ? '' : String(value);
    }

    const payload = {
      token: token,
      notification: {
        title: title,
        body: message
      },
      data: normalizedData,
      android: {
        priority: 'high',
        notification: {
          sound: 'default',
          channelId: 'high_importance_channel',
          clickAction: 'FLUTTER_NOTIFICATION_CLICK'
        }
      },
      apns: {
        payload: {
          aps: {
            sound: 'default'
          }
        }
      }
    };

    const response = await admin.messaging().send(payload);
    return { success: true, response };
  } catch (err) {
    console.error('❌ خطأ في إرسال Push:', err.message);
    return { success: false, error: err.message };
  }
}

// دالة للتحقق من حالة Firebase
function isFirebaseReady() {
  return firebaseInitialized;
}

// تصدير الدوال
module.exports = {
  admin,
  initializeFirebase,
  sendPushNotification,
  isFirebaseReady
};