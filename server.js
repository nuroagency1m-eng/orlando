const express = require('express');
const cors = require('cors');
const { default: makeWASocket, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, downloadMediaMessage } = require('@whiskeysockets/baileys');
// form-data npm ya no se usa — se usa el FormData nativo de Node.js 18+
const QRCode = require('qrcode');
const pino = require('pino');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { Users, Bots, Products, Conversations, Sales, ConversationHistory, WaAuthState, WaMsgStore, botToConfig, botToFrontend, initDatabase } = require('./database');
const { generateToken, requireAuth, requireAdmin } = require('./auth');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
app.use(express.json({ limit: '5mb' }));

const logger = pino({ level: 'silent' });

// Directorios
app.use('/IMAGEN', express.static(path.join(__dirname, 'IMAGEN')));

// Note: All file uploads use memUpload + Supabase Storage (defined below)
// Note: WhatsApp sessions + msg stores are persisted in PostgreSQL

// ══════════════════════════════════════════════════════════════════════════════
//  WHATSAPP SESSION MANAGEMENT (preserved from original)
// ══════════════════════════════════════════════════════════════════════════════
const sessions = new Map();
const MAX_MESSAGES = 200;
const conversations = new Map();
const MAX_HISTORY = 20;

// Almacen de mensajes enviados (persistente en PostgreSQL)
async function loadMsgStore(botId) {
  try {
    const store = await WaMsgStore.load(botId);
    if (store.size > 0) console.log(`[MsgStore] Bot ${botId}: ${store.size} mensajes cargados desde DB`);
    return store;
  } catch(e) {
    console.error(`[MsgStore] Error cargando store bot ${botId}:`, e.message);
    return new Map();
  }
}

async function saveMsgStore(botId, msgId, data) {
  try {
    await WaMsgStore.save(botId, msgId, data);
  } catch(e) {
    console.error(`[MsgStore] Error guardando msg ${msgId}:`, e.message);
  }
}

// ── Auth state persistente en PostgreSQL (reemplaza useMultiFileAuthState) ──
async function usePostgresAuthState(botId) {
  const { proto } = require('@whiskeysockets/baileys');
  const { BufferJSON, initAuthCreds } = require('@whiskeysockets/baileys');

  const readData = async (key) => {
    const raw = await WaAuthState.get(botId, key);
    if (!raw) return null;
    return JSON.parse(raw, BufferJSON.reviver);
  };

  const writeData = async (key, value) => {
    await WaAuthState.set(botId, key, JSON.stringify(value, BufferJSON.replacer));
  };

  const removeData = async (key) => {
    await WaAuthState.delete(botId, key);
  };

  // Load or init creds
  let creds = await readData('creds');
  if (!creds) {
    creds = initAuthCreds();
    await writeData('creds', creds);
  }

  const state = {
    creds,
    keys: {
      get: async (type, ids) => {
        const result = {};
        for (const id of ids) {
          const val = await readData(`${type}:${id}`);
          if (val) {
            if (type === 'app-state-sync-key' && val.keyData) {
              result[id] = proto.Message.AppStateSyncKeyData.fromObject(val);
            } else {
              result[id] = val;
            }
          }
        }
        return result;
      },
      set: async (data) => {
        const tasks = [];
        for (const [category, entries] of Object.entries(data)) {
          for (const [id, value] of Object.entries(entries)) {
            const key = `${category}:${id}`;
            if (value) {
              tasks.push(writeData(key, value));
            } else {
              tasks.push(removeData(key));
            }
          }
        }
        await Promise.all(tasks);
      },
    },
  };

  const saveCreds = async () => {
    await writeData('creds', state.creds);
  };

  return { state, saveCreds };
}

function getSession(botId) {
  if (!sessions.has(botId)) {
    sessions.set(botId, {
      socket: null, status: 'disconnected', qr: null, qrDataURL: null,
      phone: null, lastConnected: null, error: null, retryCount: 0,
      messages: [], unreadCount: 0,
    });
  }
  return sessions.get(botId);
}

// Historial de conversacion (in-memory + persistente en DB)
async function getHistory(botId, phone) {
  const key = `${botId}:${phone}`;
  if (!conversations.has(key)) {
    // Cargar historial persistente desde DB si existe
    const dbHistory = await ConversationHistory.getHistory(botId, phone, MAX_HISTORY);
    conversations.set(key, dbHistory.length > 0 ? dbHistory : []);
  }
  return conversations.get(key);
}

async function addToHistory(botId, phone, role, content) {
  const history = await getHistory(botId, phone);
  history.push({ role, content });
  if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);
  // Persistir en DB para que sobreviva reinicios
  await ConversationHistory.add(botId, phone, role, content);
}

// ══════════════════════════════════════════════════════════════════════════════
//  OPENAI - RESPUESTA AUTOMATICA
// ══════════════════════════════════════════════════════════════════════════════
async function loadBotConfigFromDB(botId) {
  console.log(`[Bot ${botId}] [CONFIG] Cargando configuracion desde DB...`);
  const bot = await Bots.findById(botId);
  if (!bot) {
    console.log(`[Bot ${botId}] [CONFIG] ❌ Bot NO encontrado en DB`);
    return null;
  }
  const products = await Products.findByBot(botId);
  console.log(`[Bot ${botId}] [CONFIG] ✅ Config cargada | Modelo: ${bot.model} | Productos: ${products.length} | API Key: ${bot.openai_key ? 'SI (' + bot.openai_key.substring(0,8) + '...)' : 'NO'} | Reporte: ${bot.report_number || 'N/A'}`);
  return botToConfig(bot, products);
}

function buildSystemPrompt(config) {
  let prompt = config.systemPrompt || '';
  console.log(`[PROMPT] Construyendo prompt | Base: ${prompt ? prompt.length + ' chars' : 'VACIO'} | Productos: ${config.products?.length || 0}`);
  if (config.products && config.products.length > 0) {
    prompt += '\n\n---\n# BASE DE PRODUCTOS\n\n';
    for (const p of config.products) {
      prompt += `## ${p.nombre || 'Producto'}\n`;
      if (p.descripcion) prompt += `Descripcion: ${p.descripcion}\n`;
      if (p.beneficios) prompt += `Beneficios:\n${p.beneficios}\n`;
      if (p.modoUso) prompt += `Modo de uso: ${p.modoUso}\n`;
      if (p.advertencias) prompt += `Advertencias: ${p.advertencias}\n`;
      const precios = [];
      if (p.precioUnitario) precios.push(`Unitario: ${p.moneda || 'BOB'} ${p.precioUnitario}`);
      if (p.precioPromo2) precios.push(`Promo x2: ${p.moneda || 'BOB'} ${p.precioPromo2}`);
      if (p.precioSuper6) precios.push(`Super x6: ${p.moneda || 'BOB'} ${p.precioSuper6}`);
      if (p.precioOferta) precios.push(`OFERTA: ${p.moneda || 'BOB'} ${p.precioOferta}`);
      if (precios.length) prompt += `Precios: ${precios.join(' | ')}\n`;
      if (p.infoEnvio) prompt += `Envio: ${p.infoEnvio}\n`;
      if (p.cobertura) prompt += `Cobertura: ${p.cobertura}\n`;
      // Images info for AI
      if (p.imagenes && p.imagenes.filter(i=>i).length > 0) {
        prompt += `Imagenes del producto: SI (${p.imagenes.filter(i=>i).length} fotos)\n`;
        prompt += `INSTRUCCION: Si el cliente pide ver fotos o imagenes del producto, responde con el texto exacto [ENVIAR_IMAGENES:${p.id}] al final de tu mensaje.\n`;
      }
      // Offer images
      if (p.masImagenes && p.masImagenes.filter(i=>i).length > 0) {
        prompt += `Fotos de oferta: SI (${p.masImagenes.filter(i=>i).length} fotos)\n`;
        prompt += `INSTRUCCION: Si el cliente pregunta por ofertas, promociones o descuentos, responde con [ENVIAR_OFERTA:${p.id}] al final de tu mensaje.\n`;
      }
      // Testimonial images
      const testWithUrl = (p.testimonios || []).filter(t => (typeof t === 'string' ? t : t?.url));
      if (testWithUrl.length > 0) {
        prompt += `Testimonios de clientes: SI (${testWithUrl.length} testimonios)\n`;
        prompt += `INSTRUCCION: Si el cliente pide ver testimonios, opiniones o resultados, responde con [ENVIAR_TESTIMONIOS:${p.id}] al final de tu mensaje.\n`;
      }
      prompt += `INSTRUCCION: Si el cliente confirma compra o da ubicacion para este producto, genera el reporte en el campo "reporte" del JSON (usa tu formato de reporte o [ENVIAR_REPORTE:${p.id}]).\n`;
      prompt += '\n';
    }
  }
  return prompt;
}

// Track de imagenes ya enviadas por conversacion para no repetir
const sentImagesTracker = new Map();

function getSentImages(botId, phone) {
  const key = `${botId}:${phone}`;
  if (!sentImagesTracker.has(key)) sentImagesTracker.set(key, new Set());
  return sentImagesTracker.get(key);
}

async function getAIResponse(botId, customerPhone, customerName, messageText) {
  const config = await loadBotConfigFromDB(botId);
  if (!config || !config.openaiKey) {
    console.log(`[Bot ${botId}] [IA] ❌ Sin API key configurada`);
    return null;
  }

  const systemPrompt = buildSystemPrompt(config);
  if (!systemPrompt.trim()) {
    console.log(`[Bot ${botId}] [IA] ❌ Sin prompt configurado`);
    return null;
  }

  await addToHistory(botId, customerPhone, 'user', messageText);
  const history = await getHistory(botId, customerPhone);

  const lim1 = config.msg1Limit || 60;
  const lim2 = config.msg2Limit || 50;
  const lim3 = config.msg3Limit || 50;

  const fullSystemPrompt = systemPrompt
    + `\n\n---\n# REGLAS DE FORMATO DE RESPUESTA (OBLIGATORIO)\n`
    + `- El nombre del cliente es: ${customerName}\n`
    + `- Responde de forma natural, calida y humana, como un vendedor real de WhatsApp boliviano.\n`
    + `- Usa emojis de forma moderada y natural (1-2 por mensaje maximo) para que se sienta mas humano.\n`
    + `- NO uses markdown, asteriscos dobles ni formatos especiales. Solo texto plano con *negrita de un asterisco*.\n`
    + `- Tus respuestas se envian como mensajes separados de WhatsApp.\n\n`
    + `DEBES responder SIEMPRE en formato JSON valido con esta estructura exacta:\n`
    + `{"mensaje1":"texto del primer mensaje (maximo ${lim1} caracteres)","mensaje2":"texto del segundo mensaje o vacio (maximo ${lim2} caracteres)","mensaje3":"texto del tercer mensaje o vacio (maximo ${lim3} caracteres)","fotos_mensaje1":"","reporte":""}\n\n`
    + `REGLAS de mensajes:\n`
    + `- mensaje1 es OBLIGATORIO. mensaje2 y mensaje3 son opcionales (dejar "" si no aportan).\n`
    + `- RESPETA ESTRICTAMENTE el limite de caracteres de cada mensaje.\n`
    + `- Si es el primer mensaje del producto identificado, mensaje1 puede ser mas largo (texto completo del primer mensaje).\n`
    + `- Separa ideas en mensajes diferentes para que se sienta como chat real.\n\n`
    + `REGLAS de fotos_mensaje1:\n`
    + `- Si debes enviar imagenes del producto: "fotos_mensaje1":"[ENVIAR_IMAGENES:product_id]"\n`
    + `- Si debes enviar fotos de oferta: "fotos_mensaje1":"[ENVIAR_OFERTA:product_id]"\n`
    + `- Si debes enviar testimonios: "fotos_mensaje1":"[ENVIAR_TESTIMONIOS:product_id]"\n`
    + `- Solo 1 comando de fotos por respuesta. No repitas.\n\n`
    + `REGLAS de reporte:\n`
    + `- Si el cliente confirma compra, da ubicacion o quiere hacer pedido, DEBES generar un reporte.\n`
    + `- Si tu prompt define un formato de reporte, usa ESE FORMATO EXACTO y pon el texto completo en el campo "reporte".\n`
    + `- Si tu prompt NO define formato de reporte, usa: "reporte":"[ENVIAR_REPORTE:product_id]"\n`
    + `- El reporte debe incluir todos los datos disponibles: nombre del cliente, telefono, producto, precio, ciudad, ubicacion.\n`
    + `- Si no hay confirmacion de compra: "reporte":""\n`
    + `- IMPORTANTE: El reporte va SOLO en el campo "reporte" del JSON, NUNCA dentro de mensaje1/mensaje2/mensaje3.\n\n`
    + `RESPONDE SOLO CON EL JSON. Sin explicaciones, sin texto adicional fuera del JSON.\n`;

  console.log(`[Bot ${botId}] [IA] Prompt: ${fullSystemPrompt.length} chars | Historial: ${history.length} msgs | Limites: m1=${lim1} m2=${lim2} m3=${lim3}`);

  const messages = [{ role: 'system', content: fullSystemPrompt }, ...history];

  // Map model names to OpenAI API model IDs
  const modelMap = {
    'gpt-4': 'gpt-4',
    'gpt-4-turbo': 'gpt-4-turbo',
    'gpt-5': 'gpt-4o',
    'gpt-5.1': 'gpt-4o',
  };
  const modelId = modelMap[config.model] || config.model || 'gpt-4o';

  try {
    console.log(`[Bot ${botId}] [IA] 🤖 Consultando modelo: ${modelId} | Cliente: ${customerName} (+${customerPhone})`);

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.openaiKey}` },
      body: JSON.stringify({ model: modelId, messages, max_tokens: 1024, temperature: 0.7, response_format: { type: 'json_object' } }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      console.error(`[Bot ${botId}] [IA] ❌ OpenAI error (${response.status}):`, err.error?.message || 'Unknown');
      return null;
    }

    const data = await response.json();
    const reply = data.choices?.[0]?.message?.content?.trim();
    const tokensUsed = data.usage?.total_tokens || '?';

    if (reply) {
      await addToHistory(botId, customerPhone, 'assistant', reply);
      console.log(`[Bot ${botId}] [IA] ✅ Respuesta recibida | Modelo: ${modelId} | Tokens: ${tokensUsed} | Raw: ${reply.substring(0, 120)}...`);
    }
    return reply;
  } catch(e) {
    console.error(`[Bot ${botId}] [IA] ❌ Error OpenAI:`, e.message);
    return null;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
//  EXTRAER CONTENIDO DE MENSAJE
// ══════════════════════════════════════════════════════════════════════════════
function extractMessageContent(msg) {
  const m = msg.message;
  if (!m) return null;
  if (m.conversation) return { type: 'text', text: m.conversation };
  if (m.extendedTextMessage?.text) return { type: 'text', text: m.extendedTextMessage.text };
  if (m.imageMessage) return { type: 'image', text: m.imageMessage.caption || '[Imagen]' };
  if (m.videoMessage) return { type: 'video', text: m.videoMessage.caption || '[Video]' };
  if (m.audioMessage) return { type: m.audioMessage.ptt ? 'ptt' : 'audio', text: m.audioMessage.ptt ? '[Nota de voz]' : '[Audio]' };
  if (m.documentMessage) return { type: 'document', text: m.documentMessage.fileName || '[Documento]' };
  if (m.stickerMessage) return { type: 'sticker', text: '[Sticker]' };
  if (m.contactMessage) return { type: 'contact', text: m.contactMessage.displayName || '[Contacto]' };
  if (m.locationMessage) return { type: 'location', text: '[Ubicacion]', latitude: m.locationMessage.degreesLatitude, longitude: m.locationMessage.degreesLongitude };
  if (m.reactionMessage) return { type: 'reaction', text: m.reactionMessage.text || '' };
  if (m.pollCreationMessage) return { type: 'poll', text: m.pollCreationMessage.name || '[Encuesta]' };
  return { type: 'unknown', text: '[Mensaje no soportado]' };
}

// ══════════════════════════════════════════════════════════════════════════════
//  ENVIAR IMAGENES POR WHATSAPP
// ══════════════════════════════════════════════════════════════════════════════
async function sendProductImages(socket, senderJid, productId, botId, msgStore) {
  console.log(`[Bot ${botId}] [IMAGENES] Buscando producto ${productId}...`);
  const product = await Products.findById(productId);
  if (!product) { console.log(`[Bot ${botId}] [IMAGENES] ❌ Producto ${productId} NO encontrado`); return; }

  const allImages = (product.imagenes || []).filter(img => img && img.trim());
  if (allImages.length === 0) { console.log(`[Bot ${botId}] [IMAGENES] ⚠️ Producto ${product.nombre} no tiene imagenes`); return; }

  // Enviar solo 1 imagen no repetida
  const phone = senderJid.split('@')[0];
  const sent = getSentImages(botId, phone);
  const nextImg = allImages.find(img => !sent.has('img:' + img));
  if (!nextImg) {
    console.log(`[Bot ${botId}] [IMAGENES] ℹ️ Todas las imagenes ya fueron enviadas a ${phone}, reenviando primera`);
    sent.clear(); // Reset para permitir reenvio
  }
  const imgUrl = nextImg || allImages[0];
  sent.add('img:' + imgUrl);

  console.log(`[Bot ${botId}] [IMAGENES] 📷 Enviando 1 imagen de "${product.nombre}" a ${phone}`);
  try {
    let imageContent;
    if (imgUrl.startsWith('http://') || imgUrl.startsWith('https://')) {
      imageContent = { image: { url: imgUrl }, caption: product.nombre };
    } else if (imgUrl.startsWith('/uploads/')) {
      const filePath = path.join(__dirname, imgUrl);
      if (fs.existsSync(filePath)) {
        imageContent = { image: fs.readFileSync(filePath), caption: product.nombre };
      } else { console.log(`[Bot ${botId}] [IMAGENES] ❌ Archivo no existe: ${filePath}`); return; }
    } else return;

    const sentMsg = await socket.sendMessage(senderJid, imageContent);
    if (sentMsg?.key?.id && msgStore) {
      msgStore.set(sentMsg.key.id, imageContent);
      saveMsgStore(botId, sentMsg.key.id, imageContent);
    }
    console.log(`[Bot ${botId}] [IMAGENES] ✅ Imagen enviada a ${phone}`);
  } catch(e) {
    console.error(`[Bot ${botId}] [IMAGENES] ❌ Error:`, e.message);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
//  ENVIAR FOTOS DE OFERTA POR WHATSAPP
// ══════════════════════════════════════════════════════════════════════════════
async function sendOfferImages(socket, senderJid, productId, botId, msgStore) {
  console.log(`[Bot ${botId}] [OFERTA] Buscando producto ${productId}...`);
  const product = await Products.findById(productId);
  if (!product) { console.log(`[Bot ${botId}] [OFERTA] ❌ Producto ${productId} NO encontrado`); return; }

  const offerImages = (product.mas_imagenes || []).filter(img => img && img.trim());
  if (offerImages.length === 0) { console.log(`[Bot ${botId}] [OFERTA] ⚠️ Producto ${product.nombre} no tiene fotos de oferta`); return; }

  const phone = senderJid.split('@')[0];
  const sent = getSentImages(botId, phone);
  const nextImg = offerImages.find(img => !sent.has('oferta:' + img));
  const imgUrl = nextImg || offerImages[0];
  if (!nextImg) sent.clear();
  sent.add('oferta:' + imgUrl);

  console.log(`[Bot ${botId}] [OFERTA] 📷 Enviando 1 foto de oferta de "${product.nombre}" a ${phone}`);
  try {
    let imageContent;
    if (imgUrl.startsWith('http://') || imgUrl.startsWith('https://')) {
      imageContent = { image: { url: imgUrl }, caption: `${product.nombre} - Oferta` };
    } else if (imgUrl.startsWith('/uploads/')) {
      const filePath = path.join(__dirname, imgUrl);
      if (fs.existsSync(filePath)) {
        imageContent = { image: fs.readFileSync(filePath), caption: `${product.nombre} - Oferta` };
      } else return;
    } else return;

    const sentMsg = await socket.sendMessage(senderJid, imageContent);
    if (sentMsg?.key?.id && msgStore) {
      msgStore.set(sentMsg.key.id, imageContent);
      saveMsgStore(botId, sentMsg.key.id, imageContent);
    }
    console.log(`[Bot ${botId}] [OFERTA] ✅ Foto de oferta enviada a ${phone}`);
  } catch(e) {
    console.error(`[Bot ${botId}] [OFERTA] ❌ Error:`, e.message);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
//  ENVIAR FOTOS DE TESTIMONIO POR WHATSAPP
// ══════════════════════════════════════════════════════════════════════════════
async function sendTestimonialImages(socket, senderJid, productId, botId, msgStore) {
  console.log(`[Bot ${botId}] [TESTIMONIOS] Buscando producto ${productId}...`);
  const product = await Products.findById(productId);
  if (!product) { console.log(`[Bot ${botId}] [TESTIMONIOS] ❌ Producto ${productId} NO encontrado`); return; }

  const testimonios = (product.testimonios || []).filter(t => {
    const url = typeof t === 'string' ? t : t?.url;
    return url && url.trim();
  });
  if (testimonios.length === 0) { console.log(`[Bot ${botId}] [TESTIMONIOS] ⚠️ Producto ${product.nombre} no tiene testimonios`); return; }

  const phone = senderJid.split('@')[0];
  const sent = getSentImages(botId, phone);

  // Buscar 1 testimonio no enviado
  let selected = null;
  for (const t of testimonios) {
    const url = typeof t === 'string' ? t : t?.url;
    if (!sent.has('test:' + url)) { selected = t; break; }
  }
  if (!selected) { sent.clear(); selected = testimonios[0]; }

  const imgUrl = typeof selected === 'string' ? selected : selected?.url;
  const descripcion = typeof selected === 'string' ? '' : (selected?.descripcion || selected?.tipo || '');
  sent.add('test:' + imgUrl);

  const caption = descripcion
    ? `${product.nombre} - Testimonio\n${descripcion}`
    : `${product.nombre} - Testimonio`;

  console.log(`[Bot ${botId}] [TESTIMONIOS] 📷 Enviando 1 testimonio de "${product.nombre}" a ${phone}`);
  try {
    let imageContent;
    if (imgUrl.startsWith('http://') || imgUrl.startsWith('https://')) {
      imageContent = { image: { url: imgUrl }, caption };
    } else if (imgUrl.startsWith('/uploads/')) {
      const filePath = path.join(__dirname, imgUrl);
      if (fs.existsSync(filePath)) {
        imageContent = { image: fs.readFileSync(filePath), caption };
      } else return;
    } else return;

    const sentMsg = await socket.sendMessage(senderJid, imageContent);
    if (sentMsg?.key?.id && msgStore) {
      msgStore.set(sentMsg.key.id, imageContent);
      saveMsgStore(botId, sentMsg.key.id, imageContent);
    }
    console.log(`[Bot ${botId}] [TESTIMONIOS] ✅ Testimonio enviado a ${phone}`);
  } catch(e) {
    console.error(`[Bot ${botId}] [TESTIMONIOS] ❌ Error:`, e.message);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
//  TRANSCRIBIR AUDIO CON OPENAI WHISPER
// ══════════════════════════════════════════════════════════════════════════════
async function transcribeAudio(audioBuffer, openaiKey) {
  try {
    // Usar FormData nativo (Web API) — compatible con fetch nativo de Node.js
    const form = new FormData();
    form.append('file', new Blob([audioBuffer], { type: 'audio/ogg' }), 'audio.ogg');
    form.append('model', 'whisper-1');
    form.append('language', 'es');

    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${openaiKey}`,
      },
      body: form,
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      console.error('[Whisper] Error:', err.error?.message || response.status);
      return null;
    }

    const data = await response.json();
    return data.text || null;
  } catch(e) {
    console.error('[Whisper] Error transcribiendo:', e.message);
    return null;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
//  CREAR / CONECTAR SESION WHATSAPP
// ══════════════════════════════════════════════════════════════════════════════
async function startSession(botId, forceNew = false) {
  const session = getSession(botId);
  if (!forceNew) {
    if (session.socket && session.status === 'connected') return session;
    if (session.status === 'waiting_scan') return session;
  }

  // Limpiar socket anterior
  if (session.socket) {
    try { session.socket.end(); } catch(e) {}
    session.socket = null;
  }

  session.status = 'connecting';
  session.qr = null;
  session.qrDataURL = null;
  session.error = null;

  try {
  const { state, saveCreds } = await usePostgresAuthState(botId);
  const { version } = await fetchLatestBaileysVersion();

  const msgStore = await loadMsgStore(botId);

  const socket = makeWASocket({
    version,
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
    logger,
    printQRInTerminal: false,
    browser: ['Bot Orlando', 'Chrome', '4.0.0'],
    generateHighQualityLinkPreview: false,
    syncFullHistory: false,
    markOnlineOnConnect: true,
    getMessage: async (key) => {
      const stored = msgStore.get(key.id);
      if (stored) return stored;
      return undefined;
    },
  });

  session.socket = socket;
  session.msgStore = msgStore;

  // Evento: Conexion
  socket.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log(`[Bot ${botId}] QR generado`);
      session.qr = qr;
      session.status = 'waiting_scan';
      try {
        session.qrDataURL = await QRCode.toDataURL(qr, { width: 300, margin: 2, color: { dark: '#0b1d3a', light: '#ffffff' } });
      } catch(e) { session.qrDataURL = null; }
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const reason = DisconnectReason[statusCode] || `Codigo ${statusCode}`;
      console.log(`[Bot ${botId}] Desconectado: ${reason} (${statusCode})`);
      session.qr = null;
      session.qrDataURL = null;

      if (statusCode === DisconnectReason.loggedOut) {
        session.status = 'disconnected';
        session.phone = null;
        session.socket = null;
        try { await WaAuthState.deleteAll(botId); } catch(e) {}
        await Bots.update(botId, { wa_status: 'disconnected', wa_phone: '' });
        return;
      }

      if (session.retryCount < 5) {
        session.retryCount++;
        session.status = 'reconnecting';
        const delay = Math.min(session.retryCount * 3000, 15000);
        console.log(`[Bot ${botId}] Reconectando en ${delay/1000}s... (intento ${session.retryCount})`);
        setTimeout(() => startSession(botId), delay);
      } else {
        session.status = 'error';
        session.error = `Desconectado: ${reason}. Genera un nuevo QR.`;
        session.socket = null;
      }
    }

    if (connection === 'open') {
      console.log(`[Bot ${botId}] CONECTADO!`);
      session.status = 'connected';
      session.qr = null;
      session.qrDataURL = null;
      session.retryCount = 0;
      session.lastConnected = new Date().toISOString();
      session.error = null;

      const user = socket.user;
      if (user?.id) {
        session.phone = '+' + user.id.split(':')[0].split('@')[0];
        console.log(`[Bot ${botId}] Numero: ${session.phone}`);
        // Update DB
        await Bots.update(botId, { wa_status: 'connected', wa_phone: session.phone, wa_last_connected: session.lastConnected });
      }

      // IMPORTANTE: Baileys buferea eventos (messages.upsert) cuando hay creds existentes.
      // El buffer solo se libera con el handler 'CB:ib,,offline' que a veces no llega.
      // Forzar flush del buffer despues de conectar para asegurar que los mensajes se procesan.
      setTimeout(() => {
        try {
          if (typeof socket.ev.flush === 'function') {
            socket.ev.flush();
            console.log(`[Bot ${botId}] Buffer de eventos flushed (seguridad post-conexion)`);
          }
        } catch(flushErr) {
          console.error(`[Bot ${botId}] Error en flush:`, flushErr.message);
        }
      }, 5000);
    }
  });

  // Evento: Mensajes entrantes
  socket.ev.on('messages.upsert', async ({ messages: msgs }) => {
    for (const msg of msgs) {
      try {
      if (msg.key.remoteJid === 'status@broadcast') continue;
      if (msg.key.fromMe) continue;
      const content = extractMessageContent(msg);
      if (!content) continue;
      if (content.type === 'reaction') continue;

      const senderJid = msg.key.remoteJid;
      const isGroup = senderJid.endsWith('@g.us');
      if (isGroup) continue;

      const senderPhone = senderJid.split('@')[0];
      const jidSuffix = senderJid.includes('@') ? senderJid.split('@')[1] : 's.whatsapp.net';
      const pushName = msg.pushName || senderPhone;

      // 1. MARCAR COMO LEIDO
      try {
        await socket.readMessages([msg.key]);
        console.log(`[Bot ${botId}] Leido: ${pushName}`);
      } catch(e) {
        try {
          await socket.sendReceipt(senderJid, undefined, [msg.key.id], 'read');
        } catch(e2) {
          console.error(`[Bot ${botId}] Error marcando leido:`, e.message);
        }
      }

      // 2. GUARDAR EN BANDEJA
      const entry = {
        id: msg.key.id,
        from: '+' + senderPhone,
        fromJid: senderJid,
        pushName,
        isGroup: false,
        type: content.type,
        text: content.text,
        timestamp: (msg.messageTimestamp || Math.floor(Date.now()/1000)) * 1000,
      };
      session.messages.unshift(entry);
      if (session.messages.length > MAX_MESSAGES) session.messages.length = MAX_MESSAGES;
      session.unreadCount++;

      const timeStr = new Date(entry.timestamp).toLocaleTimeString('es');
      const typeIcon = {text:'💬',image:'🖼️',video:'🎥',ptt:'🎤',audio:'🎵',document:'📄',sticker:'😀',contact:'👤',location:'📍',poll:'📊',unknown:'❓'}[content.type] || '💬';
      console.log(`[Bot ${botId}] ${typeIcon} ${timeStr} | ${pushName} (+${senderPhone}): ${content.text}`);

      // Track conversation in DB + reset follow-ups (cliente respondio)
      await Conversations.upsert(botId, senderPhone, pushName, jidSuffix);
      await Conversations.resetFollowUps(botId, senderPhone);
      console.log(`[Bot ${botId}] [SEGUIMIENTO] Follow-ups reseteados para ${pushName} (+${senderPhone}) — cliente respondio`);

      // 2.5. MANEJAR UBICACION
      if (content.type === 'location' && content.latitude && content.longitude) {
        console.log(`[Bot ${botId}] 📍 UBICACION recibida de ${pushName} (+${senderPhone}): lat=${content.latitude}, lng=${content.longitude}`);
        await Conversations.updateLocation(botId, senderPhone, content.latitude, content.longitude);
        console.log(`[Bot ${botId}] 📍 Coordenadas guardadas en DB para ${pushName} (+${senderPhone})`);
      }

      // 2.6. MANEJAR AUDIO — transcribir con Whisper
      let textToProcess = content.text;
      if (content.type === 'ptt' || content.type === 'audio') {
        console.log(`[Bot ${botId}] 🎤 AUDIO recibido de ${pushName} (+${senderPhone}) — iniciando transcripcion...`);
        const config = await loadBotConfigFromDB(botId);
        if (config && config.openaiKey) {
          try {
            const audioBuffer = await downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest: socket.updateMediaMessage });
            console.log(`[Bot ${botId}] 🎤 Audio descargado: ${audioBuffer.length} bytes`);
            const transcription = await transcribeAudio(audioBuffer, config.openaiKey);
            if (transcription) {
              console.log(`[Bot ${botId}] 🎤 TRANSCRIPCION de ${pushName}: "${transcription}"`);
              textToProcess = transcription;
              // Update the message entry with transcription
              entry.text = `[Audio transcrito]: ${transcription}`;
              session.messages[0] = entry;
            } else {
              console.log(`[Bot ${botId}] 🎤 No se pudo transcribir audio de ${pushName}`);
              textToProcess = null;
            }
          } catch(e) {
            console.error(`[Bot ${botId}] 🎤 Error descargando/transcribiendo audio:`, e.message);
            textToProcess = null;
          }
        } else {
          console.log(`[Bot ${botId}] 🎤 Sin API key para transcribir audio`);
          textToProcess = null;
        }
      }

      // 2.7. MANEJAR UBICACION — convertir a texto para la IA (ANTES del filtro startsWith)
      if (content.type === 'location' && content.latitude && content.longitude) {
        textToProcess = `El cliente envio su ubicacion: latitud ${content.latitude}, longitud ${content.longitude}. Agradece y continua con la venta.`;
        console.log(`[Bot ${botId}] 📍 Texto de ubicacion preparado para IA: "${textToProcess}"`);
      }

      // 3. RESPONDER CON IA
      // Saltar mensajes no procesables: [Imagen], [Video], [Sticker], etc.
      if (!textToProcess || textToProcess.startsWith('[')) continue;

      // Check if bot is active
      const botDb = await Bots.findById(botId);
      if (botDb && !botDb.active) {
        console.log(`[Bot ${botId}] [FLUJO] ⏸️ Bot inactivo, no responde`);
        continue;
      }

      console.log(`[Bot ${botId}] [FLUJO] ━━━ INICIO RESPUESTA a ${pushName} (+${senderPhone}) ━━━`);
      console.log(`[Bot ${botId}] [FLUJO] 📩 Mensaje recibido: "${textToProcess.substring(0, 100)}"`);

      try {
        // PASO 1: Esperar 7 segundos antes de mostrar "escribiendo"
        console.log(`[Bot ${botId}] [FLUJO] ⏳ Esperando 7s antes de escribir...`);
        await new Promise(r => setTimeout(r, 7000));

        // PASO 2: Mostrar "escribiendo..." y consultar la IA
        await socket.presenceSubscribe(senderJid);
        await socket.sendPresenceUpdate('composing', senderJid);
        console.log(`[Bot ${botId}] [FLUJO] ✏️ Escribiendo... (visible para ${pushName})`);

        // Consultar IA mientras se muestra "escribiendo"
        const aiStartTime = Date.now();
        const reply = await getAIResponse(botId, senderPhone, pushName, textToProcess);
        const aiTime = Date.now() - aiStartTime;

        // PASO 3: Asegurar minimo 15s total desde que llego el mensaje (8s restantes aprox)
        const elapsedSinceTyping = Date.now() - aiStartTime;
        const remainingDelay = Math.max(0, 8000 - elapsedSinceTyping);
        if (remainingDelay > 0) {
          console.log(`[Bot ${botId}] [FLUJO] ⏳ Esperando ${Math.round(remainingDelay/1000)}s mas (IA tardo ${Math.round(aiTime/1000)}s)...`);
          await new Promise(r => setTimeout(r, remainingDelay));
        }

        await socket.sendPresenceUpdate('paused', senderJid);

        if (!reply) {
          console.log(`[Bot ${botId}] [FLUJO] ❌ Sin respuesta de IA`);
          continue;
        }

        // PASO 4: Parsear respuesta JSON de la IA
        let parsed;
        try {
          // Limpiar posibles backticks de markdown
          const cleanJson = reply.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
          parsed = JSON.parse(cleanJson);
          console.log(`[Bot ${botId}] [FLUJO] ✅ JSON parseado correctamente`);
        } catch(parseErr) {
          // Fallback: si la IA no devolvio JSON valido, tratar como texto plano
          console.log(`[Bot ${botId}] [FLUJO] ⚠️ Respuesta no es JSON valido, usando como texto plano`);
          const cleanText = reply
            .replace(/\[ENVIAR_IMAGENES:[^\]]+\]/g, '')
            .replace(/\[ENVIAR_OFERTA:[^\]]+\]/g, '')
            .replace(/\[ENVIAR_TESTIMONIOS:[^\]]+\]/g, '')
            .replace(/\[ENVIAR_REPORTE:[^\]]+\]/g, '')
            .trim();
          parsed = { mensaje1: cleanText, mensaje2: '', mensaje3: '', fotos_mensaje1: '', reporte: '' };

          // Extraer comandos del texto plano
          const imgM = reply.match(/\[ENVIAR_IMAGENES:([^\]]+)\]/);
          const ofrM = reply.match(/\[ENVIAR_OFERTA:([^\]]+)\]/);
          const tstM = reply.match(/\[ENVIAR_TESTIMONIOS:([^\]]+)\]/);
          const rptM = reply.match(/\[ENVIAR_REPORTE:([^\]]+)\]/);
          if (imgM) parsed.fotos_mensaje1 = `[ENVIAR_IMAGENES:${imgM[1]}]`;
          if (ofrM) parsed.fotos_mensaje1 = `[ENVIAR_OFERTA:${ofrM[1]}]`;
          if (tstM) parsed.fotos_mensaje1 = `[ENVIAR_TESTIMONIOS:${tstM[1]}]`;
          if (rptM) parsed.reporte = `[ENVIAR_REPORTE:${rptM[1]}]`;
        }

        const msgs = [parsed.mensaje1, parsed.mensaje2, parsed.mensaje3].filter(m => m && m.trim());
        const fotoCmd = (parsed.fotos_mensaje1 || '').trim();
        const reporteCmd = (parsed.reporte || '').trim();

        console.log(`[Bot ${botId}] [FLUJO] 📤 Mensajes a enviar: ${msgs.length} | Foto: ${fotoCmd || 'ninguna'} | Reporte: ${reporteCmd ? reporteCmd.substring(0, 120) + (reporteCmd.length > 120 ? '...' : '') : 'no'} | Reporte length: ${reporteCmd.length}`);

        // Helper para guardar mensaje en bandeja
        const pushBotMsg = (text) => {
          session.messages.unshift({
            id: 'bot_' + Date.now() + '_' + Math.random().toString(36).slice(2,5),
            from: session.phone || 'bot', fromJid: 'bot', pushName: 'Bot',
            isGroup: false, type: 'text', text, timestamp: Date.now(), isBot: true,
          });
          if (session.messages.length > MAX_MESSAGES) session.messages.length = MAX_MESSAGES;
        };

        // PASO 5: Enviar mensajes uno por uno con delay natural entre ellos
        for (let i = 0; i < msgs.length; i++) {
          const msgText = msgs[i].trim();
          if (!msgText) continue;

          // Mostrar "escribiendo" entre mensajes
          if (i > 0) {
            await socket.sendPresenceUpdate('composing', senderJid);
            const typingDelay = Math.min(msgText.length * 40, 3000) + 500;
            await new Promise(r => setTimeout(r, typingDelay));
            await socket.sendPresenceUpdate('paused', senderJid);
          }

          const sentMsg = await socket.sendMessage(senderJid, { text: msgText });
          if (sentMsg?.key?.id) {
            msgStore.set(sentMsg.key.id, { conversation: msgText });
            if (msgStore.size > 500) { const fk = msgStore.keys().next().value; msgStore.delete(fk); }
            saveMsgStore(botId, sentMsg.key.id, { conversation: msgText });
          }
          pushBotMsg(msgText);
          console.log(`[Bot ${botId}] [FLUJO] ✅ Mensaje ${i+1}/${msgs.length} enviado (${msgText.length} chars): "${msgText.substring(0, 60)}..."`);
        }

        // PASO 6: Enviar imagen si fue solicitada (1 sola)
        const imageMatch = fotoCmd.match(/\[ENVIAR_IMAGENES:([^\]]+)\]/);
        const offerMatch = fotoCmd.match(/\[ENVIAR_OFERTA:([^\]]+)\]/);
        const testimonialMatch = fotoCmd.match(/\[ENVIAR_TESTIMONIOS:([^\]]+)\]/);

        if (imageMatch) {
          await sendProductImages(socket, senderJid, imageMatch[1], botId, msgStore);
        } else if (offerMatch) {
          await sendOfferImages(socket, senderJid, offerMatch[1], botId, msgStore);
        } else if (testimonialMatch) {
          await sendTestimonialImages(socket, senderJid, testimonialMatch[1], botId, msgStore);
        }

        // PASO 7: Enviar reporte si fue solicitado
        const reportMatch = reporteCmd.match(/\[ENVIAR_REPORTE:([^\]]+)\]/);
        const hasReport = reportMatch || reporteCmd.length > 5;

        if (hasReport) {
          const botConfig = await loadBotConfigFromDB(botId);
          const reportNumber = botConfig?.reportNumber;
          const botDB = await Bots.findById(botId);
          const conv = await Conversations.findByBotAndPhone(botId, senderPhone);
          let productId = '';
          let product = null;
          let reportTextToSend = '';

          if (reportMatch) {
            // Formato comando: [ENVIAR_REPORTE:product_id] — generar texto del reporte
            productId = reportMatch[1];
            product = await Products.findById(productId);
            // Generar texto de reporte estilo system prompt
            reportTextToSend = `📋 *REPORTE DE VENTA*\n\n`;
            reportTextToSend += `👤 *Cliente:* ${pushName}\n`;
            reportTextToSend += `📱 *Telefono:* +${senderPhone}\n`;
            if (product?.nombre) reportTextToSend += `📦 *Producto:* ${product.nombre}\n`;
            if (product?.precio_unitario) reportTextToSend += `💰 *Precio:* ${product.moneda || 'BOB'} ${product.precio_unitario}\n`;
            if (conv?.latitude && conv?.longitude) {
              reportTextToSend += `📍 *Coordenadas:* ${conv.latitude}, ${conv.longitude}\n`;
              reportTextToSend += `🗺️ *Mapa:* https://www.google.com/maps?q=${conv.latitude},${conv.longitude}\n`;
            }
            reportTextToSend += `🤖 *Agente:* ${botDB?.name || 'Bot'}\n`;
            reportTextToSend += `\n🕐 *Fecha:* ${new Date().toLocaleString('es-BO', { timeZone: 'America/La_Paz' })}`;
          } else {
            // Formato texto libre: la IA genero el reporte con el formato del system prompt
            reportTextToSend = reporteCmd;
          }

          // 1. Enviar al numero de reporte
          if (reportNumber) {
            let cleanNumber = reportNumber.replace(/[+\s\-()]/g, '');
            if (cleanNumber.length <= 8) cleanNumber = '591' + cleanNumber;
            const reportJid = cleanNumber + '@s.whatsapp.net';
            console.log(`[Bot ${botId}] [REPORTE] 📋 Enviando reporte a ${cleanNumber}...`);
            try {
              const sentMsg = await socket.sendMessage(reportJid, { text: reportTextToSend });
              if (sentMsg?.key?.id && msgStore) {
                msgStore.set(sentMsg.key.id, { conversation: reportTextToSend });
                saveMsgStore(botId, sentMsg.key.id, { conversation: reportTextToSend });
              }
              console.log(`[Bot ${botId}] [REPORTE] ✅ REPORTE enviado a ${cleanNumber}`);
            } catch(e) {
              console.error(`[Bot ${botId}] [REPORTE] ❌ Error enviando reporte:`, e.message);
            }
          } else {
            console.log(`[Bot ${botId}] [REPORTE] ❌ Sin numero de reporte configurado`);
          }

          // 2. Registrar venta en DB (misma fuente de verdad)
          try {
            // Extraer datos del texto del reporte para los campos estructurados
            const extractField = (text, patterns) => {
              for (const pat of patterns) {
                const m = text.match(pat);
                if (m) return m[1].trim();
              }
              return '';
            };

            const reportClientName = extractField(reportTextToSend, [
              /\*?Cliente\*?[:\s]+(.+)/i,
              /pedido de\s+(.+?)[\.\n]/i,
              /nombre[:\s]+(.+)/i
            ]) || pushName;

            const reportProduct = extractField(reportTextToSend, [
              /\*?Producto\*?[:\s]+(.+)/i,
              /\*?Descripci[oó]n\*?[:\s]+(.+)/i
            ]) || (product?.nombre || '');

            const reportAmount = extractField(reportTextToSend, [
              /\*?Precio\*?[:\s]+(.+)/i,
              /\*?Monto\*?[:\s]+(.+)/i,
              /(?:BOB|USD|Bs\.?)\s*([\d.,]+)/i
            ]) || (product?.precio_unitario || '');

            const reportCity = extractField(reportTextToSend, [
              /\*?Ciudad\*?[:\s]+(.+)/i,
              /\*?Direcci[oó]n\*?[:\s]+(.+)/i
            ]);

            const reportCurrency = reportTextToSend.match(/USD/i) ? 'USD' : (product?.moneda || 'BOB');

            await Sales.create({
              bot_id: botId,
              user_id: botDB?.user_id || '',
              phone: senderPhone,
              client_name: reportClientName,
              product_name: reportProduct,
              product_id: productId,
              amount: reportAmount,
              currency: reportCurrency,
              city: reportCity,
              latitude: conv?.latitude || null,
              longitude: conv?.longitude || null,
              report_text: reportTextToSend,
              bot_name: botDB?.name || '',
            });
            console.log(`[Bot ${botId}] [VENTA] ✅ Venta registrada: ${reportClientName} - ${reportProduct || 'producto'}`);
          } catch(e) { console.error(`[Bot ${botId}] [VENTA] Error registrando:`, e.message); }
        }

        // Track bot reply for follow-ups
        await Conversations.updateBotReply(botId, senderPhone);
        console.log(`[Bot ${botId}] [FLUJO] ━━━ FIN RESPUESTA a ${pushName} ━━━`);
      } catch(e) {
        console.error(`[Bot ${botId}] [FLUJO] ❌ Error respondiendo a ${pushName}:`, e.message);
        try { await socket.sendPresenceUpdate('paused', senderJid); } catch(e2) {}
      }
      } catch(msgErr) {
        console.error(`[Bot ${botId}] [MSG] Error procesando mensaje:`, msgErr.message);
        if (msgErr.stack) console.error(msgErr.stack);
      }
    }
  });

  socket.ev.on('creds.update', saveCreds);
  return session;

  } catch(startErr) {
    console.error(`[Bot ${botId}] Error en startSession:`, startErr.message);
    session.status = 'error';
    session.error = startErr.message;
    throw startErr;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
//  FOLLOW-UP AUTOMATION
// ══════════════════════════════════════════════════════════════════════════════
const FOLLOW_UP_MESSAGES = [
  "Hola! Vi que estabas interesado 😊 Tienes alguna pregunta sobre el producto? Estoy aqui para ayudarte.",
  "Hola de nuevo! Solo queria recordarte que tenemos disponibilidad 💚 Si necesitas mas informacion, con gusto te ayudo.",
];

let followUpRunning = false;

// Generar follow-up con IA SIN contaminar el historial de conversacion
async function generateFollowUpAI(botId, phone, pushName, config, followUpCount, seg1, seg2) {
  if (!config || !config.openaiKey) return null;

  const waitMinutes = followUpCount === 0 ? seg1 : seg2;

  // Construir contexto del historial (solo lectura, no modificamos)
  const dbHistory = await ConversationHistory.getHistory(botId, phone, 10);
  let contextSummary = '';
  if (dbHistory.length > 0) {
    const lastMsgs = dbHistory.slice(-6).map(m =>
      `${m.role === 'user' ? 'Cliente' : 'Bot'}: ${(m.content || '').substring(0, 120)}`
    ).join('\n');
    contextSummary = `\n\nCONTEXTO DE LA CONVERSACION ANTERIOR:\n${lastMsgs}\n`;
  }

  const systemPrompt = (config.systemPrompt || '') +
    `\n\n---\nGENERA UN MENSAJE DE SEGUIMIENTO.\n` +
    `El cliente "${pushName || 'cliente'}" no ha respondido en ${waitMinutes} minutos.\n` +
    `${contextSummary}` +
    `Genera un mensaje breve que RETOME la conversacion anterior de forma natural y personalizada.\n` +
    `Debe sentirse como una continuacion logica, no un mensaje generico.\n` +
    `Usa el contexto de lo que el cliente pregunto o mostro interes.\n` +
    `Breve, amable, con 1-2 emojis. Maximo 80 caracteres. No repitas lo ultimo que dijiste.\n\n` +
    `Responde SOLO con JSON: {"mensaje1":"tu mensaje de seguimiento","mensaje2":"","mensaje3":"","fotos_mensaje1":"","reporte":""}\n`;

  const modelMap = { 'gpt-4': 'gpt-4', 'gpt-4-turbo': 'gpt-4-turbo', 'gpt-5': 'gpt-4o', 'gpt-5.1': 'gpt-4o' };
  const modelId = modelMap[config.model] || config.model || 'gpt-4o';

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.openaiKey}` },
      body: JSON.stringify({
        model: modelId,
        messages: [
          { role: 'system', content: systemPrompt },
          ...dbHistory.slice(-6),
          { role: 'user', content: `[El cliente no responde hace ${waitMinutes} minutos. Genera seguimiento.]` }
        ],
        max_tokens: 256,
        temperature: 0.8,
        response_format: { type: 'json_object' }
      }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      console.error(`[Bot ${botId}] [SEGUIMIENTO] ❌ OpenAI error (${response.status}):`, err.error?.message || 'Unknown');
      return null;
    }

    const data = await response.json();
    const reply = data.choices?.[0]?.message?.content?.trim();
    if (!reply) return null;

    // Parsear JSON
    try {
      const cleanJson = reply.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
      const parsed = JSON.parse(cleanJson);
      const msg = (parsed.mensaje1 || '').trim();
      if (msg) {
        console.log(`[Bot ${botId}] [SEGUIMIENTO] IA genero: "${msg.substring(0, 80)}"`);
        return msg;
      }
    } catch(e) {
      // No es JSON, limpiar y usar como texto
      const cleaned = reply
        .replace(/\[ENVIAR_IMAGENES:[^\]]+\]/g, '')
        .replace(/\[ENVIAR_OFERTA:[^\]]+\]/g, '')
        .replace(/\[ENVIAR_TESTIMONIOS:[^\]]+\]/g, '')
        .replace(/\[ENVIAR_REPORTE:[^\]]+\]/g, '')
        .replace(/[{}"]/g, '')
        .trim();
      if (cleaned && cleaned.length > 3) {
        console.log(`[Bot ${botId}] [SEGUIMIENTO] IA (texto plano): "${cleaned.substring(0, 80)}"`);
        return cleaned;
      }
    }
    return null;
  } catch(e) {
    console.error(`[Bot ${botId}] [SEGUIMIENTO] ❌ Error IA:`, e.message);
    return null;
  }
}

async function processFollowUps() {
  if (followUpRunning) return;
  followUpRunning = true;

  try {
    const allBots = await Bots.getAll();
    let botsChecked = 0;
    let totalPending = 0;

    for (const bot of allBots) {
      if (!bot.active) continue;
      const session = sessions.get(bot.id);
      if (!session || session.status !== 'connected' || !session.socket) continue;

      botsChecked++;
      const seg1 = bot.seg1 || 15;
      const seg2 = bot.seg2 || 400;
      const pending = await Conversations.getPendingFollowUps(bot.id, seg1, seg2);
      totalPending += pending.length;

      if (pending.length > 0) {
        console.log(`[Bot ${bot.id}] [SEGUIMIENTO] ━━━ ${pending.length} seguimiento(s) pendiente(s) (seg1=${seg1}min, seg2=${seg2}min) ━━━`);
      }

      for (const conv of pending) {
        const followUpNum = conv.follow_up_count + 1;
        const jid = conv.phone + '@' + (conv.jid_suffix || 's.whatsapp.net');
        const fallbackMsg = FOLLOW_UP_MESSAGES[conv.follow_up_count] || FOLLOW_UP_MESSAGES[0];

        console.log(`[Bot ${bot.id}] [SEGUIMIENTO] 📤 Preparando seguimiento #${followUpNum} para ${conv.push_name} (+${conv.phone}) | Ultimo reply bot: ${conv.last_bot_reply_at}`);

        try {
          // Mostrar "escribiendo..." (no bloquear si falla)
          try {
            await session.socket.presenceSubscribe(jid);
            await session.socket.sendPresenceUpdate('composing', jid);
            await new Promise(r => setTimeout(r, 3000));
            await session.socket.sendPresenceUpdate('paused', jid);
          } catch(typingErr) {
            console.log(`[Bot ${bot.id}] [SEGUIMIENTO] ⚠️ Error en typing indicator (continuando): ${typingErr.message}`);
          }

          // Generar follow-up con IA (sin contaminar historial)
          const config = await loadBotConfigFromDB(bot.id);
          let followUp = await generateFollowUpAI(bot.id, conv.phone, conv.push_name, config, conv.follow_up_count, seg1, seg2);
          if (!followUp) followUp = fallbackMsg;

          // Enviar mensaje
          const sentMsg = await session.socket.sendMessage(jid, { text: followUp });
          if (sentMsg?.key?.id && session.msgStore) {
            session.msgStore.set(sentMsg.key.id, { conversation: followUp });
            saveMsgStore(bot.id, sentMsg.key.id, { conversation: followUp });
          }

          // Guardar en bandeja del panel para que sea visible
          session.messages.unshift({
            id: 'followup_' + Date.now() + '_' + Math.random().toString(36).slice(2,5),
            from: session.phone || 'bot', fromJid: 'bot', pushName: 'Bot (Seguimiento)',
            isGroup: false, type: 'text', text: `[Seguimiento #${followUpNum}] ${followUp}`,
            timestamp: Date.now(), isBot: true,
          });
          if (session.messages.length > MAX_MESSAGES) session.messages.length = MAX_MESSAGES;

          // Guardar en historial persistente (solo el mensaje enviado, sin contaminar con [SISTEMA:])
          await ConversationHistory.add(bot.id, conv.phone, 'assistant', followUp);

          // Actualizar DB: incrementar count y actualizar timer para el siguiente seguimiento
          await Conversations.incrementFollowUp(bot.id, conv.phone);
          await Conversations.updateBotReply(bot.id, conv.phone);
          console.log(`[Bot ${bot.id}] [SEGUIMIENTO] ✅ Seguimiento #${followUpNum} enviado a ${conv.push_name} (+${conv.phone}): "${followUp.substring(0, 60)}..."`);
        } catch(e) {
          console.error(`[Bot ${bot.id}] [SEGUIMIENTO] ❌ Error en seguimiento a ${conv.push_name} (+${conv.phone}):`, e.message);
        }
      }
    }
    if (botsChecked > 0 && totalPending === 0) {
      // Log cada ~5 min (10 ciclos de 30s) para confirmar que el sistema esta activo
      if (!processFollowUps._logCounter) processFollowUps._logCounter = 0;
      processFollowUps._logCounter++;
      if (processFollowUps._logCounter % 10 === 1) {
        console.log(`[SEGUIMIENTO] ✅ Sistema activo | ${botsChecked} bot(s) conectado(s) | Sin seguimientos pendientes`);
      }
    }
  } catch(e) {
    console.error('[SEGUIMIENTO] ❌ Error general:', e.message);
  } finally {
    followUpRunning = false;
  }
}

// Run follow-ups every 30 seconds for faster detection
setInterval(processFollowUps, 30000);
// Run once on startup after 10 seconds
setTimeout(processFollowUps, 10000);

// ══════════════════════════════════════════════════════════════════════════════
//  RUTAS: PAGINAS HTML
// ══════════════════════════════════════════════════════════════════════════════
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'login.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'login.html')));
app.get('/register', (req, res) => res.sendFile(path.join(__dirname, 'register.html')));
app.get('/panel', (req, res) => res.sendFile(path.join(__dirname, 'panel.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));

// ══════════════════════════════════════════════════════════════════════════════
//  RUTAS: AUTENTICACION
// ══════════════════════════════════════════════════════════════════════════════
app.post('/api/auth/register', async (req, res) => {
  try {
    console.log(`[AUTH] [REGISTRO] Intento de registro: ${req.body.username || 'sin-username'} / ${req.body.email || 'sin-email'}`);
    const { username, email, password, nombre, apellido, fecha_nacimiento, ciudad, usuario_fase, patrocinador_fase, foto_factura } = req.body;
    if (!username || !email || !password || !nombre || !apellido) {
      return res.status(400).json({ error: 'Usuario, nombre, apellido, correo y contrasena son obligatorios' });
    }
    if (!usuario_fase) {
      return res.status(400).json({ error: 'El Usuario de Fase Global es obligatorio' });
    }
    if (username.length < 3) {
      return res.status(400).json({ error: 'El usuario debe tener al menos 3 caracteres' });
    }
    if (!/^[a-zA-Z0-9_.-]+$/.test(username)) {
      return res.status(400).json({ error: 'El usuario solo puede contener letras, numeros, puntos, guiones y guion bajo' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'La contrasena debe tener al menos 6 caracteres' });
    }
    const existingUser = await Users.findByUsername(username);
    if (existingUser) {
      return res.status(400).json({ error: 'Este nombre de usuario ya esta registrado' });
    }
    const existingFase = await Users.findByUsuarioFase(usuario_fase);
    if (existingFase) {
      return res.status(400).json({ error: 'Este Usuario de Fase Global ya esta registrado' });
    }
    const existingEmail = await Users.findByEmail(email);
    if (existingEmail) {
      return res.status(400).json({ error: 'Este correo ya esta registrado' });
    }
    const user = await Users.create({ username, email, password, nombre, apellido, fecha_nacimiento, ciudad, usuario_fase, patrocinador_fase, foto_factura });
    console.log(`[AUTH] [REGISTRO] ✅ Usuario registrado: ${username} (${user.id}) | Fase: ${usuario_fase} | Estado: pendiente`);
    res.json({ ok: true, message: 'Registro exitoso. Tu cuenta esta pendiente de aprobacion por el administrador.', userId: user.id });
  } catch(e) {
    console.error('[Auth] Error registro:', e.message);
    res.status(500).json({ error: 'Error al registrar' });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
//  SUPABASE STORAGE — Upload helper (persistent storage for Render)
// ══════════════════════════════════════════════════════════════════════════════
const memUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

async function uploadToSupabase(bucket, fileBuffer, mimetype, originalname) {
  const sbUrl = process.env.SUPABASE_URL;
  const sbKey = process.env.SUPABASE_SERVICE_KEY;
  if (!sbUrl || !sbKey) throw new Error('Storage no configurado');
  const ext = path.extname(originalname).toLowerCase();
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2,8)}${ext}`;
  const uploadRes = await fetch(`${sbUrl}/storage/v1/object/${bucket}/${filename}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${sbKey}`,
      'Content-Type': mimetype,
      'x-upsert': 'true'
    },
    body: fileBuffer
  });
  if (!uploadRes.ok) {
    const errBody = await uploadRes.text();
    console.error(`[Storage] Upload error (${bucket}):`, uploadRes.status, errBody);
    throw new Error('Error al subir a storage');
  }
  const url = `${sbUrl}/storage/v1/object/public/${bucket}/${filename}`;
  console.log(`[Storage] Uploaded to ${bucket}: ${filename}`);
  return url;
}

// Ensure Supabase Storage buckets exist on startup
(async () => {
  const sbUrl = process.env.SUPABASE_URL;
  const sbKey = process.env.SUPABASE_SERVICE_KEY;
  if (!sbUrl || !sbKey) return;
  for (const bucket of ['invoices', 'products', 'profiles']) {
    try {
      await fetch(`${sbUrl}/storage/v1/bucket`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${sbKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: bucket, name: bucket, public: true })
      });
    } catch(e) {}
  }
  console.log('[Storage] Buckets ready (invoices, products, profiles)');
})();

app.post('/api/auth/register/upload-invoice', memUpload.single('invoice'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No se subio archivo' });
  try {
    const url = await uploadToSupabase('invoices', req.file.buffer, req.file.mimetype, req.file.originalname);
    res.json({ ok: true, url });
  } catch(e) {
    console.error('[Storage] Invoice upload failed:', e.message);
    res.status(500).json({ error: 'Error al subir archivo: ' + e.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    console.log(`[AUTH] [LOGIN] Intento de login: ${username || 'sin-usuario'}`);
    if (!username || !password) {
      return res.status(400).json({ error: 'Usuario Fase Global y contrasena requeridos' });
    }
    // Login con usuario_fase (Fase Global), fallback a username para compatibilidad
    const user = await Users.findByUsuarioFase(username) || await Users.findByUsername(username);
    if (!user) {
      console.log(`[AUTH] [LOGIN] ❌ Usuario no encontrado: ${username}`);
      return res.status(401).json({ error: 'Usuario o contrasena incorrectos' });
    }
    if (!Users.verifyPassword(user, password)) {
      console.log(`[AUTH] [LOGIN] ❌ Password incorrecto para: ${username} (${user.id})`);
      return res.status(401).json({ error: 'Usuario o contrasena incorrectos' });
    }
    if (user.status === 'pendiente') {
      console.log(`[AUTH] [LOGIN] ⏳ Login bloqueado (pendiente): ${username}`);
      return res.status(403).json({ error: 'Tu cuenta esta pendiente de aprobacion', status: 'pendiente' });
    }
    if (user.status === 'suspendido') {
      console.log(`[AUTH] [LOGIN] 🚫 Login bloqueado (suspendido): ${username}`);
      return res.status(403).json({ error: 'Tu cuenta esta suspendida', status: 'suspendido' });
    }
    if (user.status === 'bloqueado') {
      console.log(`[AUTH] [LOGIN] 🔒 Login bloqueado (bloqueado): ${username}`);
      return res.status(403).json({ error: 'Tu cuenta esta bloqueada', status: 'bloqueado' });
    }

    console.log(`[AUTH] [LOGIN] ✅ Login exitoso: ${user.nombre} ${user.apellido} (${user.role}) — ${user.id}`);
    const token = generateToken(user);
    res.json({
      ok: true,
      token,
      user: {
        id: user.id, username: user.username, email: user.email, nombre: user.nombre, apellido: user.apellido,
        role: user.role, status: user.status, foto_perfil: user.foto_perfil,
        usuario_fase: user.usuario_fase, rango_fase: user.rango_fase, ciudad: user.ciudad,
        max_bots: user.max_bots,
      }
    });
  } catch(e) {
    console.error('[Auth] Error login:', e.message);
    res.status(500).json({ error: 'Error al iniciar sesion' });
  }
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  const u = req.user;
  res.json({
    id: u.id, username: u.username, email: u.email, nombre: u.nombre, apellido: u.apellido,
    fecha_nacimiento: u.fecha_nacimiento, ciudad: u.ciudad,
    usuario_fase: u.usuario_fase, patrocinador_fase: u.patrocinador_fase,
    rango_fase: u.rango_fase, foto_perfil: u.foto_perfil,
    role: u.role, status: u.status, max_bots: u.max_bots,
  });
});

// ══════════════════════════════════════════════════════════════════════════════
//  RUTAS: PERFIL DE USUARIO
// ══════════════════════════════════════════════════════════════════════════════
app.put('/api/user/profile', requireAuth, async (req, res) => {
  const { nombre, apellido, ciudad, usuario_fase, rango_fase } = req.body;
  const updates = {};
  if (nombre !== undefined) updates.nombre = nombre;
  if (apellido !== undefined) updates.apellido = apellido;
  if (ciudad !== undefined) updates.ciudad = ciudad;
  if (usuario_fase !== undefined) updates.usuario_fase = usuario_fase;
  if (rango_fase !== undefined) updates.rango_fase = rango_fase;
  const updated = await Users.update(req.user.id, updates);
  console.log(`[PERFIL] Perfil actualizado: ${updated.nombre} ${updated.apellido} (${req.user.id})`);
  res.json({ ok: true, user: { id: updated.id, nombre: updated.nombre, apellido: updated.apellido, ciudad: updated.ciudad, usuario_fase: updated.usuario_fase, rango_fase: updated.rango_fase, foto_perfil: updated.foto_perfil } });
});

app.post('/api/user/profile/photo', requireAuth, memUpload.single('photo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No se subio foto' });
  try {
    const url = await uploadToSupabase('profiles', req.file.buffer, req.file.mimetype, req.file.originalname);
    await Users.update(req.user.id, { foto_perfil: url });
    res.json({ ok: true, url });
  } catch(e) {
    console.error('[Storage] Profile photo upload failed:', e.message);
    res.status(500).json({ error: 'Error al subir foto: ' + e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
//  RUTAS: ADMIN — GESTION DE USUARIOS
// ══════════════════════════════════════════════════════════════════════════════
app.get('/api/admin/users', requireAdmin, async (req, res) => {
  const users = await Users.getAll();
  const usersWithBots = [];
  for (const u of users) {
    usersWithBots.push({ ...u, bot_count: await Users.countBots(u.id) });
  }
  res.json(usersWithBots);
});

app.put('/api/admin/users/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const user = await Users.findById(id);
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
  const updated = await Users.update(id, req.body);
  res.json({ ok: true, user: updated });
});

app.put('/api/admin/users/:id/status', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  if (!['pendiente', 'activo', 'suspendido', 'bloqueado'].includes(status)) {
    return res.status(400).json({ error: 'Estado invalido' });
  }
  const user = await Users.findById(id);
  const prevStatus = user?.status || 'unknown';
  const updated = await Users.update(id, { status });
  console.log(`[ADMIN] [STATUS] Usuario ${updated.nombre} ${updated.apellido} (${id}): ${prevStatus} → ${status} | Por: ${req.user.nombre}`);
  res.json({ ok: true, user: updated });
});

app.put('/api/admin/users/:id/max-bots', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { max_bots } = req.body;
  const updated = await Users.update(id, { max_bots: parseInt(max_bots) || 1 });
  res.json({ ok: true, user: updated });
});

app.delete('/api/admin/users/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const user = await Users.findById(id);
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
  if (user.role === 'admin') return res.status(400).json({ error: 'No se puede eliminar al administrador' });
  console.log(`[ADMIN] [DELETE] Usuario eliminado: ${user.nombre} ${user.apellido} (${id}) | Por: ${req.user.nombre}`);
  await Users.delete(id);
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════════════════════
//  RUTAS: ADMIN — GESTION DE BOTS
// ══════════════════════════════════════════════════════════════════════════════
app.get('/api/admin/bots', requireAdmin, async (req, res) => {
  const bots = await Bots.getAll();
  res.json(bots);
});

app.put('/api/admin/bots/:id', requireAdmin, async (req, res) => {
  const bot = await Bots.findById(req.params.id);
  if (!bot) return res.status(404).json({ error: 'Bot no encontrado' });
  const updated = await Bots.update(req.params.id, req.body);
  res.json({ ok: true, bot: updated });
});

app.delete('/api/admin/bots/:id', requireAdmin, async (req, res) => {
  const bot = await Bots.findById(req.params.id);
  if (!bot) return res.status(404).json({ error: 'Bot no encontrado' });
  await Bots.delete(req.params.id);
  res.json({ ok: true });
});

app.put('/api/admin/bots/:id/status', requireAdmin, async (req, res) => {
  const { status } = req.body;
  if (!['active', 'suspended', 'deleted'].includes(status)) {
    return res.status(400).json({ error: 'Estado invalido' });
  }
  await Bots.update(req.params.id, { status });
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════════════════════
//  RUTAS: BOTS DEL USUARIO
// ══════════════════════════════════════════════════════════════════════════════
app.get('/api/bots', requireAuth, async (req, res) => {
  const bots = await Bots.findByUser(req.user.id);
  const result = [];
  for (const b of bots) {
    const products = await Products.findByBot(b.id);
    result.push(botToFrontend(b, products));
  }
  res.json(result);
});

app.post('/api/bots', requireAuth, async (req, res) => {
  const currentCount = await Users.countBots(req.user.id);
  if (currentCount >= req.user.max_bots) {
    console.log(`[AGENTE] [CREAR] ❌ Limite alcanzado: ${req.user.nombre} tiene ${currentCount}/${req.user.max_bots} agentes`);
    return res.status(403).json({ error: `Has alcanzado el limite de ${req.user.max_bots} bot(s). Contacta al administrador.` });
  }
  const bot = await Bots.create(req.user.id, req.body);
  const products = await Products.findByBot(bot.id);
  console.log(`[AGENTE] [CREAR] ✅ Agente creado: "${bot.name}" (${bot.id}) | Usuario: ${req.user.nombre} (${req.user.id}) | Total: ${currentCount + 1}/${req.user.max_bots}`);
  res.json({ ok: true, bot: botToFrontend(bot, products) });
});

app.get('/api/bots/:id', requireAuth, async (req, res) => {
  const bot = await Bots.findById(req.params.id);
  if (!bot) return res.status(404).json({ error: 'Bot no encontrado' });
  if (bot.user_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'No tienes acceso a este bot' });
  }
  const products = await Products.findByBot(bot.id);
  res.json(botToFrontend(bot, products));
});

app.put('/api/bots/:id', requireAuth, async (req, res) => {
  const bot = await Bots.findById(req.params.id);
  if (!bot) return res.status(404).json({ error: 'Bot no encontrado' });
  if (bot.user_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'No tienes acceso a este bot' });
  }

  const data = req.body;
  const updates = {};

  if (data.name !== undefined) updates.name = data.name;
  if (data.icon !== undefined) updates.icon = data.icon;
  if (data.active !== undefined) updates.active = data.active ? 1 : 0;
  if (data.model !== undefined) updates.model = data.model;
  if (data.credentials) {
    if (data.credentials.openaiKey !== undefined) updates.openai_key = data.credentials.openaiKey;
    if (data.credentials.reportNumber !== undefined) updates.report_number = data.credentials.reportNumber;
  }
  if (data.template) {
    if (data.template.systemPrompt !== undefined) updates.system_prompt = data.template.systemPrompt;
    if (data.template.msg1Limit !== undefined) updates.msg1_limit = data.template.msg1Limit;
    if (data.template.msg2Limit !== undefined) updates.msg2_limit = data.template.msg2Limit;
    if (data.template.msg3Limit !== undefined) updates.msg3_limit = data.template.msg3Limit;
    if (data.template.strictJson !== undefined) updates.strict_json = data.template.strictJson ? 1 : 0;
  }
  if (data.seguimientos) {
    if (data.seguimientos.seg1 !== undefined) updates.seg1 = data.seguimientos.seg1;
    if (data.seguimientos.seg2 !== undefined) updates.seg2 = data.seguimientos.seg2;
  }

  if (Object.keys(updates).length > 0) {
    await Bots.update(req.params.id, updates);
    console.log(`[AGENTE] [CONFIG] Agente ${req.params.id} actualizado: ${Object.keys(updates).join(', ')} | Por: ${req.user.nombre}`);
  }

  if (data.products) {
    await Products.deleteByBot(req.params.id);
    for (const p of data.products) {
      await Products.create(req.params.id, p);
    }
    console.log(`[AGENTE] [PRODUCTOS] ${data.products.length} producto(s) guardados para agente ${req.params.id}`);
  }

  const updated = await Bots.findById(req.params.id);
  const products = await Products.findByBot(req.params.id);
  res.json({ ok: true, bot: botToFrontend(updated, products) });
});

app.delete('/api/bots/:id', requireAuth, async (req, res) => {
  const bot = await Bots.findById(req.params.id);
  if (!bot) return res.status(404).json({ error: 'Bot no encontrado' });
  if (bot.user_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'No tienes acceso a este bot' });
  }
  await Bots.delete(req.params.id);
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════════════════════
//  RUTAS: PRODUCTOS
// ══════════════════════════════════════════════════════════════════════════════
app.get('/api/bots/:botId/products', requireAuth, async (req, res) => {
  const bot = await Bots.findById(req.params.botId);
  if (!bot) return res.status(404).json({ error: 'Bot no encontrado' });
  if (bot.user_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'No tienes acceso' });
  }
  res.json(await Products.findByBot(req.params.botId));
});

app.post('/api/bots/:botId/products', requireAuth, async (req, res) => {
  const bot = await Bots.findById(req.params.botId);
  if (!bot) return res.status(404).json({ error: 'Bot no encontrado' });
  if (bot.user_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'No tienes acceso' });
  }
  const product = await Products.create(req.params.botId, req.body);
  res.json({ ok: true, product });
});

// Upload product image (Supabase Storage)
app.post('/api/bots/:botId/products/upload-image', requireAuth, async (req, res, next) => {
  const bot = await Bots.findById(req.params.botId);
  if (!bot) return res.status(404).json({ error: 'Bot no encontrado' });
  if (bot.user_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'No tienes acceso a este bot' });
  }
  next();
}, memUpload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No se subio imagen' });
  try {
    const url = await uploadToSupabase('products', req.file.buffer, req.file.mimetype, req.file.originalname);
    console.log(`[UPLOAD] Imagen de producto subida: ${url} (bot: ${req.params.botId}, user: ${req.user.id})`);
    res.json({ ok: true, url });
  } catch(e) {
    console.error('[Storage] Product image upload failed:', e.message);
    res.status(500).json({ error: 'Error al subir imagen: ' + e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
//  RUTAS: WHATSAPP SESSIONS (with auth + ownership validation)
// ══════════════════════════════════════════════════════════════════════════════

// Middleware: verify bot belongs to authenticated user (or user is admin)
async function requireBotOwner(req, res, next) {
  const { botId } = req.params;
  const bot = await Bots.findById(botId);
  if (!bot) return res.status(404).json({ error: 'Bot no encontrado' });
  if (bot.user_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'No tienes acceso a este bot' });
  }
  req.bot = bot;
  next();
}

// Config sync
app.post('/api/wa/sessions/:botId/config', requireAuth, requireBotOwner, async (req, res) => {
  const { botId } = req.params;
  const config = req.body;
  console.log(`[API] POST /config — Bot ${botId}`);

  const bot = await Bots.findById(botId);
  if (bot) {
    const updates = {};
    if (config.openaiKey !== undefined) updates.openai_key = config.openaiKey;
    if (config.model !== undefined) updates.model = config.model;
    if (config.systemPrompt !== undefined) updates.system_prompt = config.systemPrompt;
    if (config.msg1Limit !== undefined) updates.msg1_limit = config.msg1Limit;
    if (config.msg2Limit !== undefined) updates.msg2_limit = config.msg2Limit;
    if (config.msg3Limit !== undefined) updates.msg3_limit = config.msg3Limit;
    if (config.reportNumber !== undefined) updates.report_number = config.reportNumber;
    if (config.seguimientos) {
      if (config.seguimientos.seg1 !== undefined) updates.seg1 = config.seguimientos.seg1;
      if (config.seguimientos.seg2 !== undefined) updates.seg2 = config.seguimientos.seg2;
    }
    if (Object.keys(updates).length > 0) await Bots.update(botId, updates);

    if (config.products && Array.isArray(config.products)) {
      await Products.deleteByBot(botId);
      for (const p of config.products) await Products.create(botId, p);
    }
  }

  res.json({ ok: true, message: 'Config guardada' });
});

app.get('/api/wa/sessions/:botId/config', requireAuth, requireBotOwner, async (req, res) => {
  const { botId } = req.params;
  const config = await loadBotConfigFromDB(botId);
  res.json(config || {});
});

app.post('/api/wa/sessions/:botId/start', requireAuth, requireBotOwner, async (req, res) => {
  const { botId } = req.params;
  console.log(`[API] POST /start — Bot ${botId}`);
  try {
    const session = getSession(botId);
    // Si esta atascado en 'connecting' o 'error', forzar reinicio
    if (session.status === 'connecting' || session.status === 'error') {
      console.log(`[API] Session stuck in '${session.status}', forcing restart`);
      if (session.socket) { try { session.socket.end(); } catch(e) {} session.socket = null; }
      session.status = 'disconnected';
    }
    await startSession(botId);
    await new Promise(resolve => setTimeout(resolve, 3000));
    const current = getSession(botId);
    res.json({
      status: current.status, qr: current.qr, qrDataURL: current.qrDataURL,
      phone: current.phone, lastConnected: current.lastConnected,
    });
  } catch(e) {
    console.error(`[API] Error start:`, e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/wa/sessions/:botId/status', requireAuth, requireBotOwner, (req, res) => {
  const { botId } = req.params;
  const session = getSession(botId);
  res.json({
    status: session.status, qr: session.qr, qrDataURL: session.qrDataURL,
    phone: session.phone, lastConnected: session.lastConnected, error: session.error,
  });
});

app.post('/api/wa/sessions/:botId/reconnect', requireAuth, requireBotOwner, async (req, res) => {
  const { botId } = req.params;
  console.log(`[API] POST /reconnect — Bot ${botId}`);
  try {
    const session = getSession(botId);
    if (session.socket) { try { session.socket.end(); } catch(e) {} session.socket = null; }
    session.retryCount = 0;
    session.status = 'disconnected';
    // Limpiar auth state viejo para forzar nuevo QR
    try { await WaAuthState.deleteAll(botId); } catch(e) {}
    console.log(`[API] Auth state limpiado para bot ${botId}, generando nuevo QR...`);
    await startSession(botId, true);
    await new Promise(resolve => setTimeout(resolve, 3000));
    const current = getSession(botId);
    res.json({
      status: current.status, qr: current.qr, qrDataURL: current.qrDataURL,
      phone: current.phone, lastConnected: current.lastConnected,
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/wa/sessions/:botId/disconnect', requireAuth, requireBotOwner, async (req, res) => {
  const { botId } = req.params;
  console.log(`[API] POST /disconnect — Bot ${botId}`);
  const session = getSession(botId);
  if (session.socket) {
    try { await session.socket.logout(); } catch(e) { try { session.socket.end(); } catch(e2) {} }
    session.socket = null;
  }
  try { await WaAuthState.deleteAll(botId); } catch(e) {}
  session.status = 'disconnected';
  session.qr = null; session.qrDataURL = null; session.phone = null; session.error = null; session.retryCount = 0;
  await Bots.update(botId, { wa_status: 'disconnected', wa_phone: '' });
  res.json({ status: 'disconnected', message: 'Sesion eliminada' });
});

app.post('/api/wa/sessions/:botId/send', requireAuth, requireBotOwner, async (req, res) => {
  const { botId } = req.params;
  const { phone, message } = req.body;
  const session = getSession(botId);
  if (session.status !== 'connected' || !session.socket) {
    return res.status(400).json({ error: 'WhatsApp no conectado' });
  }
  try {
    const jid = phone.replace('+', '') + '@s.whatsapp.net';
    const sentMsg = await session.socket.sendMessage(jid, { text: message });
    if (sentMsg?.key?.id && session.msgStore) {
      session.msgStore.set(sentMsg.key.id, { conversation: message });
      saveMsgStore(botId, sentMsg.key.id, { conversation: message });
    }
    res.json({ success: true, to: phone });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/wa/sessions/:botId/messages', requireAuth, requireBotOwner, (req, res) => {
  const { botId } = req.params;
  const limit = Math.min(parseInt(req.query.limit) || 50, MAX_MESSAGES);
  const since = req.query.since ? parseInt(req.query.since) : 0;
  const session = getSession(botId);
  let msgs = session.messages;
  if (since) msgs = msgs.filter(m => m.timestamp > since);
  res.json({
    messages: msgs.slice(0, limit).map(m => ({
      id: m.id, from: m.from, pushName: m.pushName, isGroup: m.isGroup,
      type: m.type, text: m.text, timestamp: m.timestamp, isBot: m.isBot || false,
    })),
    total: session.messages.length,
    unread: session.unreadCount,
  });
});

app.post('/api/wa/sessions/:botId/messages/read', requireAuth, requireBotOwner, (req, res) => {
  const { botId } = req.params;
  const session = getSession(botId);
  session.unreadCount = 0;
  res.json({ ok: true });
});

app.post('/api/wa/sessions/:botId/fix-encryption', requireAuth, requireBotOwner, async (req, res) => {
  const { botId } = req.params;
  const hasCreds = await WaAuthState.hasCreds(botId);
  if (!hasCreds) return res.status(404).json({ error: 'No hay sesion' });
  // Limpiar claves de señal (session- y sender-key-) de la DB, preservar creds
  const { pool } = require('./database');
  const { rowCount } = await pool.query(
    `DELETE FROM wa_auth_state WHERE bot_id = $1 AND (data_key LIKE 'session:%' OR data_key LIKE 'sender-key:%')`,
    [botId]
  );
  console.log(`[Bot ${botId}] Limpiadas ${rowCount} claves de señal de DB`);
  res.json({ ok: true, cleaned: rowCount });
});

app.get('/api/wa/sessions', requireAdmin, (req, res) => {
  const list = [];
  sessions.forEach((s, botId) => {
    list.push({ botId, status: s.status, phone: s.phone, lastConnected: s.lastConnected });
  });
  res.json(list);
});

// ══════════════════════════════════════════════════════════════════════════════
//  MIGRAR BOTS EXISTENTES (del sistema de archivos a DB)
// ══════════════════════════════════════════════════════════════════════════════
async function migrateExistingBots() {
  const CONFIGS_DIR = path.join(__dirname, 'bot_configs');
  if (!fs.existsSync(CONFIGS_DIR)) return;
  const files = fs.readdirSync(CONFIGS_DIR).filter(f => f.endsWith('.json'));
  const allUsers = await Users.getAll();
  const admin = allUsers.find(u => u.role === 'admin');
  if (!admin) return;

  for (const file of files) {
    const botId = file.replace('bot_', '').replace('.json', '');
    if (await Bots.findById(botId)) continue;

    try {
      const config = JSON.parse(fs.readFileSync(path.join(CONFIGS_DIR, file), 'utf8'));
      console.log(`[Migrate] Migrando bot ${botId} a base de datos...`);

      await Bots.create(admin.id, {
        id: botId,
        name: config.name || `Bot ${botId}`,
        openai_key: config.openaiKey || '',
        model: config.model || 'gpt-5.1',
        report_number: config.reportNumber || '',
        system_prompt: config.systemPrompt || '',
        msg1_limit: config.msg1Limit || 500,
        msg2_limit: config.msg2Limit || 500,
        msg3_limit: config.msg3Limit || 500,
        strict_json: config.strictJson !== false,
        seg1: config.seguimientos?.seg1 || 15,
        seg2: config.seguimientos?.seg2 || 400,
        active: true,
      });

      if (config.products && config.products.length > 0) {
        for (const p of config.products) {
          await Products.create(botId, p);
        }
      }

      console.log(`[Migrate] Bot ${botId} migrado exitosamente`);
    } catch(e) {
      console.error(`[Migrate] Error migrando bot ${botId}:`, e.message);
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════════
//  RESTAURAR SESIONES AL INICIAR
// ══════════════════════════════════════════════════════════════════════════════
async function restoreSessions() {
  // Restaurar sesiones desde la base de datos (credenciales persistidas en PostgreSQL)
  const allBots = await Bots.getAll();
  for (const bot of allBots) {
    if (!bot.active) continue;
    const hasCreds = await WaAuthState.hasCreds(bot.id);
    if (hasCreds) {
      console.log(`[Restore] Restaurando sesion bot ${bot.id} (${bot.name}) desde DB...`);
      try { await startSession(bot.id); } catch(e) {
        console.error(`[Restore] Error restaurando bot ${bot.id}:`, e.message);
      }
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════════
//  SALES API (Ventas confirmadas)
// ══════════════════════════════════════════════════════════════════════════════
app.get('/api/sales', requireAuth, async (req, res) => {
  const sales = await Sales.findByUser(req.user.id);
  res.json(sales);
});

app.get('/api/sales/:id', requireAuth, async (req, res) => {
  const sale = await Sales.findById(req.params.id);
  if (!sale) return res.status(404).json({ error: 'Venta no encontrada' });
  if (sale.user_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'No autorizado' });
  }
  res.json(sale);
});

app.put('/api/sales/:id', requireAuth, async (req, res) => {
  const sale = await Sales.findById(req.params.id);
  if (!sale) return res.status(404).json({ error: 'Venta no encontrada' });
  if (sale.user_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'No autorizado' });
  }
  const { client_name, product_name, amount, city, status, notes } = req.body;
  const updates = {};
  if (client_name !== undefined) updates.client_name = client_name;
  if (product_name !== undefined) updates.product_name = product_name;
  if (amount !== undefined) updates.amount = amount;
  if (city !== undefined) updates.city = city;
  if (status !== undefined) updates.status = status;
  if (notes !== undefined) updates.notes = notes;
  const updated = await Sales.update(req.params.id, updates);
  res.json(updated);
});

app.delete('/api/sales/:id', requireAuth, async (req, res) => {
  const sale = await Sales.findById(req.params.id);
  if (!sale) return res.status(404).json({ error: 'Venta no encontrada' });
  if (sale.user_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'No autorizado' });
  }
  await Sales.softDelete(req.params.id);
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════════════════════
//  INICIAR SERVIDOR
// ══════════════════════════════════════════════════════════════════════════════
app.listen(PORT, async () => {
  console.log('');
  console.log('==================================================');
  console.log('   WhatsApp Bot Server v3.0 — Multi-Usuario');
  console.log(`   http://localhost:${PORT}`);
  console.log('   Login: http://localhost:' + PORT + '/login');
  console.log('   Admin: usuario "admin" / admin123');
  console.log('==================================================');
  console.log('');
  console.log('[STARTUP] Verificando modulos...');
  console.log(`[STARTUP] ✅ Express: OK`);
  console.log(`[STARTUP] ✅ Baileys: OK (downloadMediaMessage: ${typeof downloadMediaMessage === 'function' ? 'SI' : 'NO'})`);
  console.log(`[STARTUP] ✅ FormData: OK (nativo: ${typeof globalThis.FormData === 'function' ? 'SI' : 'NO'})`);
  console.log(`[STARTUP] ✅ Database: Conectando a PostgreSQL...`);
  await initDatabase();
  console.log(`[STARTUP] ✅ Database: OK (PostgreSQL/Supabase)`);
  const allUsers = await Users.getAll();
  const allBots = await Bots.getAll();
  console.log(`[STARTUP] ✅ Usuarios en DB: ${allUsers.length}`);
  console.log(`[STARTUP] ✅ Bots en DB: ${allBots.length}`);
  for (const b of allBots) {
    const prods = await Products.findByBot(b.id);
    console.log(`[STARTUP]    Bot "${b.name}" (${b.id}) | Activo: ${b.active ? 'SI' : 'NO'} | Productos: ${prods.length} | API Key: ${b.openai_key ? 'SI' : 'NO'} | Reporte: ${b.report_number || 'N/A'}`);
  }
  console.log('[STARTUP] Almacenamiento:');
  console.log(`[STARTUP]   Sessions WA: PostgreSQL (persistente)`);
  console.log(`[STARTUP]   MsgStores: PostgreSQL (persistente)`);
  console.log(`[STARTUP]   Archivos: Supabase Storage (persistente)`);

  await migrateExistingBots();
  await restoreSessions();
});

// ══════════════════════════════════════════════════════════════════════════════
//  PROTECCION CONTRA CRASHES — Capturar errores no manejados
// ══════════════════════════════════════════════════════════════════════════════
process.on('uncaughtException', (err) => {
  console.error(`[CRASH PREVENIDO] uncaughtException: ${err.message}`);
  if (err.stack) console.error(err.stack);
});

process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  console.error(`[CRASH PREVENIDO] unhandledRejection: ${msg}`);
});
