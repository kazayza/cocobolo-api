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

    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert({
          projectId: process.env.FIREBASE_PROJECT_ID,
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
          privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
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

    const payload = {
      token: token,
      notification: {
        title: title,
        body: message
      },
      data: data,
      android: {
        priority: 'high',
        notification: {
          sound: 'default',
          channelId: 'high_importance_channel'
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