require('dotenv').config();
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 20,
  idleTimeoutMillis: 30000,
});

// ══════════════════════════════════════════════════════════════════════════════
//  SCHEMA — PostgreSQL
// ══════════════════════════════════════════════════════════════════════════════
async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT UNIQUE,
        email TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        nombre TEXT NOT NULL DEFAULT '',
        apellido TEXT NOT NULL DEFAULT '',
        fecha_nacimiento TEXT DEFAULT '',
        ciudad TEXT DEFAULT '',
        usuario_fase TEXT DEFAULT '',
        patrocinador_fase TEXT DEFAULT '',
        foto_factura TEXT DEFAULT '',
        foto_perfil TEXT DEFAULT '',
        rango_fase TEXT DEFAULT '',
        role TEXT NOT NULL DEFAULT 'user',
        status TEXT NOT NULL DEFAULT 'pendiente',
        max_bots INTEGER NOT NULL DEFAULT 1,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS bots (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL DEFAULT 'Nuevo Bot',
        icon TEXT NOT NULL DEFAULT '🤖',
        active INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'active',
        openai_key TEXT DEFAULT '',
        model TEXT DEFAULT 'gpt-5.1',
        report_number TEXT DEFAULT '',
        system_prompt TEXT DEFAULT '',
        msg1_limit INTEGER DEFAULT 500,
        msg2_limit INTEGER DEFAULT 500,
        msg3_limit INTEGER DEFAULT 500,
        strict_json INTEGER DEFAULT 1,
        seg1 INTEGER DEFAULT 15,
        seg2 INTEGER DEFAULT 400,
        wa_status TEXT DEFAULT 'disconnected',
        wa_phone TEXT DEFAULT '',
        wa_last_connected TEXT DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS products (
        id TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        nombre TEXT NOT NULL DEFAULT '',
        descripcion TEXT DEFAULT '',
        beneficios TEXT DEFAULT '',
        modo_uso TEXT DEFAULT '',
        advertencias TEXT DEFAULT '',
        moneda TEXT DEFAULT 'BOB',
        precio_unitario TEXT DEFAULT '',
        precio_promo2 TEXT DEFAULT '',
        precio_super6 TEXT DEFAULT '',
        precio_oferta TEXT DEFAULT '',
        info_envio TEXT DEFAULT '',
        cobertura TEXT DEFAULT '',
        hooks TEXT DEFAULT '',
        imagenes TEXT DEFAULT '[]',
        mas_imagenes TEXT DEFAULT '[]',
        testimonios TEXT DEFAULT '[]',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS conversations (
        id SERIAL PRIMARY KEY,
        bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        phone TEXT NOT NULL,
        push_name TEXT DEFAULT '',
        last_message_at TIMESTAMPTZ DEFAULT NOW(),
        last_bot_reply_at TIMESTAMPTZ DEFAULT NULL,
        follow_up_count INTEGER DEFAULT 0,
        status TEXT DEFAULT 'active',
        latitude REAL DEFAULT NULL,
        longitude REAL DEFAULT NULL,
        jid_suffix TEXT DEFAULT 's.whatsapp.net'
      );

      CREATE TABLE IF NOT EXISTS sales (
        id TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        phone TEXT NOT NULL DEFAULT '',
        client_name TEXT DEFAULT '',
        product_name TEXT DEFAULT '',
        product_id TEXT DEFAULT '',
        amount TEXT DEFAULT '',
        currency TEXT DEFAULT 'BOB',
        city TEXT DEFAULT '',
        latitude REAL DEFAULT NULL,
        longitude REAL DEFAULT NULL,
        report_text TEXT DEFAULT '',
        bot_name TEXT DEFAULT '',
        status TEXT DEFAULT 'confirmada',
        notes TEXT DEFAULT '',
        deleted INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS conversation_history (
        id SERIAL PRIMARY KEY,
        bot_id TEXT NOT NULL,
        phone TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS wa_auth_state (
        bot_id TEXT NOT NULL,
        data_key TEXT NOT NULL,
        data_value TEXT NOT NULL DEFAULT '{}',
        PRIMARY KEY (bot_id, data_key)
      );

      CREATE TABLE IF NOT EXISTS wa_msg_store (
        bot_id TEXT NOT NULL,
        msg_id TEXT NOT NULL,
        data TEXT NOT NULL DEFAULT '{}',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (bot_id, msg_id)
      );
    `);

    // Add created_at column to wa_msg_store if missing (for existing DBs)
    await client.query(`
      DO $$ BEGIN
        ALTER TABLE wa_msg_store ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
      EXCEPTION WHEN others THEN NULL;
      END $$;
    `);

    // Indices
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_bots_user ON bots(user_id);
      CREATE INDEX IF NOT EXISTS idx_products_bot ON products(bot_id);
      CREATE INDEX IF NOT EXISTS idx_conversations_bot ON conversations(bot_id);
      CREATE INDEX IF NOT EXISTS idx_conversations_phone ON conversations(bot_id, phone);
      CREATE INDEX IF NOT EXISTS idx_sales_bot ON sales(bot_id);
      CREATE INDEX IF NOT EXISTS idx_sales_user ON sales(user_id);
      CREATE INDEX IF NOT EXISTS idx_conv_history ON conversation_history(bot_id, phone);
      CREATE INDEX IF NOT EXISTS idx_wa_auth_bot ON wa_auth_state(bot_id);
      CREATE INDEX IF NOT EXISTS idx_wa_msg_bot ON wa_msg_store(bot_id);
    `);

    console.log('[DB] ✅ PostgreSQL schema inicializado');
  } finally {
    client.release();
  }
}

// ══════════════════════════════════════════════════════════════════════════════
//  SEED ADMIN
// ══════════════════════════════════════════════════════════════════════════════
async function seedAdmin() {
  const { rows } = await pool.query("SELECT id, username, usuario_fase FROM users WHERE role = $1", ['admin']);
  const admin = rows[0];
  if (!admin) {
    const id = uuidv4();
    const hash = bcrypt.hashSync(process.env.ADMIN_PASSWORD || 'admin123', 10);
    await pool.query(
      `INSERT INTO users (id, username, email, password, nombre, apellido, role, status, max_bots, usuario_fase)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [id, process.env.ADMIN_USERNAME || 'admin', process.env.ADMIN_EMAIL || 'admin@sistema.com', hash, 'Administrador', 'Principal', 'admin', 'activo', 100, 'admin']
    );
    console.log('[DB] Admin creado: usuario "admin" / admin123');
  } else {
    if (!admin.username) {
      await pool.query('UPDATE users SET username = $1 WHERE id = $2', ['admin', admin.id]);
    }
    if (!admin.usuario_fase) {
      await pool.query('UPDATE users SET usuario_fase = $1 WHERE id = $2', ['admin', admin.id]);
      console.log('[DB] usuario_fase "admin" asignado al administrador');
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════════
//  USER OPERATIONS
// ══════════════════════════════════════════════════════════════════════════════
const Users = {
  async create(data) {
    const id = uuidv4();
    const hash = bcrypt.hashSync(data.password, 10);
    await pool.query(
      `INSERT INTO users (id, username, email, password, nombre, apellido, fecha_nacimiento, ciudad, usuario_fase, patrocinador_fase, foto_factura)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [id, data.username, data.email, hash, data.nombre, data.apellido, data.fecha_nacimiento || '', data.ciudad || '', data.usuario_fase || '', data.patrocinador_fase || '', data.foto_factura || '']
    );
    return this.findById(id);
  },

  async findByUsername(username) {
    const { rows } = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    return rows[0] || null;
  },

  async findByUsuarioFase(usuarioFase) {
    const { rows } = await pool.query('SELECT * FROM users WHERE usuario_fase = $1', [usuarioFase]);
    return rows[0] || null;
  },

  async findByEmail(email) {
    const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    return rows[0] || null;
  },

  async findById(id) {
    const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
    return rows[0] || null;
  },

  verifyPassword(user, password) {
    return bcrypt.compareSync(password, user.password);
  },

  async getAll() {
    const { rows } = await pool.query(
      'SELECT id, username, email, nombre, apellido, fecha_nacimiento, ciudad, usuario_fase, patrocinador_fase, foto_factura, foto_perfil, rango_fase, role, status, max_bots, created_at, updated_at FROM users ORDER BY created_at DESC'
    );
    return rows;
  },

  async update(id, data) {
    const fields = [];
    const values = [];
    let idx = 1;
    for (const [key, val] of Object.entries(data)) {
      if (key === 'id' || key === 'password') continue;
      fields.push(`${key} = $${idx++}`);
      values.push(val);
    }
    if (fields.length === 0) return this.findById(id);
    fields.push(`updated_at = NOW()`);
    values.push(id);
    await pool.query(`UPDATE users SET ${fields.join(', ')} WHERE id = $${idx}`, values);
    return this.findById(id);
  },

  async updatePassword(id, newPassword) {
    const hash = bcrypt.hashSync(newPassword, 10);
    await pool.query('UPDATE users SET password = $1, updated_at = NOW() WHERE id = $2', [hash, id]);
  },

  async delete(id) {
    await pool.query('DELETE FROM users WHERE id = $1', [id]);
  },

  async countBots(userId) {
    const { rows } = await pool.query('SELECT COUNT(*) as count FROM bots WHERE user_id = $1 AND status != $2', [userId, 'deleted']);
    return parseInt(rows[0].count);
  },
};

// ══════════════════════════════════════════════════════════════════════════════
//  BOT OPERATIONS
// ══════════════════════════════════════════════════════════════════════════════
const Bots = {
  async create(userId, data = {}) {
    const id = data.id || uuidv4();
    await pool.query(
      `INSERT INTO bots (id, user_id, name, icon, active, openai_key, model, report_number, system_prompt, msg1_limit, msg2_limit, msg3_limit, strict_json, seg1, seg2)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [
        id, userId,
        data.name || 'Nuevo Bot',
        data.icon || '🤖',
        data.active ? 1 : 0,
        data.openai_key || '',
        data.model || 'gpt-5.1',
        data.report_number || '',
        data.system_prompt || '',
        data.msg1_limit || 500,
        data.msg2_limit || 500,
        data.msg3_limit || 500,
        data.strict_json !== undefined ? (data.strict_json ? 1 : 0) : 1,
        data.seg1 || 15,
        data.seg2 || 400
      ]
    );
    return this.findById(id);
  },

  async findById(id) {
    const { rows } = await pool.query('SELECT * FROM bots WHERE id = $1', [id]);
    return rows[0] || null;
  },

  async findByUser(userId) {
    const { rows } = await pool.query('SELECT * FROM bots WHERE user_id = $1 AND status != $2 ORDER BY created_at DESC', [userId, 'deleted']);
    return rows;
  },

  async getAll() {
    const { rows } = await pool.query(`
      SELECT b.*, u.nombre as user_nombre, u.apellido as user_apellido, u.email as user_email
      FROM bots b JOIN users u ON b.user_id = u.id
      WHERE b.status != 'deleted'
      ORDER BY b.created_at DESC
    `);
    return rows;
  },

  async update(id, data) {
    const fields = [];
    const values = [];
    let idx = 1;
    for (const [key, val] of Object.entries(data)) {
      if (key === 'id' || key === 'user_id') continue;
      fields.push(`${key} = $${idx++}`);
      values.push(val);
    }
    if (fields.length === 0) return this.findById(id);
    fields.push(`updated_at = NOW()`);
    values.push(id);
    await pool.query(`UPDATE bots SET ${fields.join(', ')} WHERE id = $${idx}`, values);
    return this.findById(id);
  },

  async delete(id) {
    await pool.query("UPDATE bots SET status = 'deleted', updated_at = NOW() WHERE id = $1", [id]);
  },

  async hardDelete(id) {
    await pool.query('DELETE FROM bots WHERE id = $1', [id]);
  },
};

// ══════════════════════════════════════════════════════════════════════════════
//  PRODUCT OPERATIONS
// ══════════════════════════════════════════════════════════════════════════════
const Products = {
  async create(botId, data) {
    const id = data.id || uuidv4();
    await pool.query(
      `INSERT INTO products (id, bot_id, nombre, descripcion, beneficios, modo_uso, advertencias, moneda, precio_unitario, precio_promo2, precio_super6, precio_oferta, info_envio, cobertura, hooks, imagenes, mas_imagenes, testimonios)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
      [
        id, botId,
        data.nombre || '', data.descripcion || '', data.beneficios || '',
        data.modo_uso || data.modoUso || '', data.advertencias || '',
        data.moneda || 'BOB',
        data.precio_unitario || data.precioUnitario || '',
        data.precio_promo2 || data.precioPromo2 || '',
        data.precio_super6 || data.precioSuper6 || '',
        data.precio_oferta || data.precioOferta || '',
        data.info_envio || data.infoEnvio || '',
        data.cobertura || '',
        data.hooks || '',
        JSON.stringify(data.imagenes || []),
        JSON.stringify(data.mas_imagenes || data.masImagenes || []),
        JSON.stringify(data.testimonios || [])
      ]
    );
    return this.findById(id);
  },

  async findById(id) {
    const { rows } = await pool.query('SELECT * FROM products WHERE id = $1', [id]);
    const p = rows[0] || null;
    if (p) {
      p.imagenes = JSON.parse(p.imagenes || '[]');
      p.mas_imagenes = JSON.parse(p.mas_imagenes || '[]');
      p.testimonios = JSON.parse(p.testimonios || '[]');
    }
    return p;
  },

  async findByBot(botId) {
    const { rows } = await pool.query('SELECT * FROM products WHERE bot_id = $1 ORDER BY created_at ASC', [botId]);
    return rows.map(p => ({
      ...p,
      imagenes: JSON.parse(p.imagenes || '[]'),
      mas_imagenes: JSON.parse(p.mas_imagenes || '[]'),
      testimonios: JSON.parse(p.testimonios || '[]'),
    }));
  },

  async update(id, data) {
    const fields = [];
    const values = [];
    let idx = 1;
    for (const [key, val] of Object.entries(data)) {
      if (key === 'id' || key === 'bot_id') continue;
      if (key === 'imagenes' || key === 'mas_imagenes' || key === 'testimonios') {
        fields.push(`${key} = $${idx++}`);
        values.push(JSON.stringify(val));
      } else {
        fields.push(`${key} = $${idx++}`);
        values.push(val);
      }
    }
    if (fields.length === 0) return this.findById(id);
    fields.push(`updated_at = NOW()`);
    values.push(id);
    await pool.query(`UPDATE products SET ${fields.join(', ')} WHERE id = $${idx}`, values);
    return this.findById(id);
  },

  async delete(id) {
    await pool.query('DELETE FROM products WHERE id = $1', [id]);
  },

  async deleteByBot(botId) {
    await pool.query('DELETE FROM products WHERE bot_id = $1', [botId]);
  },
};

// ══════════════════════════════════════════════════════════════════════════════
//  CONVERSATION TRACKING (for follow-ups)
// ══════════════════════════════════════════════════════════════════════════════
const Conversations = {
  async upsert(botId, phone, pushName, jidSuffix) {
    const { rows } = await pool.query('SELECT id, status FROM conversations WHERE bot_id = $1 AND phone = $2', [botId, phone]);
    const existing = rows[0];
    if (existing) {
      // No reactivar conversaciones cerradas por venta confirmada
      if (existing.status === 'sold') {
        await pool.query("UPDATE conversations SET push_name = $1, last_message_at = NOW() WHERE id = $2", [pushName, existing.id]);
        return existing.id;
      }
      if (jidSuffix) {
        await pool.query("UPDATE conversations SET push_name = $1, last_message_at = NOW(), status = 'active', jid_suffix = $2 WHERE id = $3", [pushName, jidSuffix, existing.id]);
      } else {
        await pool.query("UPDATE conversations SET push_name = $1, last_message_at = NOW(), status = 'active' WHERE id = $2", [pushName, existing.id]);
      }
      return existing.id;
    }
    const result = await pool.query('INSERT INTO conversations (bot_id, phone, push_name, jid_suffix) VALUES ($1, $2, $3, $4) RETURNING id', [botId, phone, pushName, jidSuffix || 's.whatsapp.net']);
    return result.rows[0].id;
  },

  async updateBotReply(botId, phone) {
    await pool.query("UPDATE conversations SET last_bot_reply_at = NOW() WHERE bot_id = $1 AND phone = $2", [botId, phone]);
  },

  async resetFollowUps(botId, phone) {
    await pool.query("UPDATE conversations SET follow_up_count = 0 WHERE bot_id = $1 AND phone = $2", [botId, phone]);
  },

  async incrementFollowUp(botId, phone) {
    await pool.query("UPDATE conversations SET follow_up_count = follow_up_count + 1 WHERE bot_id = $1 AND phone = $2", [botId, phone]);
  },

  async closeAsSold(botId, phone) {
    await pool.query("UPDATE conversations SET status = 'sold', follow_up_count = 2 WHERE bot_id = $1 AND phone = $2", [botId, phone]);
  },

  async updateLocation(botId, phone, latitude, longitude) {
    await pool.query("UPDATE conversations SET latitude = $1, longitude = $2 WHERE bot_id = $3 AND phone = $4", [latitude, longitude, botId, phone]);
  },

  async findByBotAndPhone(botId, phone) {
    const { rows } = await pool.query('SELECT * FROM conversations WHERE bot_id = $1 AND phone = $2', [botId, phone]);
    return rows[0] || null;
  },

  async getPendingFollowUps(botId, seg1Minutes, seg2Minutes) {
    const { rows } = await pool.query(`
      SELECT * FROM conversations
      WHERE bot_id = $1 AND status = 'active'
      AND last_bot_reply_at IS NOT NULL
      AND last_message_at <= last_bot_reply_at
      AND last_bot_reply_at > NOW() - INTERVAL '48 hours'
      AND (
        (follow_up_count = 0 AND last_bot_reply_at + ($2::INTEGER * INTERVAL '1 minute') <= NOW())
        OR
        (follow_up_count = 1 AND last_bot_reply_at + ($3::INTEGER * INTERVAL '1 minute') <= NOW())
      )
      AND follow_up_count < 2
      ORDER BY last_bot_reply_at ASC
    `, [botId, parseInt(seg1Minutes) || 15, parseInt(seg2Minutes) || 400]);
    return rows;
  },
};

// Helper: convert bot DB row to config format
function botToConfig(bot, products) {
  return {
    openaiKey: bot.openai_key,
    model: bot.model || 'gpt-5.1',
    systemPrompt: bot.system_prompt,
    msg1Limit: bot.msg1_limit,
    msg2Limit: bot.msg2_limit,
    msg3Limit: bot.msg3_limit,
    strictJson: bot.strict_json === 1,
    reportNumber: bot.report_number,
    products: (products || []).map(p => ({
      id: p.id,
      nombre: p.nombre,
      descripcion: p.descripcion,
      beneficios: p.beneficios,
      modoUso: p.modo_uso,
      advertencias: p.advertencias,
      moneda: p.moneda,
      precioUnitario: p.precio_unitario,
      precioPromo2: p.precio_promo2,
      precioSuper6: p.precio_super6,
      precioOferta: p.precio_oferta,
      infoEnvio: p.info_envio,
      cobertura: p.cobertura,
      hooks: p.hooks,
      imagenes: p.imagenes,
      masImagenes: p.mas_imagenes,
      testimonios: p.testimonios,
    })),
    seguimientos: { seg1: bot.seg1, seg2: bot.seg2 },
  };
}

// Helper: convert bot DB row to frontend format
function botToFrontend(bot, products) {
  return {
    id: bot.id,
    name: bot.name,
    icon: bot.icon,
    active: bot.active === 1,
    credentials: { openaiKey: bot.openai_key, reportNumber: bot.report_number },
    model: bot.model || 'gpt-5.1',
    template: {
      systemPrompt: bot.system_prompt,
      msg1Limit: bot.msg1_limit,
      msg2Limit: bot.msg2_limit,
      msg3Limit: bot.msg3_limit,
      strictJson: bot.strict_json === 1,
    },
    products: (products || []).map(p => ({
      id: p.id,
      nombre: p.nombre,
      descripcion: p.descripcion,
      beneficios: p.beneficios,
      modoUso: p.modo_uso,
      advertencias: p.advertencias,
      moneda: p.moneda,
      precioUnitario: p.precio_unitario,
      precioPromo2: p.precio_promo2,
      precioSuper6: p.precio_super6,
      precioOferta: p.precio_oferta,
      imagenes: p.imagenes,
      masImagenes: p.mas_imagenes,
      testimonios: p.testimonios,
      infoEnvio: p.info_envio,
      cobertura: p.cobertura,
      hooks: p.hooks,
    })),
    seguimientos: { seg1: bot.seg1, seg2: bot.seg2 },
    whatsapp: {
      status: bot.wa_status || 'disconnected',
      phone: bot.wa_phone || null,
      lastConnected: bot.wa_last_connected || null,
    },
  };
}

// ══════════════════════════════════════════════════════════════════════════════
//  SALES TRACKING
// ══════════════════════════════════════════════════════════════════════════════
const Sales = {
  async create(data) {
    const id = uuidv4();
    await pool.query(
      `INSERT INTO sales (id, bot_id, user_id, phone, client_name, product_name, product_id, amount, currency, city, latitude, longitude, report_text, bot_name, status, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
      [
        id, data.bot_id, data.user_id, data.phone || '',
        data.client_name || '', data.product_name || '', data.product_id || '',
        data.amount || '', data.currency || 'BOB',
        data.city || '', data.latitude || null, data.longitude || null,
        data.report_text || '', data.bot_name || '',
        data.status || 'confirmada', data.notes || ''
      ]
    );
    return this.findById(id);
  },

  async findById(id) {
    const { rows } = await pool.query('SELECT * FROM sales WHERE id = $1 AND deleted = 0', [id]);
    return rows[0] || null;
  },

  async findByUser(userId) {
    const { rows } = await pool.query('SELECT * FROM sales WHERE user_id = $1 AND deleted = 0 ORDER BY created_at DESC', [userId]);
    return rows;
  },

  async findByBot(botId) {
    const { rows } = await pool.query('SELECT * FROM sales WHERE bot_id = $1 AND deleted = 0 ORDER BY created_at DESC', [botId]);
    return rows;
  },

  async update(id, data) {
    const fields = [];
    const values = [];
    let idx = 1;
    for (const [key, val] of Object.entries(data)) {
      if (key === 'id' || key === 'bot_id' || key === 'user_id') continue;
      fields.push(`${key} = $${idx++}`);
      values.push(val);
    }
    if (fields.length === 0) return this.findById(id);
    values.push(id);
    await pool.query(`UPDATE sales SET ${fields.join(', ')} WHERE id = $${idx}`, values);
    return this.findById(id);
  },

  async softDelete(id) {
    await pool.query('UPDATE sales SET deleted = 1 WHERE id = $1', [id]);
  },
};

// ══════════════════════════════════════════════════════════════════════════════
//  CONVERSATION HISTORY
// ══════════════════════════════════════════════════════════════════════════════
const ConversationHistory = {
  async add(botId, phone, role, content) {
    await pool.query('INSERT INTO conversation_history (bot_id, phone, role, content) VALUES ($1, $2, $3, $4)', [botId, phone, role, content]);
    const { rows } = await pool.query('SELECT COUNT(*) as c FROM conversation_history WHERE bot_id = $1 AND phone = $2', [botId, phone]);
    const count = parseInt(rows[0].c);
    if (count > 30) {
      await pool.query(`DELETE FROM conversation_history WHERE id IN (
        SELECT id FROM conversation_history WHERE bot_id = $1 AND phone = $2 ORDER BY created_at ASC LIMIT $3
      )`, [botId, phone, count - 30]);
    }
  },

  async getHistory(botId, phone, limit = 20) {
    const { rows } = await pool.query('SELECT role, content FROM conversation_history WHERE bot_id = $1 AND phone = $2 ORDER BY created_at DESC LIMIT $3', [botId, phone, limit]);
    return rows.reverse();
  },

  async clear(botId, phone) {
    await pool.query('DELETE FROM conversation_history WHERE bot_id = $1 AND phone = $2', [botId, phone]);
  },
};

// ══════════════════════════════════════════════════════════════════════════════
//  WHATSAPP AUTH STATE (persistent in PostgreSQL)
// ══════════════════════════════════════════════════════════════════════════════
const WaAuthState = {
  async get(botId, key) {
    const { rows } = await pool.query('SELECT data_value FROM wa_auth_state WHERE bot_id = $1 AND data_key = $2', [botId, key]);
    return rows[0]?.data_value || null;
  },
  async set(botId, key, value) {
    await pool.query(
      `INSERT INTO wa_auth_state (bot_id, data_key, data_value) VALUES ($1, $2, $3)
       ON CONFLICT (bot_id, data_key) DO UPDATE SET data_value = $3`,
      [botId, key, value]
    );
  },
  async delete(botId, key) {
    await pool.query('DELETE FROM wa_auth_state WHERE bot_id = $1 AND data_key = $2', [botId, key]);
  },
  async deleteAll(botId) {
    await pool.query('DELETE FROM wa_auth_state WHERE bot_id = $1', [botId]);
  },
  async hasCreds(botId) {
    const { rows } = await pool.query('SELECT 1 FROM wa_auth_state WHERE bot_id = $1 AND data_key = $2 LIMIT 1', [botId, 'creds']);
    return rows.length > 0;
  },
  async getKeys(botId, type, ids) {
    if (!ids || ids.length === 0) return {};
    const keys = ids.map(id => `${type}:${id}`);
    const placeholders = keys.map((_, i) => `$${i + 2}`).join(',');
    const { rows } = await pool.query(
      `SELECT data_key, data_value FROM wa_auth_state WHERE bot_id = $1 AND data_key IN (${placeholders})`,
      [botId, ...keys]
    );
    const result = {};
    for (const row of rows) {
      const id = row.data_key.split(':').slice(1).join(':');
      try { result[id] = JSON.parse(row.data_value); } catch(e) {}
    }
    return result;
  },
};

// ══════════════════════════════════════════════════════════════════════════════
//  WHATSAPP MESSAGE STORE (persistent in PostgreSQL)
// ══════════════════════════════════════════════════════════════════════════════
const WaMsgStore = {
  async load(botId) {
    const { rows } = await pool.query(
      'SELECT msg_id, data FROM wa_msg_store WHERE bot_id = $1 ORDER BY created_at DESC LIMIT 500', [botId]
    );
    const store = new Map();
    for (const row of rows) {
      try { store.set(row.msg_id, JSON.parse(row.data)); } catch(e) {}
    }
    return store;
  },
  async save(botId, msgId, data) {
    await pool.query(
      `INSERT INTO wa_msg_store (bot_id, msg_id, data) VALUES ($1, $2, $3)
       ON CONFLICT (bot_id, msg_id) DO UPDATE SET data = $3`,
      [botId, msgId, JSON.stringify(data)]
    );
  },
  async deleteAll(botId) {
    await pool.query('DELETE FROM wa_msg_store WHERE bot_id = $1', [botId]);
  },
  async trim(botId) {
    await pool.query(`DELETE FROM wa_msg_store WHERE bot_id = $1 AND msg_id NOT IN (
      SELECT msg_id FROM wa_msg_store WHERE bot_id = $1 ORDER BY created_at DESC LIMIT 500
    )`, [botId]);
  },
};

// ══════════════════════════════════════════════════════════════════════════════
//  INIT — crear tablas + seed admin
// ══════════════════════════════════════════════════════════════════════════════
async function initDatabase() {
  await initDB();
  await seedAdmin();
  console.log('[DB] ✅ Base de datos PostgreSQL lista');
}

module.exports = { pool, Users, Bots, Products, Conversations, Sales, ConversationHistory, WaAuthState, WaMsgStore, botToConfig, botToFrontend, initDatabase };
