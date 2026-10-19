const jwt = require('jsonwebtoken');
const { sql, connectDB } = require('./database');

const DEV_SECRET = 'cocobolo-dev-only-change-this-secret';
let warnedAboutSecret = false;

function getJwtSecret() {
  const secret = process.env.AUTH_JWT_SECRET || process.env.JWT_SECRET;
  if (secret) return secret;

  if (!warnedAboutSecret) {
    warnedAboutSecret = true;
    console.warn('⚠️ AUTH_JWT_SECRET غير مضبوط. يتم استخدام مفتاح تطوير مؤقت؛ يجب تغييره على السيرفر.');
  }
  return DEV_SECRET;
}

function issueAccessToken(user, { rememberMe = false } = {}) {
  const expiresIn = rememberMe ? '30d' : '12h';
  return jwt.sign(
    {
      sub: String(user.UserID),
      username: user.Username,
      role: user.Role || '',
      employeeId: user.employeeID || null,
      type: 'access',
    },
    getJwtSecret(),
    {
      expiresIn,
      issuer: 'cocobolo-api',
      audience: 'cocobolo-app',
    },
  );
}

function extractBearerToken(req) {
  const header = String(req.headers.authorization || '');
  if (!header.toLowerCase().startsWith('bearer ')) return null;
  const token = header.slice(7).trim();
  return token || null;
}

async function loadAuthenticatedUser(userId) {
  const pool = await connectDB();
  const userResult = await pool.request()
    .input('userId', sql.Int, userId)
    .query(`
      SELECT UserID, Username, FullName, Email, employeeID, Role, IsActive
      FROM Users
      WHERE UserID = @userId AND IsActive = 1
    `);

  const user = userResult.recordset[0];
  if (!user) return null;

  const permissionsResult = await pool.request()
    .input('userId', sql.Int, userId)
    .query(`
      SELECT p.PermissionID, p.PermissionName, p.FormName, p.Category,
             up.CanView, up.CanAdd, up.CanEdit, up.CanDelete
      FROM UserPermissions up
      INNER JOIN Permissions p ON up.PermissionID = p.PermissionID
      WHERE up.UserID = @userId
    `);

  const permissions = {};
  const claims = new Set();
  for (const row of permissionsResult.recordset) {
    const formName = String(row.FormName || '').trim();
    if (!formName) continue;

    permissions[formName] = {
      permissionId: row.PermissionID || 0,
      permissionName: row.PermissionName || '',
      category: row.Category || '',
      canView: row.CanView === true || row.CanView === 1,
      canAdd: row.CanAdd === true || row.CanAdd === 1,
      canEdit: row.CanEdit === true || row.CanEdit === 1,
      canDelete: row.CanDelete === true || row.CanDelete === 1,
    };

    if (permissions[formName].canView) claims.add(`${formName}:View`);
    if (permissions[formName].canAdd) claims.add(`${formName}:Add`);
    if (permissions[formName].canEdit) claims.add(`${formName}:Edit`);
    if (permissions[formName].canDelete) claims.add(`${formName}:Delete`);
  }

  return {
    userId: user.UserID,
    username: user.Username,
    fullName: user.FullName,
    email: user.Email,
    employeeId: user.employeeID,
    role: user.Role || '',
    permissions,
    claims,
    user,
  };
}

async function authenticate(req, res, next) {
  try {
    const token = extractBearerToken(req);
    if (!token) {
      return res.status(401).json({ success: false, message: 'الجلسة غير موجودة. سجل الدخول مرة أخرى.' });
    }

    let decoded;
    try {
      decoded = jwt.verify(token, getJwtSecret(), {
        issuer: 'cocobolo-api',
        audience: 'cocobolo-app',
      });
    } catch (error) {
      const expired = error?.name === 'TokenExpiredError';
      return res.status(401).json({
        success: false,
        code: expired ? 'TOKEN_EXPIRED' : 'INVALID_TOKEN',
        message: expired ? 'انتهت الجلسة. سجل الدخول مرة أخرى.' : 'جلسة غير صالحة.',
      });
    }

    const userId = Number(decoded.sub);
    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(401).json({ success: false, message: 'جلسة غير صالحة.' });
    }

    // نقرأ المستخدم والصلاحيات الحالية من DB في كل طلب حساس حتى ينعكس إيقاف المستخدم/تغيير الصلاحية فوراً.
    const auth = await loadAuthenticatedUser(userId);
    if (!auth) {
      return res.status(401).json({ success: false, message: 'المستخدم غير نشط أو غير موجود.' });
    }

    req.auth = auth;
    req.user = auth.user; // توافق تدريجي مع Controllers القديمة
    return next();
  } catch (error) {
    console.error('authenticate middleware:', error);
    return res.status(500).json({ success: false, message: 'تعذر التحقق من الجلسة.' });
  }
}

async function optionalAuthenticate(req, _res, next) {
  const token = extractBearerToken(req);
  if (!token) return next();
  try {
    const decoded = jwt.verify(token, getJwtSecret(), {
      issuer: 'cocobolo-api',
      audience: 'cocobolo-app',
    });
    const userId = Number(decoded.sub);
    if (Number.isInteger(userId) && userId > 0) {
      req.auth = await loadAuthenticatedUser(userId);
      req.user = req.auth?.user;
    }
  } catch (_) {
    // Optional means old/public endpoints continue; protected endpoints use authenticate.
  }
  return next();
}

function requirePolicy(policy, message = 'غير مصرح لك بهذا الإجراء') {
  return (req, res, next) => {
    try {
      if (req.auth && policy(req.auth, req)) return next();
      return res.status(403).json({ success: false, message });
    } catch (error) {
      console.error('requirePolicy:', error);
      return res.status(403).json({ success: false, message });
    }
  };
}

module.exports = {
  authenticate,
  optionalAuthenticate,
  requirePolicy,
  issueAccessToken,
  loadAuthenticatedUser,
  extractBearerToken,
};
