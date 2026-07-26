const cron = require('node-cron');
const { sql, connectDB } = require('../../core/database');
const { sendPushNotification, isFirebaseReady } = require('../../core/firebase');
const notificationsQueries = require('./notifications.queries');

// ذاكرة مؤقتة لتجنب إرسال نفس الإشعار أكثر من مرة في اليوم
const sentCache = new Set();

// تنظيف الكاش كل 24 ساعة
setInterval(() => {
  sentCache.clear();
}, 24 * 60 * 60 * 1000);

function startNotificationScheduler() {
  // تشغيل كل 5 دقائق
  cron.schedule('*/5 * * * *', async () => {
    try {
      await checkCrmFollowUps();
      await checkShiftReminders();
    } catch (err) {
      console.error('❌ خطأ في تشغيل جدول الإشعارات التلقائية:', err);
    }
  });

  console.log('⏰ تم تفعيل نظام إرسال الإشعارات التلقائية (Scheduler) بنجاح');
}

// 1️⃣ فحص متابعات الـ CRM (قبل ساعتين وقبل 24 ساعة)
async function checkCrmFollowUps() {
  try {
    const pool = await connectDB();
    
    const result = await pool.request().query(`
      SELECT 
        o.OpportunityID,
        o.NextFollowUpDate,
        o.InterestedProduct,
        p.PartyName AS ClientName,
        o.EmployeeID,
        u.Username,
        DATEDIFF(MINUTE, GETDATE(), o.NextFollowUpDate) as DiffMinutes
      FROM SalesOpportunities o
      JOIN Parties p ON o.PartyID = p.PartyID
      JOIN Users u ON o.EmployeeID = u.employeeID
      WHERE o.IsActive = 1 
        AND o.StageID NOT IN (3, 4, 5)
        AND o.NextFollowUpDate IS NOT NULL
        AND o.NextFollowUpDate > GETDATE()
        AND DATEDIFF(MINUTE, GETDATE(), o.NextFollowUpDate) <= 1455
    `);

    for (const row of (result.recordset || [])) {
      const diff = row.DiffMinutes;
      const username = row.Username;
      const oppId = row.OpportunityID;
      const clientName = row.ClientName || 'العميل';
      const productName = row.InterestedProduct ? `(${row.InterestedProduct})` : '';

      if (!username) continue;

      // أ) تذكير قبل ساعتين (بين 110 و 130 دقيقة)
      if (diff >= 110 && diff <= 130) {
        const cacheKey = `opp_${oppId}_2h_${new Date().toISOString().slice(0,10)}`;
        if (!sentCache.has(cacheKey)) {
          sentCache.add(cacheKey);
          
          const title = `⏰ تذكير بمتابعة عميل`;
          const message = `أهلاً يا ${username}، لديك متابعة مع العميل ${clientName} ${productName} خلال ساعتين!`;
          
          await sendNotificationToUser(username, title, message, 'SalesOpportunities', oppId, 'opportunity_detail_screen');
        }
      }

      // ب) تذكير قبل 24 ساعة (بين 1410 و 1450 دقيقة)
      if (diff >= 1410 && diff <= 1450) {
        const cacheKey = `opp_${oppId}_1d_${new Date().toISOString().slice(0,10)}`;
        if (!sentCache.has(cacheKey)) {
          sentCache.add(cacheKey);
          
          const title = `📅 تذكير بمتابعة غداً`;
          const message = `أهلاً يا ${username}، نذكرك بموعد متابعة العميل ${clientName} ${productName} غداً.`;
          
          await sendNotificationToUser(username, title, message, 'SalesOpportunities', oppId, 'opportunity_detail_screen');
        }
      }
    }
  } catch (err) {
    console.error('خطأ في فحص متابعات الـ CRM:', err);
  }
}

// 2️⃣ فحص تذكيرات البصمة والشفتات (قبل نصف ساعة للحضور والانصراف)
async function checkShiftReminders() {
  try {
    const pool = await connectDB();
    
    const result = await pool.request().query(`
      SELECT 
        s.EmployeeShiftID,
        s.EmployeeID,
        s.StartTime,
        s.EndTime,
        s.BiometricCode,
        u.Username,
        e.FullName
      FROM EmployeeShifts s
      JOIN Employees e ON s.EmployeeID = e.EmployeeID
      JOIN Users u ON e.EmployeeID = u.employeeID
      WHERE u.IsActive = 1
        AND CAST(GETDATE() AS DATE) >= CAST(s.EffectiveFrom AS DATE)
        AND (s.EffectiveTo IS NULL OR CAST(GETDATE() AS DATE) <= CAST(s.EffectiveTo AS DATE))
    `);

    const now = new Date();
    const currentHours = now.getHours();
    const currentMinutes = now.getMinutes();
    const totalCurrentMinutes = currentHours * 60 + currentMinutes;
    const todayDateStr = now.toISOString().slice(0, 10);

    for (const shift of (result.recordset || [])) {
      const username = shift.Username;
      const bioCode = shift.BiometricCode;
      if (!username || !bioCode) continue;

      // تذكير الحضور (قبل نصف ساعة من وقت بداية الشفت)
      if (shift.StartTime) {
        const startTimeStr = formatTimeString(shift.StartTime);
        const [startH, startM] = startTimeStr.split(':').map(Number);
        const shiftStartTotalMinutes = startH * 60 + startM;

        const diffStart = shiftStartTotalMinutes - totalCurrentMinutes;
        if (diffStart >= 25 && diffStart <= 35) {
          const attendanceCheck = await pool.request()
            .input('bioCode', sql.Int, bioCode)
            .input('today', sql.VarChar(10), todayDateStr)
            .query(`
              SELECT TOP 1 AttendanceID, TimeIn 
              FROM Attendance 
              WHERE BiometricCode = @bioCode AND CAST(LogDate AS DATE) = CAST(@today AS DATE)
            `);

          const hasCheckedIn = attendanceCheck.recordset.length > 0 && attendanceCheck.recordset[0].TimeIn != null;

          if (!hasCheckedIn) {
            const cacheKey = `shift_in_${shift.EmployeeShiftID}_${todayDateStr}`;
            if (!sentCache.has(cacheKey)) {
              sentCache.add(cacheKey);

              const title = `⏱️ تذكير بموعد الحضور`;
              const message = `أهلاً يا ${username}، اقترب موعد شفت الحضور (${startTimeStr}) خلال نصف ساعة. لا تنسَ تسجيل البصمة!`;
              
              await sendNotificationToUser(username, title, message, 'Attendance', null, 'attendance_screen');
            }
          }
        }
      }

      // تذكير الانصراف (قبل نصف ساعة من نهاية الشفت)
      if (shift.EndTime) {
        const endTimeStr = formatTimeString(shift.EndTime);
        const [endH, endM] = endTimeStr.split(':').map(Number);
        const shiftEndTotalMinutes = endH * 60 + endM;

        const diffEnd = shiftEndTotalMinutes - totalCurrentMinutes;
        if (diffEnd >= 25 && diffEnd <= 35) {
          const attendanceCheck = await pool.request()
            .input('bioCode', sql.Int, bioCode)
            .input('today', sql.VarChar(10), todayDateStr)
            .query(`
              SELECT TOP 1 AttendanceID, TimeIn, TimeOut 
              FROM Attendance 
              WHERE BiometricCode = @bioCode AND CAST(LogDate AS DATE) = CAST(@today AS DATE)
            `);

          const attendance = attendanceCheck.recordset[0];
          const hasCheckedIn = attendance && attendance.TimeIn != null;
          const hasCheckedOut = attendance && attendance.TimeOut != null;

          if (hasCheckedIn && !hasCheckedOut) {
            const cacheKey = `shift_out_${shift.EmployeeShiftID}_${todayDateStr}`;
            if (!sentCache.has(cacheKey)) {
              sentCache.add(cacheKey);

              const title = `🏁 تذكير بموعد الانصراف`;
              const message = `أهلاً يا ${username}، سينتهي شفتك قريباً (${endTimeStr}) خلال نصف ساعة. تذكر تسجيل الانصراف عند المغادرة!`;
              
              await sendNotificationToUser(username, title, message, 'Attendance', null, 'attendance_screen');
            }
          }
        }
      }
    }
  } catch (err) {
    console.error('خطأ في فحص تذكيرات الشفتات:', err);
  }
}

// تنسيق الوقت
function formatTimeString(timeVal) {
  if (!timeVal) return '00:00';
  if (typeof timeVal === 'string') return timeVal.slice(0, 5);
  if (timeVal instanceof Date) {
    return timeVal.toTimeString().slice(0, 5);
  }
  return String(timeVal).slice(0, 5);
}

// إرسال الإشعار
async function sendNotificationToUser(username, title, message, relatedTable, relatedId, formName) {
  try {
    await notificationsQueries.createNotification({
      title,
      message,
      recipientUser: username,
      relatedTable,
      relatedId,
      formName,
      createdBy: 'SYSTEM_SCHEDULER'
    });

    if (isFirebaseReady()) {
      const token = await notificationsQueries.getFcmToken(username);
      if (token) {
        await sendPushNotification(token, title, message, {
          formName: formName || '',
          relatedId: String(relatedId || '')
        });
        console.log(` تم إرسال Push Notification بنجاح إلى: ${username}`);
      }
    }
  } catch (err) {
    console.error(`❌ فشل إرسال الإشعار لـ ${username}:`, err.message);
  }
}

module.exports = {
  startNotificationScheduler
};
