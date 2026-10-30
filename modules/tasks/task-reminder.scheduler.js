const cron = require('node-cron');
const { sql, connectDB } = require('../../core/database');
const notificationsQueries = require('../notifications/notifications.queries');

// ═══════════════════════════════════════════════════════════
// مجدول تذكيرات التكليفات العامة — مرآة GeneralTaskReminderService
// في بلازور (general-tasks-1-fixes.patch):
//  أ) تنبيه قبل الموعد للمكلَّف: قبل الاستحقاق بـ ReminderMinutes
//     (افتراضي ٣٠ دقيقة؛ الوقت الافتراضي ١٠:٠٠ عند غياب DueTime) —
//     مرة واحدة لكل (تكليف × موعد).
//  ب) موجز متأخرات صباحي ٠٨:٠٥ بتوقيت القاهرة للمكلَّف والمنشئ —
//     مرة واحدة لكل (تكليف × يوم).
//  ج) تصعيد: متأخر ≥ ٣ أيام ← دور المدير العام — مرة واحدة لكل
//     (تكليف × تاريخ استحقاق).
// النطاق: تكليفات عامة فقط (TaskScope = General)، نشطة،
// Pending/In Progress.
// منع التكرار: علامات Audit_Log بصيغ بلازور الحرفية
// (TaskPreDue:{id}:{yyyyMMddHHmm} / TaskOverdue:{id}:{yyyyMMdd} /
//  TaskEscalation:{id}:{yyyyMMdd}) وأفعال GeneralTask*Reminder/
// Escalation؛ وعند غياب الجدول ذاكرة داخل العملية احتياطيًا.
// كل استعلام معزول الفشل — المجدول لا يُسقط الخادم أبدًا.
// ═══════════════════════════════════════════════════════════

const TZ = process.env.APP_TIMEZONE || 'Africa/Cairo';
const SYSTEM_USER = 'system';
const PRE_DUE_ACTION = 'GeneralTaskPreDueReminder';
const OVERDUE_ACTION = 'GeneralTaskOverdueReminder';
const ESCALATION_ACTION = 'GeneralTaskEscalation';

const memoryMarkers = new Set();
let started = false;

function cairoNowParts() {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date()).map((p) => [p.type, p.value]));
  const hour = parseInt(parts.hour === '24' ? '0' : parts.hour, 10);
  return {
    dateStr: `${parts.year}-${parts.month}-${parts.day}`,
    totalMinutes: hour * 60 + parseInt(parts.minute, 10),
  };
}

function dateToStr(d) {
  if (!d) return null;
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return null;
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function dayNumber(dateStr) {
  const [y, m, d] = String(dateStr).split('-').map((x) => parseInt(x, 10));
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
}

function compactDate(dateStr) {
  return String(dateStr).replace(/-/g, '');
}

function timeToMinutes(timeVal) {
  if (timeVal == null) return null;
  if (typeof timeVal === 'string') {
    const iso = timeVal.match(/T(\d{2}):(\d{2})/);
    if (iso) return parseInt(iso[1], 10) * 60 + parseInt(iso[2], 10);
    const m = timeVal.match(/(\d{1,2}):(\d{2})/);
    if (m) return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
    return null;
  }
  if (timeVal instanceof Date && !Number.isNaN(timeVal.getTime())) {
    return timeVal.getUTCHours() * 60 + timeVal.getUTCMinutes();
  }
  if (typeof timeVal === 'object' && timeVal.hours != null) {
    return (timeVal.hours | 0) * 60 + (timeVal.minutes | 0);
  }
  return null;
}

async function markerExists(pool, action, marker) {
  if (memoryMarkers.has(marker)) return true;
  try {
    const res = await pool.request()
      .input('action', sql.NVarChar(100), action)
      .input('marker', sql.NVarChar(100), marker)
      .query(`
        SELECT TOP 1 1 AS Hit FROM Audit_Log
        WHERE TableName = N'CRM_Tasks' AND ActionType = @action AND PrimaryKeyValue = @marker
      `);
    return res.recordset.length > 0;
  } catch (_) {
    // غياب جدول التدقيق: الاعتماد على ذاكرة العملية فقط.
    return false;
  }
}

async function writeMarker(pool, action, marker, payload) {
  memoryMarkers.add(marker);
  try {
    await pool.request()
      .input('action', sql.NVarChar(100), action)
      .input('marker', sql.NVarChar(100), marker)
      .input('data', sql.NVarChar(sql.MAX), JSON.stringify(payload || {}))
      .query(`
        INSERT INTO Audit_Log (TableName, ActionType, PrimaryKeyValue, NewData, ActionDate, LoginName, AppName)
        VALUES (N'CRM_Tasks', @action, @marker, @data, GETDATE(), N'system', N'COCOBOLO API')
      `);
  } catch (_) { /* العلامة محفوظة في الذاكرة */ }
}

async function notifyEmployee(pool, employeeId, title, message, taskId) {
  try {
    const res = await pool.request()
      .input('empId', sql.Int, employeeId)
      .query(`SELECT TOP 1 Username FROM Users WHERE EmployeeID = @empId AND ISNULL(IsActive,1)=1`);
    const username = res.recordset[0]?.Username;
    if (!username) return false;
    await notificationsQueries.createNotification({
      title, message, recipientUser: username,
      relatedTable: 'CRM_Tasks', relatedId: taskId,
      formName: 'crm/general-tasks', createdBy: SYSTEM_USER,
    });
    return true;
  } catch (e) {
    console.error('task reminder notify employee:', e.message);
    return false;
  }
}

async function notifyUsername(username, title, message, taskId) {
  if (!username) return;
  try {
    await notificationsQueries.createNotification({
      title, message, recipientUser: username,
      relatedTable: 'CRM_Tasks', relatedId: taskId,
      formName: 'crm/general-tasks', createdBy: SYSTEM_USER,
    });
  } catch (e) {
    console.error('task reminder notify user:', e.message);
  }
}

async function notifyGeneralManagers(pool, title, message, taskId) {
  try {
    const res = await pool.request().query(`
      SELECT Username FROM Users
      WHERE ISNULL(IsActive,1)=1
        AND LOWER(REPLACE(ISNULL(Role,''), ' ', '')) = 'generalmanager'
    `);
    for (const u of res.recordset || []) {
      await notifyUsername(u.Username, title, message, taskId);
    }
  } catch (e) {
    console.error('task reminder notify GMs:', e.message);
  }
}

async function loadOpenGeneralTasks(pool) {
  const res = await pool.request().query(`
    SELECT t.TaskID, t.AssignedTo, t.TaskDescription, t.DueDate, t.DueTime,
           t.ReminderMinutes, t.CreatedBy, e.FullName AS AssignedToName
    FROM CRM_Tasks t
    LEFT JOIN Employees e ON t.AssignedTo = e.EmployeeID
    WHERE t.IsActive = 1 AND t.TaskScope = N'General'
      AND t.Status IN (N'Pending', N'In Progress')
  `);
  return res.recordset;
}

// أ) تنبيه قبل الموعد — كل ٥ دقائق
async function checkPreDue() {
  const pool = await connectDB();
  const now = cairoNowParts();
  const nowAbs = dayNumber(now.dateStr) * 1440 + now.totalMinutes;
  const tasks = await loadOpenGeneralTasks(pool);
  for (const t of tasks) {
    try {
      const dueDateStr = dateToStr(t.DueDate);
      if (!dueDateStr) continue;
      const dueMinutes = timeToMinutes(t.DueTime) ?? 600; // افتراضي 10:00
      const dueAbs = dayNumber(dueDateStr) * 1440 + dueMinutes;
      const lead = Number(t.ReminderMinutes) > 0 ? Number(t.ReminderMinutes) : 30;
      const diff = dueAbs - nowAbs;
      if (diff <= 0 || diff > lead) continue;

      const hh = String(Math.floor(dueMinutes / 60)).padStart(2, '0');
      const mm = String(dueMinutes % 60).padStart(2, '0');
      const marker = `TaskPreDue:${t.TaskID}:${compactDate(dueDateStr)}${hh}${mm}`;
      if (await markerExists(pool, PRE_DUE_ACTION, marker)) continue;

      const sent = await notifyEmployee(pool, t.AssignedTo, '⏰ تذكير بتكليف قريب',
        `تكليف مُسند إليك يقترب موعده.\nالمهمة: ${t.TaskDescription}\nالمطلوب قبل: ${dueDateStr} الساعة ${hh}:${mm}`,
        t.TaskID);
      if (sent) {
        await writeMarker(pool, PRE_DUE_ACTION, marker, { TaskId: t.TaskID, AssignedTo: t.AssignedTo, LeadMinutes: lead });
      }
    } catch (e) {
      console.error('task pre-due check (task):', e.message);
    }
  }
}

// ب+ج) موجز المتأخرات الصباحي والتصعيد — ٠٨:٠٥ القاهرة
async function checkOverdueDigest() {
  const pool = await connectDB();
  const now = cairoNowParts();
  const todayNum = dayNumber(now.dateStr);
  const tasks = await loadOpenGeneralTasks(pool);
  for (const t of tasks) {
    try {
      const dueDateStr = dateToStr(t.DueDate);
      if (!dueDateStr) continue;
      const lateDays = todayNum - dayNumber(dueDateStr);
      if (lateDays <= 0) continue;

      const overdueMarker = `TaskOverdue:${t.TaskID}:${compactDate(now.dateStr)}`;
      if (!(await markerExists(pool, OVERDUE_ACTION, overdueMarker))) {
        await notifyEmployee(pool, t.AssignedTo, '🔴 تكليف متأخر',
          `تكليف مُسند إليك تجاوز موعده ولم يكتمل بعد (متأخر ${lateDays} يوم).\nالمهمة: ${t.TaskDescription}\nكان المطلوب قبل: ${dueDateStr}`,
          t.TaskID);
        if (t.CreatedBy) {
          await notifyUsername(t.CreatedBy, '🔴 تكليف متأخر أنشأته',
            `تكليف أنشأته تجاوز موعده ولم يكتمل بعد (متأخر ${lateDays} يوم).\nالمكلَّف: ${t.AssignedToName || 'غير محدد'}\nالمهمة: ${t.TaskDescription}\nكان المطلوب قبل: ${dueDateStr}`,
            t.TaskID);
        }
        await writeMarker(pool, OVERDUE_ACTION, overdueMarker, { TaskId: t.TaskID, AssignedTo: t.AssignedTo, CreatedBy: t.CreatedBy, LateDays: lateDays });
      }

      if (lateDays >= 3) {
        const escMarker = `TaskEscalation:${t.TaskID}:${compactDate(dueDateStr)}`;
        if (!(await markerExists(pool, ESCALATION_ACTION, escMarker))) {
          await notifyGeneralManagers(pool, '🚨 تصعيد: تكليف متأخر ٣ أيام',
            `تكليف عام متأخر ${lateDays} يوم دون إتمام.\nالمكلَّف: ${t.AssignedToName || 'غير محدد'}\nأنشأه: ${t.CreatedBy || '—'}\nالمهمة: ${t.TaskDescription}\nكان المطلوب قبل: ${dueDateStr}`,
            t.TaskID);
          await writeMarker(pool, ESCALATION_ACTION, escMarker, { TaskId: t.TaskID, AssignedTo: t.AssignedTo, CreatedBy: t.CreatedBy, LateDays: lateDays });
        }
      }
    } catch (e) {
      console.error('task overdue digest (task):', e.message);
    }
  }
}

function startTaskReminderScheduler() {
  if (started) return;
  started = true;
  cron.schedule('*/5 * * * *', async () => {
    try { await checkPreDue(); } catch (e) { console.error('task pre-due check:', e.message); }
  }, { timezone: TZ });
  cron.schedule('5 8 * * *', async () => {
    try { await checkOverdueDigest(); } catch (e) { console.error('task overdue digest:', e.message); }
  }, { timezone: TZ });
  console.log(`⏰ Task reminder scheduler مفعّل | timezone=${TZ}`);
}

module.exports = { startTaskReminderScheduler, checkPreDue, checkOverdueDigest };
