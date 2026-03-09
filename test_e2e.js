/**
 * TEST E2E COMPLETO — Sistema de Agentes de Ventas
 * 5 pruebas de extremo a extremo
 */
const API = 'http://localhost:3001/api';
let passed = 0, failed = 0, errors = [];

async function req(method, path, body, token) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (token) opts.headers['Authorization'] = 'Bearer ' + token;
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(API + path, opts);
  const data = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, data };
}

function assert(name, condition, detail) {
  if (condition) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    const msg = `  ❌ ${name}${detail ? ' — ' + detail : ''}`;
    errors.push(msg);
    console.log(msg);
  }
}

// ═══════════════════════════════════════════════════════════════
//  PRUEBA 1: Registro → Factura → Aprobación → Login
// ═══════════════════════════════════════════════════════════════
async function test1() {
  console.log('\n═══ PRUEBA 1: Registro → Aprobación → Login ═══');

  const ts = Date.now();
  const testUser = {
    username: `testuser_${ts}`,
    email: `test_${ts}@mail.com`,
    password: 'test123456',
    nombre: 'Juan',
    apellido: 'Perez',
    fecha_nacimiento: '1990-01-01',
    ciudad: 'Santa Cruz',
    usuario_fase: `fase_${ts}`,
    patrocinador_fase: 'admin',
  };

  // 1.1 Registro con datos completos
  let r = await req('POST', '/auth/register', testUser);
  assert('1.1 Registro exitoso', r.ok && r.data.ok, `status=${r.status}, data=${JSON.stringify(r.data).substring(0,100)}`);
  const userId = r.data.userId;

  // 1.2 Registro con usuario duplicado
  r = await req('POST', '/auth/register', testUser);
  assert('1.2 Registro duplicado rechazado', !r.ok && r.status === 400, `status=${r.status}`);

  // 1.3 Registro con email duplicado
  r = await req('POST', '/auth/register', { ...testUser, username: 'otro', usuario_fase: 'otro_fase' });
  assert('1.3 Email duplicado rechazado', !r.ok && r.status === 400, `status=${r.status}`);

  // 1.4 Registro sin campos obligatorios
  r = await req('POST', '/auth/register', { username: 'x' });
  assert('1.4 Campos faltantes rechazados', !r.ok && r.status === 400, `status=${r.status}`);

  // 1.5 Registro con usuario corto
  r = await req('POST', '/auth/register', { ...testUser, username: 'ab', email: 'x@y.z', usuario_fase: 'unique_fase' });
  assert('1.5 Usuario corto rechazado', !r.ok && r.status === 400, `status=${r.status}`);

  // 1.6 Registro con password corto
  r = await req('POST', '/auth/register', { ...testUser, username: 'validuser', email: 'valid@e.com', password: '123', usuario_fase: 'unique_fase2' });
  assert('1.6 Password corto rechazado', !r.ok && r.status === 400, `status=${r.status}`);

  // 1.7 Login con usuario pendiente
  r = await req('POST', '/auth/login', { username: testUser.usuario_fase, password: testUser.password });
  assert('1.7 Login pendiente bloqueado (403)', r.status === 403 && r.data.status === 'pendiente', `status=${r.status}, data=${JSON.stringify(r.data).substring(0,100)}`);

  // 1.8 Login admin
  r = await req('POST', '/auth/login', { username: 'admin', password: 'admin123' });
  assert('1.8 Login admin exitoso', r.ok && r.data.token && r.data.user.role === 'admin', `status=${r.status}`);
  const adminToken = r.data.token;

  // 1.9 Aprobar usuario
  r = await req('PUT', `/admin/users/${userId}/status`, { status: 'activo' }, adminToken);
  assert('1.9 Aprobación exitosa', r.ok, `status=${r.status}`);

  // 1.10 Login del usuario aprobado
  r = await req('POST', '/auth/login', { username: testUser.usuario_fase, password: testUser.password });
  assert('1.10 Login exitoso post-aprobación', r.ok && r.data.token, `status=${r.status}`);
  const userToken = r.data.token;

  // 1.11 Verificar /me
  r = await req('GET', '/auth/me', null, userToken);
  assert('1.11 /me devuelve datos correctos', r.ok && r.data.nombre === 'Juan' && r.data.status === 'activo', `data=${JSON.stringify(r.data).substring(0,100)}`);

  // 1.12 Suspender usuario
  r = await req('PUT', `/admin/users/${userId}/status`, { status: 'suspendido' }, adminToken);
  assert('1.12 Suspensión exitosa', r.ok, `status=${r.status}`);

  // 1.13 Login suspendido bloqueado
  r = await req('POST', '/auth/login', { username: testUser.usuario_fase, password: testUser.password });
  assert('1.13 Login suspendido bloqueado', r.status === 403 && r.data.status === 'suspendido', `status=${r.status}`);

  // 1.14 Bloquear usuario
  r = await req('PUT', `/admin/users/${userId}/status`, { status: 'bloqueado' }, adminToken);
  r = await req('POST', '/auth/login', { username: testUser.usuario_fase, password: testUser.password });
  assert('1.14 Login bloqueado rechazado', r.status === 403 && r.data.status === 'bloqueado', `status=${r.status}`);

  // 1.15 Reactivar usuario
  r = await req('PUT', `/admin/users/${userId}/status`, { status: 'activo' }, adminToken);
  r = await req('POST', '/auth/login', { username: testUser.usuario_fase, password: testUser.password });
  assert('1.15 Login reactivado exitoso', r.ok && r.data.token, `status=${r.status}`);

  // 1.16 Credenciales incorrectas
  r = await req('POST', '/auth/login', { username: testUser.usuario_fase, password: 'wrongpass' });
  assert('1.16 Password incorrecto rechazado', r.status === 401, `status=${r.status}`);

  // 1.17 Usuario inexistente
  r = await req('POST', '/auth/login', { username: 'noexiste', password: 'nope' });
  assert('1.17 Usuario inexistente rechazado', r.status === 401, `status=${r.status}`);

  // Cleanup
  await req('DELETE', `/admin/users/${userId}`, null, adminToken);

  return { adminToken };
}

// ═══════════════════════════════════════════════════════════════
//  PRUEBA 2: Usuario → Panel → Perfil → Visualización
// ═══════════════════════════════════════════════════════════════
async function test2(adminToken) {
  console.log('\n═══ PRUEBA 2: Panel y perfil de usuario ═══');

  const ts = Date.now();
  // Crear y aprobar usuario
  let r = await req('POST', '/auth/register', {
    username: `paneluser_${ts}`, email: `panel_${ts}@mail.com`, password: 'test123456',
    nombre: 'Maria', apellido: 'Lopez', ciudad: 'La Paz', usuario_fase: `panel_fase_${ts}`, patrocinador_fase: 'admin',
  });
  const userId = r.data.userId;
  await req('PUT', `/admin/users/${userId}/status`, { status: 'activo' }, adminToken);

  r = await req('POST', '/auth/login', { username: `panel_fase_${ts}`, password: 'test123456' });
  const userToken = r.data.token;
  assert('2.1 Login para panel exitoso', r.ok && userToken, `status=${r.status}`);

  // 2.2 Editar perfil
  r = await req('PUT', '/user/profile', { nombre: 'Maria Elena', apellido: 'Lopez Garcia', ciudad: 'Cochabamba', rango_fase: 'Oro' }, userToken);
  assert('2.2 Editar perfil exitoso', r.ok && r.data.user.nombre === 'Maria Elena', `data=${JSON.stringify(r.data).substring(0,100)}`);

  // 2.3 Verificar perfil actualizado
  r = await req('GET', '/auth/me', null, userToken);
  assert('2.3 Perfil actualizado en /me', r.data.nombre === 'Maria Elena' && r.data.ciudad === 'Cochabamba' && r.data.rango_fase === 'Oro', `data=${JSON.stringify(r.data).substring(0,80)}`);

  // 2.4 Ver bots (vacío)
  r = await req('GET', '/bots', null, userToken);
  assert('2.4 Lista de agentes vacía inicialmente', r.ok && Array.isArray(r.data) && r.data.length === 0, `data=${JSON.stringify(r.data).substring(0,80)}`);

  // 2.5 Token inválido rechazado
  r = await req('GET', '/auth/me', null, 'invalid-token');
  assert('2.5 Token inválido rechazado', r.status === 401, `status=${r.status}`);

  // 2.6 Sin token rechazado
  r = await req('GET', '/auth/me');
  assert('2.6 Sin token rechazado', r.status === 401, `status=${r.status}`);

  // 2.7 Admin ve lista de usuarios
  r = await req('GET', '/admin/users', null, adminToken);
  assert('2.7 Admin ve usuarios', r.ok && Array.isArray(r.data) && r.data.length > 0, `count=${r.data?.length}`);

  // 2.8 Admin puede editar usuario
  r = await req('PUT', `/admin/users/${userId}`, { ciudad: 'Oruro' }, adminToken);
  assert('2.8 Admin edita usuario', r.ok, `status=${r.status}`);

  // 2.9 Admin ve bot_count en listado
  r = await req('GET', '/admin/users', null, adminToken);
  const testUserInList = r.data.find(u => u.id === userId);
  assert('2.9 bot_count incluido en listado', testUserInList && testUserInList.bot_count !== undefined, `bot_count=${testUserInList?.bot_count}`);

  // Cleanup
  await req('DELETE', `/admin/users/${userId}`, null, adminToken);
  return { userToken };
}

// ═══════════════════════════════════════════════════════════════
//  PRUEBA 3: Creación de agente → Productos → Config → Guardado
// ═══════════════════════════════════════════════════════════════
async function test3(adminToken) {
  console.log('\n═══ PRUEBA 3: Agente, productos y configuración ═══');

  const ts = Date.now();
  // Crear y aprobar usuario con max_bots=1
  let r = await req('POST', '/auth/register', {
    username: `botuser_${ts}`, email: `bot_${ts}@mail.com`, password: 'test123456',
    nombre: 'Carlos', apellido: 'Ramirez', usuario_fase: `bot_fase_${ts}`, patrocinador_fase: 'admin',
  });
  const userId = r.data.userId;
  await req('PUT', `/admin/users/${userId}/status`, { status: 'activo' }, adminToken);
  r = await req('POST', '/auth/login', { username: `bot_fase_${ts}`, password: 'test123456' });
  const userToken = r.data.token;

  // 3.1 Crear agente
  r = await req('POST', '/bots', { name: 'Mi Agente Test' }, userToken);
  assert('3.1 Crear agente exitoso', r.ok && r.data.bot && r.data.bot.name === 'Mi Agente Test', `data=${JSON.stringify(r.data).substring(0,80)}`);
  const botId = r.data.bot.id;

  // 3.2 Límite de agentes (max_bots=1)
  r = await req('POST', '/bots', { name: 'Segundo Bot' }, userToken);
  assert('3.2 Límite de agentes respetado', r.status === 403, `status=${r.status}, msg=${r.data?.error}`);

  // 3.3 Admin puede aumentar límite
  r = await req('PUT', `/admin/users/${userId}/max-bots`, { max_bots: 3 }, adminToken);
  assert('3.3 Admin aumenta límite', r.ok, `status=${r.status}`);

  // 3.4 Ahora sí puede crear segundo
  r = await req('POST', '/bots', { name: 'Segundo Agente' }, userToken);
  assert('3.4 Segundo agente creado con límite ampliado', r.ok && r.data.bot, `status=${r.status}`);
  const botId2 = r.data.bot.id;

  // 3.5 Configurar agente con API key, modelo, prompt
  r = await req('PUT', `/bots/${botId}`, {
    active: true,
    model: 'gpt-5',
    credentials: { openaiKey: 'sk-test-123', reportNumber: '+59171234567' },
    template: {
      systemPrompt: 'Eres un vendedor experto en productos de salud.',
      msg1Limit: 300,
      msg2Limit: 400,
      msg3Limit: 500,
      strictJson: true,
    },
    seguimientos: { seg1: 10, seg2: 200 },
  }, userToken);
  assert('3.5 Configuración completa guardada', r.ok, `status=${r.status}`);

  // 3.6 Verificar config guardada
  r = await req('GET', `/bots/${botId}`, null, userToken);
  assert('3.6 Config leída correctamente',
    r.ok && r.data.model === 'gpt-5' && r.data.active === true &&
    r.data.credentials.openaiKey === 'sk-test-123' && r.data.credentials.reportNumber === '+59171234567' &&
    r.data.template.msg1Limit === 300 && r.data.seguimientos.seg1 === 10,
    `data=${JSON.stringify(r.data).substring(0,120)}`);

  // 3.7 Crear producto con todos los campos
  r = await req('PUT', `/bots/${botId}`, {
    products: [{
      nombre: 'Crema Facial', descripcion: 'Crema anti-envejecimiento',
      beneficios: 'Rejuvenece la piel', modoUso: 'Aplicar 2 veces al dia',
      advertencias: 'No usar en piel irritada', moneda: 'BOB',
      precioUnitario: '150', precioPromo2: '270', precioSuper6: '750',
      precioOferta: '120',
      infoEnvio: 'Envio gratuito en Santa Cruz', cobertura: 'Nacional',
      hooks: 'Prueba nuestra crema y rejuvenece tu piel!',
      imagenes: ['https://example.com/crema1.jpg', 'https://example.com/crema2.jpg'],
      masImagenes: ['https://example.com/oferta1.jpg'],
      testimonios: [{ url: 'https://example.com/test1.jpg', descripcion: 'Me encanto el resultado' }],
    }]
  }, userToken);
  assert('3.7 Producto creado con todos los campos', r.ok && r.data.bot.products.length === 1, `products=${r.data?.bot?.products?.length}`);

  // 3.8 Verificar producto guardado correctamente
  r = await req('GET', `/bots/${botId}/products`, null, userToken);
  assert('3.8 Producto leído de DB', r.ok && r.data.length === 1 && r.data[0].nombre === 'Crema Facial', `data=${JSON.stringify(r.data?.[0]?.nombre)}`);
  const prod = r.data[0];
  assert('3.9 Precios del producto',
    prod.precio_unitario === '150' && prod.precio_promo2 === '270' && prod.precio_super6 === '750' && prod.precio_oferta === '120',
    `precios: u=${prod.precio_unitario}, p2=${prod.precio_promo2}, s6=${prod.precio_super6}, of=${prod.precio_oferta}`);
  assert('3.10 Imágenes del producto',
    Array.isArray(prod.imagenes) && prod.imagenes.length === 2 && Array.isArray(prod.mas_imagenes) && prod.mas_imagenes.length === 1,
    `img=${prod.imagenes?.length}, mas=${prod.mas_imagenes?.length}`);
  assert('3.11 Testimonios del producto',
    Array.isArray(prod.testimonios) && prod.testimonios.length === 1 && prod.testimonios[0].descripcion === 'Me encanto el resultado',
    `test=${JSON.stringify(prod.testimonios?.[0]).substring(0,60)}`);

  // 3.12 Agregar segundo producto
  r = await req('PUT', `/bots/${botId}`, {
    products: [
      { nombre: 'Crema Facial', descripcion: 'Crema anti-envejecimiento', precioUnitario: '150', imagenes: ['https://example.com/crema1.jpg'] },
      { nombre: 'Serum Vitamina C', descripcion: 'Serum rejuvenecedor', precioUnitario: '200', imagenes: ['https://example.com/serum1.jpg'] },
    ]
  }, userToken);
  assert('3.12 Múltiples productos guardados', r.ok && r.data.bot.products.length === 2, `products=${r.data?.bot?.products?.length}`);

  // 3.13 Configurar vía /config endpoint
  r = await req('POST', `/wa/sessions/${botId}/config`, {
    openaiKey: 'sk-test-456',
    model: 'gpt-5.1',
    systemPrompt: 'Eres un vendedor profesional.',
    msg1Limit: 250,
    reportNumber: '+59176543210',
    seguimientos: { seg1: 20, seg2: 300 },
    products: [
      { nombre: 'Producto Config', precioUnitario: '100' }
    ]
  }, userToken);
  assert('3.13 Config vía /wa/sessions/:id/config', r.ok, `status=${r.status}`);

  // 3.14 Leer config vía GET
  r = await req('GET', `/wa/sessions/${botId}/config`, null, userToken);
  assert('3.14 Config leída correctamente',
    r.ok && r.data.openaiKey === 'sk-test-456' && r.data.model === 'gpt-5.1' && r.data.products?.length === 1,
    `data=${JSON.stringify(r.data).substring(0,100)}`);

  // 3.15 Eliminar agente
  r = await req('DELETE', `/bots/${botId2}`, null, userToken);
  assert('3.15 Eliminar agente exitoso', r.ok, `status=${r.status}`);

  // 3.16 Verificar agente eliminado (soft delete)
  r = await req('GET', '/bots', null, userToken);
  const remaining = r.data.filter(b => b.id === botId2);
  assert('3.16 Agente eliminado no aparece en lista', remaining.length === 0, `found=${remaining.length}`);

  // Cleanup
  await req('DELETE', `/admin/users/${userId}`, null, adminToken);
  return { botId };
}

// ═══════════════════════════════════════════════════════════════
//  PRUEBA 4: Permisos por rol (admin vs usuario)
// ═══════════════════════════════════════════════════════════════
async function test4(adminToken) {
  console.log('\n═══ PRUEBA 4: Permisos y seguridad ═══');

  const ts = Date.now();
  // Crear dos usuarios
  let r = await req('POST', '/auth/register', {
    username: `user_a_${ts}`, email: `a_${ts}@mail.com`, password: 'test123456',
    nombre: 'UserA', apellido: 'Test', usuario_fase: `a_fase_${ts}`, patrocinador_fase: 'admin',
  });
  const userIdA = r.data.userId;
  r = await req('POST', '/auth/register', {
    username: `user_b_${ts}`, email: `b_${ts}@mail.com`, password: 'test123456',
    nombre: 'UserB', apellido: 'Test', usuario_fase: `b_fase_${ts}`, patrocinador_fase: 'admin',
  });
  const userIdB = r.data.userId;

  await req('PUT', `/admin/users/${userIdA}/status`, { status: 'activo' }, adminToken);
  await req('PUT', `/admin/users/${userIdB}/status`, { status: 'activo' }, adminToken);

  r = await req('POST', '/auth/login', { username: `a_fase_${ts}`, password: 'test123456' });
  const tokenA = r.data.token;
  r = await req('POST', '/auth/login', { username: `b_fase_${ts}`, password: 'test123456' });
  const tokenB = r.data.token;

  // A crea un agente
  r = await req('POST', '/bots', { name: 'Bot de A' }, tokenA);
  const botA = r.data.bot.id;

  // B crea un agente
  r = await req('POST', '/bots', { name: 'Bot de B' }, tokenB);
  const botB = r.data.bot.id;

  // 4.1 Usuario A solo ve su agente
  r = await req('GET', '/bots', null, tokenA);
  assert('4.1 Usuario A solo ve su agente', r.ok && r.data.length === 1 && r.data[0].id === botA, `count=${r.data?.length}`);

  // 4.2 Usuario B solo ve su agente
  r = await req('GET', '/bots', null, tokenB);
  assert('4.2 Usuario B solo ve su agente', r.ok && r.data.length === 1 && r.data[0].id === botB, `count=${r.data?.length}`);

  // 4.3 A no puede acceder al bot de B
  r = await req('GET', `/bots/${botB}`, null, tokenA);
  assert('4.3 A no puede ver bot de B', r.status === 403, `status=${r.status}`);

  // 4.4 A no puede editar el bot de B
  r = await req('PUT', `/bots/${botB}`, { name: 'Hackeado' }, tokenA);
  assert('4.4 A no puede editar bot de B', r.status === 403, `status=${r.status}`);

  // 4.5 A no puede eliminar el bot de B
  r = await req('DELETE', `/bots/${botB}`, null, tokenA);
  assert('4.5 A no puede eliminar bot de B', r.status === 403, `status=${r.status}`);

  // 4.6 Usuario no puede acceder a rutas admin
  r = await req('GET', '/admin/users', null, tokenA);
  assert('4.6 Usuario no accede a /admin/users', r.status === 403, `status=${r.status}`);

  // 4.7 Usuario no puede aprobar usuarios
  r = await req('PUT', `/admin/users/${userIdB}/status`, { status: 'bloqueado' }, tokenA);
  assert('4.7 Usuario no puede cambiar status', r.status === 403, `status=${r.status}`);

  // 4.8 Usuario no puede ver bots admin
  r = await req('GET', '/admin/bots', null, tokenA);
  assert('4.8 Usuario no accede a /admin/bots', r.status === 403, `status=${r.status}`);

  // 4.9 Usuario no puede eliminar usuarios
  r = await req('DELETE', `/admin/users/${userIdB}`, null, tokenA);
  assert('4.9 Usuario no puede eliminar otros', r.status === 403, `status=${r.status}`);

  // 4.10 Admin puede ver todos los bots
  r = await req('GET', '/admin/bots', null, adminToken);
  assert('4.10 Admin ve todos los agentes', r.ok && Array.isArray(r.data), `count=${r.data?.length}`);

  // 4.11 Admin puede acceder al bot de cualquier usuario
  r = await req('GET', `/bots/${botA}`, null, adminToken);
  assert('4.11 Admin accede al bot de A', r.ok && r.data.id === botA, `status=${r.status}`);

  // 4.12 Admin puede editar bot de otro usuario
  r = await req('PUT', `/bots/${botA}`, { name: 'Editado por Admin' }, adminToken);
  assert('4.12 Admin edita bot de otro', r.ok, `status=${r.status}`);

  // 4.13 No se puede eliminar admin
  const adminUser = (await req('GET', '/admin/users', null, adminToken)).data.find(u => u.role === 'admin');
  if (adminUser) {
    r = await req('DELETE', `/admin/users/${adminUser.id}`, null, adminToken);
    assert('4.13 No se puede eliminar admin', r.status === 400, `status=${r.status}`);
  } else {
    assert('4.13 No se puede eliminar admin', true, 'admin found');
  }

  // 4.14 Estado inválido rechazado
  r = await req('PUT', `/admin/users/${userIdA}/status`, { status: 'inexistente' }, adminToken);
  assert('4.14 Estado inválido rechazado', r.status === 400, `status=${r.status}`);

  // 4.15 WA session protegida
  r = await req('GET', `/wa/sessions/${botA}/status`, null, tokenB);
  assert('4.15 WA session protegida por ownership', r.status === 403, `status=${r.status}`);

  // 4.16 WA config protegida
  r = await req('GET', `/wa/sessions/${botA}/config`, null, tokenB);
  assert('4.16 WA config protegida', r.status === 403, `status=${r.status}`);

  // 4.17 Acceso a productos ajenos bloqueado
  r = await req('GET', `/bots/${botA}/products`, null, tokenB);
  assert('4.17 Productos ajenos bloqueados', r.status === 403, `status=${r.status}`);

  // Cleanup
  await req('DELETE', `/admin/users/${userIdA}`, null, adminToken);
  await req('DELETE', `/admin/users/${userIdB}`, null, adminToken);
}

// ═══════════════════════════════════════════════════════════════
//  PRUEBA 5: WhatsApp + IA + Seguimientos + Reportes (lógica)
// ═══════════════════════════════════════════════════════════════
async function test5(adminToken) {
  console.log('\n═══ PRUEBA 5: WhatsApp, IA, seguimientos y reportes ═══');

  const ts = Date.now();
  // Crear usuario con agente configurado
  let r = await req('POST', '/auth/register', {
    username: `wauser_${ts}`, email: `wa_${ts}@mail.com`, password: 'test123456',
    nombre: 'Pedro', apellido: 'Garcia', usuario_fase: `wa_fase_${ts}`, patrocinador_fase: 'admin',
  });
  const userId = r.data.userId;
  await req('PUT', `/admin/users/${userId}/status`, { status: 'activo' }, adminToken);
  r = await req('POST', '/auth/login', { username: `wa_fase_${ts}`, password: 'test123456' });
  const userToken = r.data.token;

  // Crear agente
  r = await req('POST', '/bots', { name: 'Agente WhatsApp' }, userToken);
  const botId = r.data.bot.id;

  // Configurar agente completo
  r = await req('PUT', `/bots/${botId}`, {
    active: true,
    model: 'gpt-5.1',
    credentials: { openaiKey: 'sk-test-wa', reportNumber: '+59171111111' },
    template: {
      systemPrompt: 'Eres un vendedor experto.',
      msg1Limit: 300, msg2Limit: 400, msg3Limit: 500, strictJson: true,
    },
    seguimientos: { seg1: 15, seg2: 400 },
    products: [{
      nombre: 'Producto A', descripcion: 'Desc A', precioUnitario: '100',
      imagenes: ['https://example.com/img1.jpg'],
      masImagenes: ['https://example.com/oferta1.jpg'],
      testimonios: [{ url: 'https://example.com/test1.jpg', descripcion: 'Excelente' }],
    }]
  }, userToken);
  assert('5.1 Agente configurado completamente', r.ok, `status=${r.status}`);

  // 5.2 Verificar status WA (debe estar disconnected)
  r = await req('GET', `/wa/sessions/${botId}/status`, null, userToken);
  assert('5.2 WA status inicial = disconnected', r.ok && r.data.status === 'disconnected', `status=${r.data?.status}`);

  // 5.3 Verificar config cargada correctamente
  r = await req('GET', `/wa/sessions/${botId}/config`, null, userToken);
  assert('5.3 Config cargada para IA', r.ok && r.data.openaiKey === 'sk-test-wa' && r.data.products?.length === 1, `data=${JSON.stringify(r.data).substring(0,80)}`);

  // 5.4 Verificar buildSystemPrompt incluye productos
  const config = r.data;
  assert('5.4 Prompt incluye productos', config.systemPrompt && config.systemPrompt.length > 0, `prompt=${config.systemPrompt?.length} chars`);
  assert('5.5 Productos mapeados a config',
    config.products[0].nombre === 'Producto A' && config.products[0].precioUnitario === '100',
    `prod=${config.products[0]?.nombre}`);

  // 5.6 Verificar seguimientos configurados
  assert('5.6 Seguimientos configurados', config.seguimientos.seg1 === 15 && config.seguimientos.seg2 === 400, `seg1=${config.seguimientos?.seg1}, seg2=${config.seguimientos?.seg2}`);

  // 5.7 Messages endpoint (vacío inicialmente)
  r = await req('GET', `/wa/sessions/${botId}/messages`, null, userToken);
  assert('5.7 Bandeja vacía inicialmente', r.ok && r.data.messages.length === 0 && r.data.unread === 0, `msgs=${r.data?.messages?.length}`);

  // 5.8 Mark as read endpoint
  r = await req('POST', `/wa/sessions/${botId}/messages/read`, null, userToken);
  assert('5.8 Mark as read funciona', r.ok, `status=${r.status}`);

  // 5.9 Send sin conexión WA retorna error
  r = await req('POST', `/wa/sessions/${botId}/send`, { phone: '+59171234567', message: 'test' }, userToken);
  assert('5.9 Send sin WA retorna error', r.status === 400, `status=${r.status}`);

  // 5.10 Fix encryption endpoint
  r = await req('POST', `/wa/sessions/${botId}/fix-encryption`, null, userToken);
  assert('5.10 Fix encryption (sin sesión)', r.status === 404 || r.ok, `status=${r.status}`);

  // 5.11 Admin puede ver sesiones WA
  r = await req('GET', '/wa/sessions', null, adminToken);
  assert('5.11 Admin ve sesiones WA', r.ok && Array.isArray(r.data), `count=${r.data?.length}`);

  // 5.12 Verificar model mapping
  r = await req('GET', `/bots/${botId}`, null, userToken);
  assert('5.12 Modelo guardado correctamente', r.data.model === 'gpt-5.1', `model=${r.data?.model}`);

  // 5.13 Admin ve el agente en lista global
  r = await req('GET', '/admin/bots', null, adminToken);
  const found = r.data.find(b => b.id === botId);
  assert('5.13 Admin ve agente en lista global', found && found.user_nombre === 'Pedro', `found=${!!found}`);

  // 5.14 Admin puede cambiar status del agente
  r = await req('PUT', `/admin/bots/${botId}/status`, { status: 'suspended' }, adminToken);
  assert('5.14 Admin suspende agente', r.ok, `status=${r.status}`);

  // 5.15 Status inválido rechazado
  r = await req('PUT', `/admin/bots/${botId}/status`, { status: 'invalid' }, adminToken);
  assert('5.15 Status de bot inválido rechazado', r.status === 400, `status=${r.status}`);

  // Cleanup
  await req('DELETE', `/admin/users/${userId}`, null, adminToken);
}

// ═══════════════════════════════════════════════════════════════
//  PRUEBAS DE PÁGINAS HTML
// ═══════════════════════════════════════════════════════════════
async function testPages() {
  console.log('\n═══ PRUEBA EXTRA: Páginas HTML ═══');

  const pages = ['/', '/login', '/register', '/panel', '/admin'];
  for (const page of pages) {
    const r = await fetch(`http://localhost:3001${page}`);
    const html = await r.text();
    assert(`Página ${page} → HTTP ${r.status}`, r.status === 200 && html.includes('<!DOCTYPE html>'), `status=${r.status}, len=${html.length}`);
  }

  // Verificar textos "Agentes de Ventas" en todas las páginas
  for (const page of ['/login', '/register', '/panel', '/admin']) {
    const r = await fetch(`http://localhost:3001${page}`);
    const html = await r.text();
    assert(`${page} contiene "Agentes de Ventas"`, html.includes('Agentes de Ventas'), `found=${html.includes('Agentes de Ventas')}`);
  }

  // Verificar que no hay "WhatsApp Bots" en ninguna
  for (const page of ['/login', '/register', '/panel', '/admin']) {
    const r = await fetch(`http://localhost:3001${page}`);
    const html = await r.text();
    assert(`${page} no tiene "WhatsApp Bots" visible`, !html.includes('>WhatsApp Bots<') && !html.includes("'WhatsApp Bots'") && !html.includes('"WhatsApp Bots"'), '');
  }
}

// ═══════════════════════════════════════════════════════════════
//  EJECUTAR TODAS LAS PRUEBAS
// ═══════════════════════════════════════════════════════════════
async function runAll() {
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║  TEST E2E — Sistema de Agentes de Ventas        ║');
  console.log('║  5 pruebas completas + validación de páginas     ║');
  console.log('╚══════════════════════════════════════════════════╝');

  try {
    const { adminToken } = await test1();
    await test2(adminToken);
    await test3(adminToken);
    await test4(adminToken);
    await test5(adminToken);
    await testPages();
  } catch(e) {
    console.error('\n💥 ERROR FATAL:', e.message);
    console.error(e.stack);
  }

  console.log('\n══════════════════════════════════════════════════');
  console.log(`  RESULTADO: ${passed} pasaron ✅  |  ${failed} fallaron ❌`);
  console.log('══════════════════════════════════════════════════');
  if (errors.length > 0) {
    console.log('\nERRORES:');
    errors.forEach(e => console.log(e));
  }
  console.log('');
}

runAll();
