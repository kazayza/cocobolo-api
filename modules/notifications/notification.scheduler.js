const cron = require('node-cron');
const { sql, connectDB } = require('../../core/database');
const { sendPushNotification, isFirebaseReady } = require('../../core/firebase');
const notificationsQueries = require('./notifications.queries');

// ═══════════════════════════════════════════════════════════
// Timezone: Egypt (Africa/Cairo) — shifts are local business times
// Railway/Node often runs UTC → comparing with local Date() breaks reminders
// ═══════════════════════════════════════════════════════════
const TZ = process.env.APP_TIMEZONE || 'Africa/Cairo';
const REMINDER_MINUTES_BEFORE = 30;
const WINDOW_TOLERANCE = 6; // cron every 5 min → accept 24..36 min before

// In-memory dedupe (also DB dedupe below)
const sentCache = new Set();
setInterval(() => sentCache.clear(), 24 * 60 * 60 * 1000);

function startNotificationScheduler() {
  // Every 5 minutes
  cron.schedule(
    '*/5 * * * *',
    async () => {
      try {
        await checkCrmFollowUps();
        await checkShiftReminders();
        await checkDeliveryAdvanceReminders();
        await checkNewLeadsWithoutNotify(); // safety net for Meta leads
      } catch (err) {
        console.error('❌ خطأ في تشغيل جدول الإشعارات التلقائية:', err);
      }
    },
    { timezone: TZ }
  );

  console.log(`⏰ Scheduler مفعّل | timezone=${TZ} | every 5 minutes`);
}

// ── Egypt "now" helpers ────────────────────────────────────
function getEgyptNowParts() {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    weekday: 'short',
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(new Date()).map((p) => [p.type, p.value])
  );
  const hour = parseInt(parts.hour === '24' ? '0' : parts.hour, 10);
  const minute = parseInt(parts.minute, 10);
  const y = parts.year;
  const m = parts.month;
  const d = parts.day;
  // weekday: Mon..Sun → JS getDay style 0=Sun
  const map = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const weekday = map[parts.weekday] ?? new Date().getDay();

  return {
    dateStr: `${y}-${m}-${d}`, // yyyy-MM-dd
    totalMinutes: hour * 60 + minute,
    hour,
    minute,
    weekday,
    display: `${y}-${m}-${d} ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
  };
}

/** Parse SQL time (Date/string/number) → minutes from midnight */
function timeToMinutes(timeVal) {
  if (timeVal == null) return null;

  if (typeof timeVal === 'string') {
    // "10:00:00" | "10:00" | "1970-01-01T10:00:00.000Z" | "10:00:00.0000000"
    const iso = timeVal.match(/T(\d{2}):(\d{2})/);
    if (iso) return parseInt(iso[1], 10) * 60 + parseInt(iso[2], 10);
    const m = timeVal.match(/(\d{1,2}):(\d{2})/);
    if (m) return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  }

  if (timeVal instanceof Date && !Number.isNaN(timeVal.getTime())) {
    // mssql often returns TIME as Date on 1970-01-01 UTC
    return timeVal.getUTCHours() * 60 + timeVal.getUTCMinutes();
  }

  // node-mssql sometimes returns { hours, minutes }
  if (typeof timeVal === 'object') {
    if (timeVal.hours != null) {
      return (timeVal.hours | 0) * 60 + (timeVal.minutes | 0);
    }
  }

  const s = String(timeVal);
  const m = s.match(/(\d{1,2}):(\d{2})/);
  if (m) return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  return null;
}

function minutesToHHMM(mins) {
  if (mins == null || mins < 0) return '--:--';
  const h = Math.floor(mins / 60) % 24;
  const m = mins % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * Minutes until event today.
 * Returns null if event already passed (do NOT notify late).
 * Handles overnight shifts for end time (end < start).
 */
function minutesUntilToday(eventMinutes, nowMinutes, { allowNextDay = false } = {}) {
  if (eventMinutes == null) return null;
  let diff = eventMinutes - nowMinutes;
  if (diff < 0 && allowNextDay) diff += 24 * 60;
  return diff;
}

function isInReminderWindow(diffMinutes) {
  if (diffMinutes == null) return false;
  // STRICT: only before the event, never after
  if (diffMinutes < 0) return false;
  const min = REMINDER_MINUTES_BEFORE - WINDOW_TOLERANCE;
  const max = REMINDER_MINUTES_BEFORE + WINDOW_TOLERANCE;
  return diffMinutes >= min && diffMinutes <= max;
}

// ═══════════════════════════════════════════════════════════
// CRM follow-ups (uses SQL GETDATE — ensure DB timezone is OK)
// ═══════════════════════════════════════════════════════════
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
        AND DATEDIFF(MINUTE, GETDATE(), o.NextFollowUpDate) > 0
    `);

    for (const row of result.recordset || []) {
      const diff = row.DiffMinutes;
      const username = row.Username;
      const oppId = row.OpportunityID;
      const clientName = row.ClientName || 'العميل';
      const productName = row.InterestedProduct ? `(${row.InterestedProduct})` : '';
      if (!username || diff == null || diff <= 0) continue;

      if (diff >= 110 && diff <= 130) {
        const cacheKey = `opp_${oppId}_2h`;
        if (await tryClaimSend(cacheKey)) {
          await sendNotificationToUser(
            username,
            '⏰ تذكير بمتابعة عميل',
            `أهلاً يا ${username}، لديك متابعة مع العميل ${clientName} ${productName} خلال ساعتين!`,
            'SalesOpportunities',
            oppId,
            'opportunity_detail_screen',
            `DEDUP:${cacheKey}`
          );
        }
      }

      if (diff >= 1410 && diff <= 1450) {
        const cacheKey = `opp_${oppId}_1d`;
        if (await tryClaimSend(cacheKey)) {
          await sendNotificationToUser(
            username,
            '📅 تذكير بمتابعة غداً',
            `أهلاً يا ${username}، نذكرك بموعد متابعة العميل ${clientName} ${productName} غداً.`,
            'SalesOpportunities',
            oppId,
            'opportunity_detail_screen',
            `DEDUP:${cacheKey}`
          );
        }
      }
    }
  } catch (err) {
    console.error('خطأ في فحص متابعات الـ CRM:', err);
  }
}

// ═══════════════════════════════════════════════════════════
// Shift check-in / check-out reminders (Egypt local)
// ═══════════════════════════════════════════════════════════
async function checkShiftReminders() {
  try {
    const pool = await connectDB();
    const egypt = getEgyptNowParts();
    if (process.env.SCHEDULER_VERBOSE === 'true') {
      console.log(`[Shifts] Egypt now = ${egypt.display} | weekday=${egypt.weekday}`);
    }

    // حسم حتمي: شيفت حالي واحد لكل موظف — أحدث EffectiveFrom يغطي
    // اليوم (OUTER APPLY + TOP 1 + ORDER BY EffectiveFrom DESC)،
    // حتى لا تتكرر التذكيرات عند وجود سجلات متداخلة لنفس الموظف.
    const result = await pool.request().query(`
      SELECT
        s.EmployeeShiftID,
        s.EmployeeID,
        s.StartTime,
        s.EndTime,
        s.BiometricCode,
        s.OffDay1,
        s.OffDay2,
        u.Username,
        e.FullName
      FROM Employees e
      INNER JOIN Users u ON e.EmployeeID = u.employeeID
      OUTER APPLY (
        SELECT TOP 1 EmployeeShiftID, EmployeeID, StartTime, EndTime,
                     BiometricCode, OffDay1, OffDay2
        FROM EmployeeShifts
        WHERE EmployeeID = e.EmployeeID
          AND CAST(GETDATE() AS DATE) >= CAST(EffectiveFrom AS DATE)
          AND (EffectiveTo IS NULL OR CAST(GETDATE() AS DATE) <= CAST(EffectiveTo AS DATE))
        ORDER BY EffectiveFrom DESC
      ) s
      WHERE ISNULL(u.IsActive, 1) = 1
        AND s.EmployeeShiftID IS NOT NULL
    `);

    for (const shift of result.recordset || []) {
      const username = shift.Username;
      const bioCode = shift.BiometricCode;
      if (!username) continue;

      // Skip off days. Numbering note: JS Date.getDay() numbering
      // (0=Sunday..6=Saturday) matches the stored .NET DayOfWeek bytes
      // in OffDay1/OffDay2 exactly, and egypt.weekday above is already
      // converted to that same getDay-style numbering.
      // When BOTH off-days are unset (NULL) — e.g. shifts created before
      // off-days existed — the default weekly rest is Friday(5) +
      // Saturday(6), mirroring Blazor's IsEmployeeOffDay default.
      let off1 = shift.OffDay1 != null ? Number(shift.OffDay1) : null;
      let off2 = shift.OffDay2 != null ? Number(shift.OffDay2) : null;
      if (off1 == null && off2 == null) {
        off1 = 5; // Friday
        off2 = 6; // Saturday
      }
      if (off1 === egypt.weekday || off2 === egypt.weekday) continue;

      // ── Check-in reminder ────────────────────────────────
      const startMins = timeToMinutes(shift.StartTime);
      const diffStart = minutesUntilToday(startMins, egypt.totalMinutes);

      if (isInReminderWindow(diffStart)) {
        let alreadyIn = false;
        if (bioCode != null) {
          const attendanceCheck = await pool
            .request()
            .input('bioCode', sql.Int, bioCode)
            .input('today', sql.VarChar(10), egypt.dateStr)
            .query(`
              SELECT TOP 1 AttendanceID, TimeIn
              FROM Attendance
              WHERE BiometricCode = @bioCode
                AND CAST(LogDate AS DATE) = CAST(@today AS DATE)
            `);
          alreadyIn =
            attendanceCheck.recordset.length > 0 &&
            attendanceCheck.recordset[0].TimeIn != null;
        }

        if (!alreadyIn) {
          const cacheKey = `shift_in_${shift.EmployeeShiftID}_${egypt.dateStr}`;
          if (await tryClaimSend(cacheKey)) {
            const startTimeStr = minutesToHHMM(startMins);
            await sendNotificationToUser(
              username,
              '⏱️ تذكير بموعد الحضور',
              `أهلاً يا ${username}، اقترب موعد شفت الحضور (${startTimeStr}) خلال ${REMINDER_MINUTES_BEFORE} دقيقة. لا تنسَ تسجيل البصمة!`,
              'Attendance',
              shift.EmployeeShiftID,
              'attendance_screen'
            );
            console.log(
              `✅ check-in reminder → ${username} @ ${startTimeStr} (diff=${diffStart}m)`
            );
          }
        }
      }

      // ── Check-out reminder ───────────────────────────────
      const endMins = timeToMinutes(shift.EndTime);
      // overnight: if end < start, end is next calendar morning
      const overnight = startMins != null && endMins != null && endMins < startMins;
      const diffEnd = minutesUntilToday(endMins, egypt.totalMinutes, {
        allowNextDay: overnight,
      });

      if (isInReminderWindow(diffEnd)) {
        let hasCheckedIn = false;
        let hasCheckedOut = false;
        if (bioCode != null) {
          const attendanceCheck = await pool
            .request()
            .input('bioCode', sql.Int, bioCode)
            .input('today', sql.VarChar(10), egypt.dateStr)
            .query(`
              SELECT TOP 1 AttendanceID, TimeIn, TimeOut
              FROM Attendance
              WHERE BiometricCode = @bioCode
                AND CAST(LogDate AS DATE) = CAST(@today AS DATE)
            `);
          const attendance = attendanceCheck.recordset[0];
          hasCheckedIn = !!(attendance && attendance.TimeIn != null);
          hasCheckedOut = !!(attendance && attendance.TimeOut != null);
        }

        // Only remind checkout if they checked in (or we can't know bio)
        if ((hasCheckedIn || bioCode == null) && !hasCheckedOut) {
          const cacheKey = `shift_out_${shift.EmployeeShiftID}_${egypt.dateStr}`;
          if (await tryClaimSend(cacheKey)) {
            const endTimeStr = minutesToHHMM(endMins);
            await sendNotificationToUser(
              username,
              '🏁 تذكير بموعد الانصراف',
              `أهلاً يا ${username}، سينتهي شفتك قريباً (${endTimeStr}) خلال ${REMINDER_MINUTES_BEFORE} دقيقة. تذكر تسجيل الانصراف عند المغادرة!`,
              'Attendance',
              shift.EmployeeShiftID,
              'attendance_screen'
            );
            console.log(
              `✅ check-out reminder → ${username} @ ${endTimeStr} (diff=${diffEnd}m)`
            );
          }
        }
      }
    }
  } catch (err) {
    console.error('خطأ في فحص تذكيرات الشفتات:', err);
  }
}

// ═══════════════════════════════════════════════════════════
// New leads safety-net: if Lead created recently without notify row
// (covers Meta import via Blazor that only wrote role-level rows)
// ═══════════════════════════════════════════════════════════
async function checkNewLeadsWithoutNotify() {
  try {
    const pool = await connectDB();
    // Leads created in last 15 minutes still "جديد"
    const result = await pool.request().query(`
      SELECT TOP 50
        l.LeadId, l.FullName, l.Phone, l.CampaignName, l.CreatedAt
      FROM LeadsCRM l
      WHERE l.LeadStatus = N'جديد'
        AND l.IsConverted = 0
        AND l.CreatedAt >= DATEADD(MINUTE, -15, GETDATE())
        AND NOT EXISTS (
          -- only count real user recipients (not role strings like 'Admin')
          SELECT 1 FROM Notifications n
          INNER JOIN Users u ON u.Username = n.RecipientUser
          WHERE n.RelatedTable = 'LeadsCRM'
            AND n.RelatedID = l.LeadId
            AND n.CreatedAt >= DATEADD(MINUTE, -30, GETDATE())
        )
      ORDER BY l.LeadId DESC
    `);

    for (const lead of result.recordset || []) {
      const cacheKey = `new_lead_${lead.LeadId}`;
      if (!(await tryClaimSend(cacheKey))) continue;

      const campaignPart = lead.CampaignName ? ` من حملة: ${lead.CampaignName}` : '';
      const title = '📥 Lead جديد وصل';
      const message = `وصل Lead جديد: ${lead.FullName} - ${lead.Phone}${campaignPart}. برجاء المتابعة.`;

      // Notify per-user SalesManager + Admin + GeneralManager (not role string)
      await notifyRolesUsers(
        ['Admin', 'SalesManager', 'GeneralManager'],
        title,
        message,
        'LeadsCRM',
        lead.LeadId,
        'lead_detail_screen',
        'SYSTEM_SCHEDULER'
      );
      console.log(`✅ new-lead notify LeadId=${lead.LeadId}`);
    }
  } catch (err) {
    // Table/column differences shouldn't crash scheduler
    console.error('checkNewLeadsWithoutNotify:', err.message);
  }
}

async function notifyRolesUsers(
  roles,
  title,
  message,
  relatedTable,
  relatedId,
  formName,
  createdBy
) {
  const pool = await connectDB();
  const req = pool.request();
  roles.forEach((r, i) => req.input(`r${i}`, sql.NVarChar(50), r));
  const inList = roles.map((_, i) => `@r${i}`).join(',');
  const users = await req.query(`
    SELECT Username, Role
    FROM Users
    WHERE ISNULL(IsActive, 1) = 1
      AND (
        Role IN (${inList})
        OR LOWER(REPLACE(ISNULL(Role,''), ' ', '')) IN (${roles
          .map((_, i) => `LOWER(REPLACE(@r${i}, ' ', ''))`)
          .join(',')})
      )
  `);

  for (const u of users.recordset || []) {
    if (!u.Username) continue;
    await sendNotificationToUser(
      u.Username,
      title,
      message,
      relatedTable,
      relatedId,
      formName,
      createdBy
    );
  }
}

// ═══════════════════════════════════════════════════════════
// Dedupe: memory + DB (survives restarts)
// ═══════════════════════════════════════════════════════════
async function tryClaimSend(cacheKey) {
  if (sentCache.has(cacheKey)) return false;
  sentCache.add(cacheKey);

  try {
    const pool = await connectDB();
    // Use Notifications as durable log: same title key in CreatedBy marker
    const marker = `DEDUP:${cacheKey}`;
    const existing = await pool
      .request()
      .input('marker', sql.NVarChar(200), marker)
      .query(`
        SELECT TOP 1 NotificationID
        FROM Notifications
        WHERE CreatedBy = @marker
          AND CreatedAt >= DATEADD(HOUR, -20, GETDATE())
      `);
    if (existing.recordset.length > 0) return false;

    // Claim slot with a tiny placeholder? We claim after send via CreatedBy on real notif.
    // Store claim in cache only; real notif uses createdBy SYSTEM_SCHEDULER + we also
    // check RelatedID+FormName for shift keys.
    return true;
  } catch {
    return true; // if DB check fails, allow once via memory
  }
}

async function alreadySentShiftNotif(username, formName, relatedId, todayDateStr) {
  try {
    const pool = await connectDB();
    const r = await pool
      .request()
      .input('user', sql.NVarChar(100), username)
      .input('form', sql.NVarChar(100), formName)
      .input('rid', sql.Int, relatedId || 0)
      .input('day', sql.VarChar(10), todayDateStr)
      .query(`
        SELECT TOP 1 NotificationID
        FROM Notifications
        WHERE RecipientUser = @user
          AND FormName = @form
          AND ISNULL(RelatedID, 0) = @rid
          AND CAST(CreatedAt AS DATE) = CAST(@day AS DATE)
          AND CreatedBy IN ('SYSTEM_SCHEDULER', 'SYSTEM')
      `);
    return r.recordset.length > 0;
  } catch {
    return false;
  }
}

// ═══════════════════════════════════════════════════════════
// Send
// ═══════════════════════════════════════════════════════════
async function sendNotificationToUser(
  username,
  title,
  message,
  relatedTable,
  relatedId,
  formName,
  createdBy = 'SYSTEM_SCHEDULER'
) {
  try {
    // Extra DB guard for shift reminders
    if (formName === 'attendance_screen' && relatedId) {
      const egypt = getEgyptNowParts();
      if (await alreadySentShiftNotif(username, formName, relatedId, egypt.dateStr)) {
        return;
      }
    }

    await notificationsQueries.createNotification({
      title,
      message,
      recipientUser: username,
      relatedTable,
      relatedId,
      formName,
      createdBy,
    });

    // createNotification already tries FCM; keep backup only if needed
    if (isFirebaseReady()) {
      // createNotification in queries already pushes — avoid double push if it does.
      // Leave as-is only when createNotification didn't push (older code paths).
    }
  } catch (err) {
    console.error(`❌ فشل إرسال الإشعار لـ ${username}:`, err.message);
  }
}


// ═══════════════════════════════════════════════════════════
// تذكيرات التسليم — متأخرة / اليوم (للمسؤولين المخولين فقط)
// ═══════════════════════════════════════════════════════════
async function checkDeliveryReminders() {
  const pool = await connectDB();

  try {
    // 1. جلب الإحصائيات
    const statsRes = await pool.request().query(`
      SELECT 
        COUNT(*) AS TotalPending,
        SUM(CASE WHEN DATEDIFF(DAY, GETDATE(), DueDate) < 0 THEN 1 ELSE 0 END) AS Overdue,
        SUM(CASE WHEN CAST(DueDate AS DATE) = CAST(GETDATE() AS DATE) THEN 1 ELSE 0 END) AS Today
      FROM Transactions
      WHERE TransactionType = 'Sale'
        AND (IsDelivered = 0 OR IsDelivered IS NULL)
        AND DueDate IS NOT NULL
    `);
    const stats = statsRes.recordset[0] || {};

    const overdue = stats.Overdue || 0;
    const today = stats.Today || 0;
    const total = stats.TotalPending || 0;

    if (overdue === 0 && today === 0) return;

    // 2. المستخدمون المخولون بالتسليمات (Admin + SalesManager + Sales + User)
    const usersRes = await pool.request().query(`
      SELECT Username FROM Users
      WHERE IsActive = 1
        AND (Role IN ('Admin', 'SalesManager', 'Sales', 'User')
             OR Username IN (
               SELECT u.Username FROM UserPermissions up
               INNER JOIN Permissions p ON up.PermissionID = p.PermissionID
               INNER JOIN Users u ON up.UserID = u.UserID
               WHERE p.FormName = 'frmInvoiceDeliveryStatus' AND up.CanView = 1
             ))
    `);
    const recipients = usersRes.recordset.map(r => r.Username);

    if (recipients.length === 0) return;

    // 3. منع التكرار: نتأكد إن نفس الرسالة مبعوتة اليوم للمستخدم
    const todayStr = new Date().toISOString().slice(0, 10);
    const dedupeKey = `delivery_${todayStr}_${overdue}_${today}`;

    // في ذاكرة
    if (sentCache.has(dedupeKey)) return;
    sentCache.add(dedupeKey);

    // 4. إرسال الإشعارات
    for (const username of recipients) {
      try {
        const title = overdue > 0
          ? `⚠️ تسليمات متأخرة (${overdue})`
          : `🔔 تسليمات اليوم (${today})`;
        const message = overdue > 0 && today > 0
          ? `لديك ${overdue} فاتورة متأخرة و ${today} فاتورة مستحقة اليوم`
          : overdue > 0
            ? `لديك ${overdue} فاتورة متأخرة عن موعد التسليم`
            : `لديك ${today} فاتورة موعد تسليمها اليوم`;

        // حفظ في الجدول (ليظهر في شاشة الإشعارات)
        await pool.request()
          .input('title', sql.NVarChar(200), title)
          .input('msg', sql.NVarChar(sql.MAX), message)
          .input('username', sql.NVarChar(100), username)
          .query(`
            INSERT INTO Notifications (Title, Message, RecipientUser, CreatedBy, FormName, RelatedTable, IsRead, CreatedAt)
            VALUES (@title, @msg, @username, 'System', 'frmInvoiceDeliveryStatus', 'Delivery', 0, GETDATE())
          `);

        // FCM فوري
        if (isFirebaseReady()) {
          const token = await notificationsQueries.getFcmToken(username);
          if (token) {
            await sendPushNotification(token, title, message, {
              formName: 'frmInvoiceDeliveryStatus',
              filter: overdue > 0 ? 'overdue' : 'today',
            });
          }
        }
      } catch (e) {
        console.error(`⚠️ فشل إشعار تسليم لـ ${username}:`, e.message);
      }
    }

    console.log(`📦 تذكير تسليمات: متأخرة=${overdue} اليوم=${today} → ${recipients.length} مستخدم`);
  } catch (err) {
    console.error('❌ خطأ في فحص تذكيرات التسليم:', err.message);
  }
}


// ═══════════════════════════════════════════════════════════
// Item 7 (Pkg2): 7-day advance delivery reminder — mirror of Blazor
// DeliveryReminderService (Services/DeliveryReminderService.cs):
// daily after 08:00 Cairo; DeliveryOfficer is reminded on realDate-7
// (sees real date), ProductionManager on displayedDate-7 (displayed =
// real - buffer days, default 4). Dedupe: audit marker in Audit_Log
// with key "{TransactionId}:{RealDate yyyyMMdd}:{Real|Masked}" and
// ActionType 'DeliveryAdvanceReminder' — checked before, written after.
let _lastAdvanceRunDate = null;

async function checkDeliveryAdvanceReminders() {
  try {
    const egypt = getEgyptNowParts();
    if (egypt.hour < 8) return;
    if (_lastAdvanceRunDate === egypt.dateStr) return;
    _lastAdvanceRunDate = egypt.dateStr;

    // Lazy require avoids a load cycle (delivery queries do not import notifications)
    const deliveryQueries = require('../delivery/delivery.queries');
    const pool = await connectDB();
    const target = new Date(`${egypt.dateStr}T00:00:00.000Z`);
    target.setUTCDate(target.getUTCDate() + 7);

    const classes = [
      { role: 'DeliveryOfficer', seesReal: true, classKey: 'Real' },
      { role: 'ProductionManager', seesReal: false, classKey: 'Masked' },
    ];
    for (const cls of classes) {
      const appointments = await deliveryQueries.getAppointmentsDueOn(target, cls.seesReal);
      for (const appt of appointments) {
        const real = appt.RealDate instanceof Date ? appt.RealDate : new Date(appt.RealDate);
        const realKey = `${real.getUTCFullYear()}${String(real.getUTCMonth() + 1).padStart(2, '0')}${String(real.getUTCDate()).padStart(2, '0')}`;
        const marker = `${appt.TransactionID}:${realKey}:${cls.classKey}`;
        const existing = await pool.request()
          .input('marker', sql.NVarChar(200), marker)
          .query(`
            SELECT TOP 1 AuditID FROM [dbo].[Audit_Log]
            WHERE TableName = N'Transactions' AND ActionType = N'DeliveryAdvanceReminder' AND PrimaryKeyValue = @marker
          `);
        if (existing.recordset.length > 0) continue;

        const display = appt.DisplayDate instanceof Date ? appt.DisplayDate : new Date(appt.DisplayDate);
        const displayStr = `${display.getUTCFullYear()}/${String(display.getUTCMonth() + 1).padStart(2, '0')}/${String(display.getUTCDate()).padStart(2, '0')}`;
        const qty = Number(appt.RemainingQty || 0);
        const message = `فاتورة ${appt.ReferenceNumber || `#${appt.TransactionID}`} — العميل: ${appt.PartyName || ''}. موعد التسليم كما يظهر لك: ${displayStr} (بعد 7 أيام). بنود مستحقة في هذا الموعد: ${appt.DueLineCount} — كمية متبقية: ${qty % 1 === 0 ? qty.toFixed(0) : qty}.`;
        await notifyRolesUsers(
          [cls.role],
          '⏰ تسليم بعد أسبوع',
          message,
          'Transactions',
          appt.TransactionID,
          'sales-delivery-status',
          'system'
        );
        await pool.request()
          .input('marker', sql.NVarChar(200), marker)
          .input('newData', sql.NVarChar(sql.MAX), JSON.stringify({
            TransactionId: appt.TransactionID,
            Reference: appt.ReferenceNumber,
            PartyName: appt.PartyName,
            RealDate: real.toISOString().slice(0, 10),
            DisplayDate: display.toISOString().slice(0, 10),
            Class: cls.classKey,
            Role: cls.role,
            DueLineCount: appt.DueLineCount,
            RemainingQty: appt.RemainingQty,
          }))
          .query(`
            INSERT INTO [dbo].[Audit_Log] (TableName, ActionType, PrimaryKeyValue, OldData, NewData, ActionDate, LoginName, AppName, AccessUserName)
            VALUES (N'Transactions', N'DeliveryAdvanceReminder', @marker, NULL, @newData, GETDATE(), N'system', N'COCOBOLO API Scheduler', N'system')
          `);
      }
    }
  } catch (err) {
    console.error('checkDeliveryAdvanceReminders:', err.message);
  }
}

module.exports = {
  checkDeliveryReminders,
  checkDeliveryAdvanceReminders,
  startNotificationScheduler,
  checkShiftReminders,
  checkCrmFollowUps,
  checkNewLeadsWithoutNotify,
  getEgyptNowParts,
  timeToMinutes,
};
