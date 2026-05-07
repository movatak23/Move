const jwt = require('jsonwebtoken');
const SECRET = process.env.JWT_SECRET || 'move-comissoes-secret-2024';

function auth(...perfisPermitidos) {
  return (req, res, next) => {
    const header = req.headers.authorization || '';
    const token = header.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Token não fornecido' });

    try {
      const decoded = jwt.verify(token, SECRET);
      if (perfisPermitidos.length && !perfisPermitidos.includes(decoded.perfil)) {
        return res.status(403).json({ error: 'Sem permissão' });
      }
      req.user = decoded;
      next();
    } catch {
      res.status(401).json({ error: 'Token inválido ou expirado' });
    }
  };
}

module.exports = { auth, SECRET };
