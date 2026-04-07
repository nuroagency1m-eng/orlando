const jwt = require('jsonwebtoken');
const { Users } = require('./database');

const crypto = require('crypto');

// Use environment variable in production, or generate a persistent random key
function getJwtSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  const fs = require('fs');
  const path = require('path');
  const secretFile = path.join(__dirname, '.jwt_secret');
  try {
    if (fs.existsSync(secretFile)) return fs.readFileSync(secretFile, 'utf8').trim();
  } catch(e) {}
  const secret = crypto.randomBytes(64).toString('hex');
  try { fs.writeFileSync(secretFile, secret, { mode: 0o600 }); } catch(e) {}
  return secret;
}
const JWT_SECRET = getJwtSecret();
const JWT_EXPIRES = '7d';

function generateToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username, email: user.email, role: user.role },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES }
  );
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch(e) {
    return null;
  }
}

// Middleware: require authentication
async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token requerido' });
  }
  const token = authHeader.split(' ')[1];
  const decoded = verifyToken(token);
  if (!decoded) {
    return res.status(401).json({ error: 'Token invalido o expirado' });
  }
  const user = await Users.findById(decoded.id);
  if (!user) {
    return res.status(401).json({ error: 'Usuario no encontrado' });
  }
  if (user.status !== 'activo') {
    return res.status(403).json({ error: 'Cuenta no activa', status: user.status });
  }
  req.user = user;

  // Verificar recompra vigente (excepto admin y rutas necesarias para cargar el panel)
  const path = req.originalUrl || req.url;
  const exemptPaths = ['/api/recompras', '/api/auth/', '/api/user/profile', '/api/bots', '/api/sales'];
  const isExempt = user.role === 'admin' || exemptPaths.some(p => path.startsWith(p));
  if (!isExempt) {
    const { Recompras } = require('./database');
    const hasActive = await Recompras.hasActiveRecompra(user.id);
    if (!hasActive) {
      return res.status(403).json({ error: 'Recompra vencida o no aprobada', recompra_required: true });
    }
  }

  next();
}

// Middleware: require admin role
function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Acceso denegado: solo administradores' });
    }
    next();
  });
}

module.exports = { generateToken, verifyToken, requireAuth, requireAdmin, JWT_SECRET };
