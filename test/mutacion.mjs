// Prueba de mutación: saca (o afloja) cada línea que protege algo, en el SQL
// o en el index.html, y verifica que el test que la cuida se dé cuenta. Si una
// mutación "sobrevive", ese test no sirve.
//
//   npm run mutacion                     todas
//   npm run mutacion -- vincular         solo las que tengan "vincular" en el nombre
//   npm run mutacion -- --retomar        sigue una corrida cortada: saltea las que
//                                        ya quedaron atrapadas en .mutacion.log
//
// Van de a una a propósito: en paralelo la compu se queda sin memoria (PGlite y
// el navegador) y los tests fallan por eso, no por la mutación.
//
// Cada resultado se anota en .mutacion.log apenas termina, así una corrida
// cortada (se apagó la compu, se cerró la sesión) se retoma sin repetir.
//
// Para que una mutación cuente como atrapada no alcanza con que "algo falle":
// · el texto a mutar tiene que aparecer UNA sola vez entre todas las
//   migraciones, o en el index.html o el sw.js (si el código cambió y ya no
//   está, se avisa en vez de pasar en silencio);
// · el SQL mutado tiene que cargar (si no carga, fallaría todo y no probaría
//   nada);
// · y entre los tests que fallan tiene que estar el de "espera".
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { archivosMigracion } from './db.mjs';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');

// Del SQL se muta la migración que tenga el texto (las demás corren tal cual,
// ver db.mjs); las de la VERIFICACIÓN, la última. De la página, el
// index.html y el sw.js (los sirve test/navegador.mjs).
// Con fin de línea normal: git en Windows puede dejar los archivos con CRLF y
// los textos a buscar están con \n.
const leerNormal = (ruta) => readFileSync(ruta, 'utf8').replace(/\r\n/g, '\n');
const MIGRACIONES = archivosMigracion().map((ruta) => ({ ruta, variable: 'EXPO_SQL', original: leerNormal(ruta) }));
const PAGINA = {
  index: { ruta: join(RAIZ, 'index.html'), variable: 'EXPO_INDEX' },
  sw: { ruta: join(RAIZ, 'sw.js'), variable: 'EXPO_SW' },
};
for (const a of Object.values(PAGINA)) a.original = leerNormal(a.ruta);

const veces = (texto, buscar) => texto.split(buscar).length - 1;

// Dónde se aplica la mutación: el archivo donde el texto aparece una sola vez.
function dondeMutar(m) {
  if (m.archivo === 'index' || m.archivo === 'sw') {
    const a = PAGINA[m.archivo];
    return veces(a.original, m.buscar) === 1 ? a : `${veces(a.original, m.buscar)} veces en ${basename(a.ruta)}`;
  }
  const candidatas = m.verificacion ? MIGRACIONES.slice(-1) : MIGRACIONES;
  const total = candidatas.reduce((n, a) => n + veces(a.original, m.buscar), 0);
  return total === 1 ? candidatas.find((a) => veces(a.original, m.buscar) === 1)
    : `${total} veces en ${candidatas.map((a) => basename(a.ruta)).join(' y ')}`;
}

const MUTACIONES = [
  // ── seguridad
  { nombre: 'seguridad: no sacarle las tablas al anónimo', prueba: 'seguridad',
    espera: 'el anónimo no puede leer ninguna tabla',
    buscar: `execute format('revoke all on public.%I from anon', t);`, poner: '' },
  { nombre: 'seguridad: no prender el RLS', prueba: 'seguridad',
    espera: 'un usuario logueado que no es admin no ve ni toca nada',
    buscar: `execute format('alter table public.%I enable row level security', t);`, poner: '' },
  { nombre: 'seguridad: política abierta a cualquier logueado', prueba: 'seguridad',
    espera: 'un usuario logueado que no es admin no ve ni toca nada',
    buscar: `using (public.es_admin()) with check (public.es_admin())`, poner: `using (true) with check (true)` },
  { nombre: 'seguridad: recepción puede vaciar tablas con TRUNCATE', prueba: 'seguridad',
    espera: 'nadie logueado puede vaciar una tabla con TRUNCATE',
    buscar: `    execute format('revoke truncate, references, trigger on public.%I from authenticated', t);`, poner: '' },
  { nombre: 'seguridad: no sacarle las funciones al anónimo', prueba: 'seguridad',
    espera: 'el anónimo solo puede ejecutar las funciones públicas',
    buscar: `execute format('revoke all on function %s from public, anon, authenticated', f);`, poner: '' },
  { nombre: 'seguridad: la verificación no frena por funciones de más', prueba: 'seguridad', verificacion: true,
    espera: 'la verificación de la migración frena',
    buscar: `    raise exception 'VERIFICACIÓN: el anónimo puede ejecutar funciones que no son públicas: %', hay;`, poner: '' },
  { nombre: 'seguridad: la verificación no mira todos los permisos de las tablas', prueba: 'seguridad', verificacion: true,
    espera: 'la verificación de la migración frena',
    buscar: `'select, insert, update, delete, truncate, references, trigger'`, poner: `'select'` },
  { nombre: 'seguridad: vincular sin chequear es_admin', prueba: 'seguridad',
    espera: 'vincular, marcar y cambiar la clave: solo recepción',
    buscar: `  if not public.es_admin() then
    raise exception 'expo_solo_admin';
  end if;

  select * into a from`, poner: `  select * into a from` },
  { nombre: 'seguridad: ver_invitado devuelve el vendedor siempre', prueba: 'seguridad',
    espera: 'ver_invitado devuelve solo lo que muestra la pantalla',
    buscar: `'localidad',    i.localidad));`, poner: `'localidad',    i.localidad, 'vendedor', i.vendedor));` },
  { nombre: 'seguridad: la clave del equipo se guarda tal cual', prueba: 'seguridad',
    espera: 'las claves del equipo y del cartel no se guardan',
    buscar: `  select encode(sha256(convert_to(clave, 'UTF8')), 'hex')`, poner: `  select clave` },

  // ── visitas
  { nombre: 'visitas: registrar dos veces el mismo día falla en vez de devolver la que hay', prueba: 'visitas',
    espera: 'el mismo día no se registra dos veces',
    buscar: `  on conflict (invitado_id, dia) do nothing
  returning * into v;
  nueva := found;`, poner: `  returning * into v;
  nueva := found;` },
  { nombre: 'visitas: sin la restricción de una por día', prueba: 'visitas',
    espera: 'la base tampoco acepta dos visitas el mismo día',
    buscar: `  constraint expo_visitas_una_por_dia unique (invitado_id, dia)`,
    poner: `  constraint expo_visitas_una_por_dia unique (invitado_id, dia, llegada)` },
  { nombre: 'visitas: registrar fuera de un día de expo', prueba: 'visitas',
    espera: 'no se registra asistencia antes de la expo',
    buscar: `    if e.estado <> 'en_curso' or not (hoy = any (e.dias)) then
      raise exception 'expo_no_es_dia_de_expo';
    end if;
    v_dia     := hoy;`, poner: `    v_dia     := hoy;` },
  { nombre: 'visitas: registrar en curso en un día que no es de expo', prueba: 'visitas',
    espera: 'en curso pero hoy no es día de expo',
    buscar: `    if e.estado <> 'en_curso' or not (hoy = any (e.dias)) then
      raise exception 'expo_no_es_dia_de_expo';
    end if;
    v_dia     := hoy;`, poner: `    if e.estado <> 'en_curso' then
      raise exception 'expo_no_es_dia_de_expo';
    end if;
    v_dia     := hoy;` },
  { nombre: 'visitas: aceptar horas del celular en el futuro', prueba: 'visitas',
    espera: 'una hora del celular que no es creíble se rechaza',
    buscar: `       or p_llegada > now() + interval '1 hour'  -- reloj adelantado: least() lo corrige`, poner: '' },
  { nombre: 'visitas: aceptar registros sin señal de hace días', prueba: 'visitas',
    espera: 'más de 3 días de demora se rechaza',
    buscar: `       or p_llegada < now() - interval '3 days' then`, poner: `       then` },
  { nombre: 'visitas: el día del celular en UTC y no en hora argentina', prueba: 'visitas',
    espera: 'el día se cuenta en hora argentina',
    buscar: `    v_dia := public.expo__dia_ar(p_llegada);`, poner: `    v_dia := p_llegada::date;` },
  { nombre: 'visitas: expo__dia_ar ignora la zona argentina', prueba: 'visitas',
    espera: 'el día se cuenta en hora argentina',
    buscar: `  select (t at time zone 'America/Argentina/Buenos_Aires')::date`, poner: `  select t::date` },
  { nombre: 'visitas: guardar la hora del celular aunque esté adelantado', prueba: 'visitas',
    espera: 'reloj adelantado media hora',
    buscar: `    v_llegada := least(p_llegada, now());`, poner: `    v_llegada := p_llegada;` },
  { nombre: 'visitas: ignorar la hora del celular', prueba: 'visitas',
    espera: 'el reintento guarda la hora del celular',
    buscar: `    v_llegada := least(p_llegada, now());`, poner: `    v_llegada := now();` },
  { nombre: 'visitas: confirmar durante la expo', prueba: 'visitas',
    espera: 'durante la expo ya no se confirma',
    buscar: `  if e.estado <> 'previa' then
    raise exception 'expo_no_es_previa';`, poner: `  if false then
    raise exception 'expo_no_es_previa';` },
  { nombre: 'visitas: confirmar que van sin cantidad', prueba: 'visitas',
    espera: 'confirmar que van exige la cantidad',
    buscar: `  if p_va and not public.expo__cantidad_valida(p_cantidad) then`, poner: `  if p_va and p_cantidad > 30 then` },
  { nombre: 'visitas: corregir con la expo cerrada', prueba: 'visitas',
    espera: 'con la expo cerrada ya no se corrige la cantidad',
    buscar: `  select * into e from public.expo_ediciones where id = i.edicion_id;
  if e.estado <> 'en_curso' then
    raise exception 'expo_no_es_dia_de_expo';
  end if;

  update public.expo_visitas`, poner: `  update public.expo_visitas` },
  { nombre: 'visitas: link de otro año sigue andando', prueba: 'visitas',
    espera: 'el link de una expo vieja es un QR inválido',
    buscar: `  if e.estado = 'cerrada'
     and exists (select 1 from public.expo_ediciones n where n.anio > e.anio) then`, poner: `  if false then` },
  { nombre: 'visitas: registrar sin validar la cantidad', prueba: 'visitas',
    espera: 'la cantidad va de 1 a 30',
    buscar: `  if not public.expo__cantidad_valida(p_cantidad) then
    raise exception 'expo_cantidad_invalida';
  end if;
  select * into e from public.expo_ediciones where id = i.edicion_id;

  if p_llegada is null then`, poner: `  select * into e from public.expo_ediciones where id = i.edicion_id;

  if p_llegada is null then` },
  { nombre: 'visitas: el rango de cantidad deja pasar 0 y null', prueba: 'visitas',
    espera: 'la cantidad va de 1 a 30',
    buscar: `  select coalesce(n between 1 and 30, false)`, poner: `  select coalesce(n between 0 and 30, true)` },
  { nombre: 'visitas: turnos fuera de los días de la expo', prueba: 'visitas',
    espera: 'turnos y visitas solo en días de la expo',
    buscar: `       and new.dia = any (e.dias)`, poner: `` },

  // ── cartel
  { nombre: 'cartel: buscar con menos de 3 letras', prueba: 'cartel',
    espera: 'con menos de 3 letras no busca',
    buscar: `  if e.estado <> 'en_curso' or char_length(replace(q, ' ', '')) < 3 then`,
    poner: `  if e.estado <> 'en_curso' then` },
  { nombre: 'cartel: más de 8 resultados', prueba: 'cartel',
    espera: 'devuelve como máximo 8',
    buscar: `              i.razon_social\n     limit 8;`, poner: `              i.razon_social\n     limit 80;` },
  { nombre: 'cartel: el buscador muestra las altas', prueba: 'cartel',
    espera: 'no muestra las altas de la puerta',
    buscar: `       and i.origen = 'lista'`, poner: '' },
  { nombre: 'cartel: buscar fuera de la expo', prueba: 'cartel',
    espera: 'no muestra las altas de la puerta ni busca fuera de la expo',
    buscar: `  if e.estado <> 'en_curso' or char_length(replace(q, ' ', '')) < 3 then`,
    poner: `  if char_length(replace(q, ' ', '')) < 3 then` },
  { nombre: 'cartel: cualquier clave sirve para buscar', prueba: 'cartel',
    espera: 'sin la clave del QR del cartel no se busca',
    buscar: `     where estado <> 'cerrada'
       and clave_cartel_hash = public.expo__hash_clave(p_clave);`, poner: `     where estado <> 'cerrada';` },
  { nombre: 'cartel: la clave del cartel sigue andando con la expo cerrada', prueba: 'cartel',
    espera: 'la clave del cartel deja de andar',
    buscar: `     where estado <> 'cerrada'
       and clave_cartel_hash`, poner: `     where clave_cartel_hash` },
  { nombre: 'cartel: alta rápida sin clave del cartel', prueba: 'cartel',
    espera: 'sin la clave del QR del cartel no se busca',
    buscar: `  e := public.expo__edicion_del_cartel(p_clave_cartel);`,
    poner: `  select * into e from public.expo_ediciones where estado = 'en_curso';` },
  { nombre: 'cartel: cambiar la clave del cartel no invalida la vieja', prueba: 'cartel',
    espera: 'recepción cambia la clave del cartel',
    buscar: `     set clave_cartel_hash = public.expo__hash_clave(clave)`, poner: `     set clave_cartel_hash = clave_cartel_hash` },
  { nombre: 'cartel: buscar con tildes y mayúsculas', prueba: 'cartel',
    espera: 'busca sin tildes ni mayúsculas',
    buscar: `             'aaaaaaaaaaeeeeeeeeiiiiiiiioooooooooouuuuuuuunncc')),`,
    poner: `             'ÁÀÄÂÃáàäâãÉÈËÊéèëêÍÌÏÎíìïîÓÒÖÔÕóòöôõÚÙÜÛúùüûÑñÇç')),` },
  // (buscar con LIKE no se muta: expo_normalizar ya borra % y _ antes de
  // buscar y strpos no tiene comodines; el test de comodines queda igual)
  { nombre: 'cartel: sin freno de altas por minuto', prueba: 'cartel',
    espera: 'frena después de 12 por minuto',
    buscar: `  if n >= tope_por_minuto then`, poner: `  if false then` },
  { nombre: 'cartel: sin tope de altas por día', prueba: 'cartel',
    espera: 'tope de 300 por día',
    buscar: `  if n >= tope_por_dia then`, poner: `  if false then` },
  { nombre: 'cartel: el reintento del alta duplica', prueba: 'cartel',
    espera: 'el reintento con la misma clave no duplica',
    buscar: `  if p_clave is null then
    return null;
  end if;`, poner: `  if true then
    return null;
  end if;` },
  { nombre: 'cartel: el reintento después de vincular pierde la visita', prueba: 'cartel',
    espera: 'el reintento después de que recepción la vinculó',
    buscar: `   where invitado_id = coalesce(a.vinculado_a, a.id)`, poner: `   where invitado_id = a.id` },
  { nombre: 'cartel: sin tope al largo de la empresa', prueba: 'cartel',
    espera: 'largos y categoría controlados',
    buscar: `  if coalesce(char_length(v_empresa), 0) not between 2 and 120 then`,
    poner: `  if coalesce(char_length(v_empresa), 0) < 2 then` },
  { nombre: 'cartel: proveedores quedan pendientes de vincular', prueba: 'cartel',
    espera: 'proveedor, comex y licencias quedan como no clientes',
    buscar: `then 'pendiente' else 'no_cliente' end,`, poner: `then 'pendiente' else 'pendiente' end,` },

  // ── vincular
  { nombre: 'vincular: se queda siempre con la cantidad del cliente', prueba: 'vincular',
    espera: 'vincular une las visitas del mismo día',
    buscar: `set cantidad = greatest(vd.cantidad, va.cantidad),`, poner: `set cantidad = vd.cantidad,` },
  { nombre: 'vincular: se queda siempre con la cantidad del alta', prueba: 'vincular',
    espera: 'si el cliente vino con más gente y antes',
    buscar: `set cantidad = greatest(vd.cantidad, va.cantidad),`, poner: `set cantidad = va.cantidad,` },
  { nombre: 'vincular: se queda siempre con la llegada del cliente', prueba: 'vincular',
    espera: 'vincular une las visitas del mismo día',
    buscar: `llegada  = least(vd.llegada, va.llegada)`, poner: `llegada  = vd.llegada` },
  { nombre: 'vincular: se queda siempre con la llegada del alta', prueba: 'vincular',
    espera: 'si el cliente vino con más gente y antes',
    buscar: `llegada  = least(vd.llegada, va.llegada)`, poner: `llegada  = va.llegada` },
  { nombre: 'vincular: pierde los recorridos del alta', prueba: 'vincular',
    espera: 'vincular une las visitas del mismo día',
    buscar: `        insert into public.expo_recorridos (visita_id, equipo_id, tomo_pedido, creado_en)
        select vd.id, r.equipo_id, r.tomo_pedido, r.creado_en
          from public.expo_recorridos r
         where r.visita_id = va.id
        on conflict (visita_id, equipo_id) do update
          set tomo_pedido = expo_recorridos.tomo_pedido or excluded.tomo_pedido;`, poner: '' },
  { nombre: 'vincular: pierde quién tomó el pedido al unir', prueba: 'vincular',
    espera: 'vincular conserva quién tomó el pedido',
    buscar: `          set tomo_pedido = expo_recorridos.tomo_pedido or excluded.tomo_pedido;`,
    poner: `          set tomo_pedido = expo_recorridos.tomo_pedido;` },
  { nombre: 'vincular: no guarda quién vinculó', prueba: 'vincular',
    espera: 'vincular deja quién vinculó y cuándo',
    buscar: `           vinculado_por  = quien,
           vinculado_en   = now()
     where id = a.id;
    return destino.id;`, poner: `           vinculado_por  = 'alguien',
           vinculado_en   = now()
     where id = a.id;
    return destino.id;` },
  { nombre: 'vincular: vincula dos veces', prueba: 'vincular',
    espera: 'un alta ya vinculada no se vuelve a vincular',
    buscar: `or a.estado_vinculo = 'vinculada' then`, poner: `then` },
  { nombre: 'vincular: el link del alta no sigue al cliente', prueba: 'vincular',
    espera: 'el link del alta, ya vinculada, muestra al cliente',
    buscar: `  if found and i.vinculado_a is not null then`, poner: `  if false then` },
  { nombre: 'vincular: un "Me anoto" en cola con la visita borrada se pierde', prueba: 'vincular',
    espera: 'llega a la visita unida',
    buscar: `  select coalesce((select f.nueva from public.expo_visitas_fusion f where f.vieja = p_visita), p_visita)`,
    poner: `  select p_visita` },
  { nombre: 'vincular: marcar como no cliente un alta ya vinculada', prueba: 'vincular',
    espera: 'un alta ya vinculada no se puede marcar como no cliente',
    buscar: `     and origen = 'alta_puerta'
     and estado_vinculo <> 'vinculada';`, poner: `     and origen = 'alta_puerta';` },
  { nombre: 'vincular: un cliente no invitado no toma los datos de Finnegans', prueba: 'vincular',
    espera: 'toma sus datos de Finnegans',
    buscar: `         vendedor        = c.vendedor,`, poner: `` },

  // ── recorrido
  { nombre: 'recorrido: el equipo admite vendedores', prueba: 'recorrido',
    espera: '"su vendedor" nunca se guarda como recorrido',
    buscar: `check (rol in ('hostess', 'marketing'))`, poner: `check (rol in ('hostess', 'marketing', 'vendedor'))` },
  { nombre: 'recorrido: anotarse con cualquiera, aunque no sea del equipo', prueba: 'recorrido',
    espera: '"su vendedor" nunca se guarda como recorrido',
    buscar: `     or not exists (select 1 from public.expo_equipo q where q.id = p_equipo and q.activo) then`,
    poner: `     or false then` },
  { nombre: 'recorrido: la clave sigue andando con la expo cerrada', prueba: 'recorrido',
    espera: 'cuando la expo cierra, la clave deja de andar',
    buscar: `   where estado <> 'cerrada'
     and clave_equipo_hash`, poner: `   where clave_equipo_hash` },
  { nombre: 'recorrido: la lista del equipo muestra a los inactivos', prueba: 'recorrido',
    espera: 'solo el equipo activo',
    buscar: `      where q.activo),`, poner: `      ),` },
  { nombre: 'recorrido: presentes de otros días', prueba: 'recorrido',
    espera: 'presentes del día, los últimos arriba',
    buscar: `         and v.dia = hoy
         and e.estado = 'en_curso'`, poner: `         and e.estado = 'en_curso'` },
  { nombre: 'recorrido: presentes ordenados al revés', prueba: 'recorrido',
    espera: 'presentes del día, los últimos arriba',
    buscar: `             order by v.llegada desc)`, poner: `             order by v.llegada)` },
  { nombre: 'recorrido: anotarse dos veces duplica', prueba: 'recorrido',
    espera: 'me anoto, me anoto de nuevo',
    buscar: `  insert into public.expo_recorridos (visita_id, equipo_id)
  values (visita, p_equipo)
  on conflict do nothing;`, poner: `  insert into public.expo_recorridos (visita_id, equipo_id)
  values (visita, p_equipo);` },
  { nombre: 'recorrido: anotarse en una visita de otra edición', prueba: 'recorrido',
    espera: 'no se anota en una visita de otra edición',
    buscar: `     where v.id = visita and i.edicion_id = e.id`, poner: `     where v.id = visita` },
  { nombre: 'recorrido: anotarse en una visita de ayer', prueba: 'recorrido',
    espera: 'no se anota en una visita de ayer',
    buscar: `       and v.dia = public.expo_hoy()   -- con la lista de ayer guardada en el celular no se anota en una visita de ayer`,
    poner: '' },
  { nombre: 'recorrido: bajar a alguien con la clave de otra edición', prueba: 'recorrido',
    espera: 'con la clave de otra edición no se baja a nadie',
    buscar: `     and i.edicion_id = e.id;
end
$$;


-- "Tomé el pedido"`, poner: `     ;
end
$$;


-- "Tomé el pedido"` },
  { nombre: 'recorrido: anotarse antes de la expo', prueba: 'recorrido',
    espera: 'antes de la expo nadie se anota',
    buscar: `  if e.estado <> 'en_curso' then
    raise exception 'expo_no_es_dia_de_expo';
  end if;
  if not exists (`, poner: `  if not exists (` },
  { nombre: 'recorrido: marcar "Tomé el pedido" sin estar anotado', prueba: 'recorrido',
    espera: 'solo quien se anotó',
    buscar: `  if not found then
    raise exception 'expo_no_anotado';
  end if;`, poner: '' },
  { nombre: 'recorrido: marcar "Tomé el pedido" fuera de la expo', prueba: 'recorrido',
    espera: 'con la expo cerrada o con otra clave no anda',
    buscar: `  if e.estado <> 'en_curso' then
    raise exception 'expo_no_es_dia_de_expo';
  end if;
  if p_tomo is null then`, poner: `  if p_tomo is null then` },
  // ── página (index.html)
  { nombre: 'página: escH no escapa <', archivo: 'index', prueba: 'checkin',
    espera: 'se muestran como texto, nunca como HTML',
    buscar: `.replace(/</g, "&lt;")`, poner: `` },
  { nombre: 'página: la razón social se corta en vez de bajar de renglón', archivo: 'index', prueba: 'anchos',
    espera: '320 px · check-in · razón social una palabra larguísima',
    buscar: `.mr-razon { font-size: 28px; line-height: 33px; font-weight: 600; letter-spacing: .005em; overflow-wrap: anywhere;`,
    poner: `.mr-razon { font-size: 28px; line-height: 33px; font-weight: 600; letter-spacing: .005em; overflow: hidden;` },
  { nombre: 'página: la razón social larga no baja a 24 px', archivo: 'index', prueba: 'anchos',
    espera: 'razón social más de 60 caracteres',
    buscar: `const larga = texto.length > 60 ? " mr-razon--larga" : "";`, poner: `const larga = "";` },
  { nombre: 'página: acepta el #access_token de la URL', archivo: 'index', prueba: 'checkin',
    espera: 'nunca acepta un #access_token',
    buscar: `  if (PROHIBIDOS.some(k => p.has(k))) {`, poner: `  if (false) {` },
  { nombre: 'página: sin señal frena en vez de guardar en el celular', archivo: 'index', prueba: 'checkin',
    espera: 'sin señal: deja pasar, guarda en el celular',
    buscar: `    const id = encolar("expo_registrar_visita", { p_token: token, p_cantidad: n, p_llegada: llegada });`,
    poner: `    return pantallaError(e);` },
  { nombre: 'página: el reintento no manda la hora en que llegaron', archivo: 'index', prueba: 'checkin',
    espera: 'sin señal: deja pasar, guarda en el celular',
    buscar: `{ p_token: token, p_cantidad: n, p_llegada: llegada }`, poner: `{ p_token: token, p_cantidad: n, p_llegada: null }` },
  { nombre: 'página: lo guardado sin señal se pierde al cerrar la página', archivo: 'index', prueba: 'checkin',
    espera: 'si se cierra la página',
    buscar: `  if (guardado) return esperarRegistro(guardado);`, poner: `` },
  { nombre: 'página: sin señal al abrir no usa lo que ya se había visto', archivo: 'index', prueba: 'checkin',
    espera: 'sin señal al abrir',
    buscar: `    d = alDiaDeHoy(leerLocal(CACHE_INV(token)));   // lo último que se vio con señal, si hubo`, poner: `    d = null;` },
  { nombre: 'página: el botón ocupado se puede tocar de nuevo', archivo: 'index', prueba: 'checkin',
    espera: 'dos toques seguidos registran una sola vez',
    buscar: `  boton.disabled = true;
  boton.setAttribute("aria-busy", "true");`, poner: `  boton.setAttribute("aria-busy", "true");` },
  { nombre: 'página: "ya estaban registrados" se muestra como recién registrado', archivo: 'index', prueba: 'checkin',
    espera: 'el mismo día no se registra dos veces',
    buscar: `    return r.nueva ? pantallaRegistrado(r) : pantallaYaRegistrado(r);`, poner: `    return pantallaRegistrado(r);` },
  { nombre: 'página: un token mal formado se manda a la base', archivo: 'index', prueba: 'checkin',
    espera: 'un token mal formado ni se manda a la base',
    buscar: `  if (!TOKEN_RE.test(token || "")) return pantallaInvalido();`, poner: `` },
  { nombre: 'página: no sigue el modo oscuro del celular', archivo: 'index', prueba: 'checkin',
    espera: 'modo oscuro',
    buscar: `aplicarTema();
mqOscuro.addEventListener`, poner: `mqOscuro.addEventListener` },
  { nombre: 'página: QR inválido ofrece buscar aunque no haya clave del cartel', archivo: 'index', prueba: 'checkin',
    espera: 'QR inválido',
    buscar: `  const conCartel = !!claveCartel();`, poner: `  const conCartel = true;` },
  { nombre: 'página: busca con menos de 3 letras', archivo: 'index', prueba: 'cartel-pantalla',
    espera: 'con menos de 3 letras no busca',
    buscar: `const alcanzaParaBuscar = t => normalizar(t).replace(/ /g, "").length >= MIN_LETRAS_BUSQUEDA;`,
    poner: `const alcanzaParaBuscar = t => normalizar(t).replace(/ /g, "").length >= 1;` },
  { nombre: 'página: muestra resultados con tokens raros', archivo: 'index', prueba: 'cartel-pantalla',
    espera: 'un resultado con token raro no se muestra',
    buscar: `  filas = (filas || []).filter(f => TOKEN_RE.test(f.token || ""));`, poner: `  filas = filas || [];` },
  { nombre: 'página: el resaltado no escapa', archivo: 'index', prueba: 'cartel-pantalla',
    espera: 'resultados con nombres raros',
    buscar: `    html += escH(c);`, poner: `    html += c;` },
  { nombre: 'página: el alta no manda clave para no duplicar', archivo: 'index', prueba: 'cartel-pantalla',
    espera: 'alta rápida: pide nombre y empresa',
    buscar: `p_clave: crypto.randomUUID(),`, poner: `p_clave: null,` },
  { nombre: 'página: el alta sin señal frena en vez de dejar pasar', archivo: 'index', prueba: 'cartel-pantalla',
    espera: 'alta rápida sin señal: deja pasar',
    buscar: `    if (item && vistaN === vista) esperarAlta(item);`, poner: `    if (vistaN === vista) pantallaError(e);` },
  { nombre: 'página: el alta deja pasar sin nombre', archivo: 'index', prueba: 'cartel-pantalla',
    espera: 'alta rápida: pide nombre y empresa',
    buscar: `const faltaNombre = nombre.length < MIN_LARGO_NOMBRE,`, poner: `const faltaNombre = false,` },

  { nombre: 'página: usa lo guardado de otro día como si fuera de hoy', archivo: 'index', prueba: 'checkin',
    espera: 'sin señal con lo guardado ayer',
    buscar: `  if (visto === hoy) return d;`, poner: `  return d;` },
  { nombre: 'página: lo guardado antes de la expo no pasa a "en curso" el día de la expo', archivo: 'index', prueba: 'checkin',
    espera: 'sin señal con lo guardado de antes de la expo',
    buscar: `    actual.estado = "en_curso";`, poner: `` },
  { nombre: 'página: lo que sale tarde de la cola pisa cualquier pantalla', archivo: 'index', prueba: 'checkin',
    espera: 'no pisa la pantalla de otro cliente',
    buscar: `  alEnviar[id] = (r, error) => { if (vistaN === vista) hacer(r, error); };`, poner: `  alEnviar[id] = (r, error) => hacer(r, error);` },
  { nombre: 'página: al reabrir no muestra la confirmación sin enviar', archivo: 'index', prueba: 'checkin',
    espera: 'al reabrir con una confirmación sin enviar',
    buscar: `    const sinEnviar = pendiente("expo_confirmar", cli.token);`, poner: `    const sinEnviar = null;` },
  { nombre: 'página: no avisa "Volvimos hoy" a quien vino otro día', archivo: 'index', prueba: 'checkin',
    espera: 'ya vino otro día',
    buscar: `  if (d.visita_anterior) return pantallaRegistrar({ verbo: "Volvimos hoy", anterior: d.visita_anterior });`, poner: `` },
  { nombre: 'página: en curso pero hoy no hay expo, igual ofrece registrarse', archivo: 'index', prueba: 'checkin',
    espera: 'en curso pero hoy no hay expo',
    buscar: `  if (!dias.includes(d.edicion.hoy)) return pantallaFueraDeDia();`, poner: `` },
  { nombre: 'página: expo terminada no dice quién es el vendedor', archivo: 'index', prueba: 'checkin',
    espera: 'expo terminada: deriva al vendedor',
    buscar: `  const quien = d.vendedor ?`, poner: `  const quien = false ?` },
  { nombre: 'página: corregir manda la cantidad vieja', archivo: 'index', prueba: 'checkin',
    espera: 'corregir la cantidad',
    buscar: `rpc("expo_corregir_cantidad", { p_token: token, p_cantidad: n })`, poner: `rpc("expo_corregir_cantidad", { p_token: token, p_cantidad: actual })` },
  { nombre: 'página: "No vamos a poder ir" manda que sí van', archivo: 'index', prueba: 'checkin',
    espera: 'antes de la expo: confirmar',
    buscar: `  const args = { p_token: token, p_cantidad: va ? n : null, p_va: va };`, poner: `  const args = { p_token: token, p_cantidad: va ? n : null, p_va: true };` },
  { nombre: 'página: el tope por minuto se toma como definitivo y el alta se pierde', archivo: 'index', prueba: 'cartel-pantalla',
    espera: 'justo con el tope por minuto',
    buscar: `const PASAJEROS = new Set(["expo_demasiadas_altas_minuto"]);`, poner: `const PASAJEROS = new Set([]);` },
  { nombre: 'página: una búsqueda vieja pisa la nueva', archivo: 'index', prueba: 'cartel-pantalla',
    espera: 'una búsqueda vieja que contesta tarde',
    buscar: `  if (n !== busquedaN) return;   // llegó tarde: ya se escribió otra cosa`, poner: `` },
  { nombre: 'página: una clave del cartel vencida queda guardada', archivo: 'index', prueba: 'cartel-pantalla',
    espera: 'si la clave del cartel dejó de valer',
    buscar: `      borrarLocal(CLAVE_CARTEL);`, poner: `` },
  { nombre: 'página: el buscador abre sin la clave del cartel', archivo: 'index', prueba: 'cartel-pantalla',
    espera: 'sin la clave del cartel no hay buscador',
    buscar: `function pantallaBuscar() {
  if (!claveCartel()) return pantallaSinClaveCartel();`, poner: `function pantallaBuscar() {` },
  { nombre: 'página: después de un rechazo el botón del alta queda trabado', archivo: 'index', prueba: 'cartel-pantalla',
    espera: 'alta rápida que la base rechaza',
    buscar: `    liberar(boton, "Registrarme · " + cuantos(n));`, poner: `` },
  { nombre: 'página: la versión de la app no es la del service worker', archivo: 'index', prueba: 'app',
    espera: 'el service worker tiene la misma versión',
    buscar: `const APP_VERSION = "`, poner: `const APP_VERSION = "otra-` },
  { nombre: 'página: un logo nuevo que el service worker no guarda', archivo: 'index', prueba: 'app',
    espera: 'el service worker guarda los logos',
    buscar: `const LOGO = { claro: "assets/logo-claro.png"`, poner: `const LOGO = { claro: "assets/logo-nuevo.gif"` },

  // ── página: equipo de recorrido
  { nombre: "equipo: el vendedor aparece como si hubiera hecho el recorrido", archivo: 'index', prueba: 'recorrido-pantalla',
    espera: "\"Lo atiende su vendedor\" por defecto",
    buscar: ".concat(mio ? [\"vos\"] : []);", poner: ".concat(mio ? [\"vos\"] : []).concat(p.vendedor ? [p.vendedor] : []);" },
  { nombre: "equipo: \"Me anoto\" no manda quién es", archivo: 'index', prueba: 'recorrido-pantalla',
    espera: "\"Me anoto\": se ve en el acto",
    buscar: "const args = { p_equipo: eq.yo.id, p_visita: visita };", poner: "const args = { p_equipo: null, p_visita: visita };" },
  { nombre: "equipo: la razón social de la tarjeta sin escapar", archivo: 'index', prueba: 'recorrido-pantalla',
    espera: "nombres y datos de la base escapados",
    buscar: "<h3 class=\"mr-presente-razon\">${escH(p.razon_social)}</h3>", poner: "<h3 class=\"mr-presente-razon\">${p.razon_social}</h3>" },
  { nombre: "equipo: los nombres del equipo sin escapar", archivo: 'index', prueba: 'recorrido-pantalla',
    espera: "nombres y datos de la base escapados",
    buscar: "<span class=\"mr-resultado-razon\">${escH(p.nombre)}</span><span class=\"mr-chico\" style=\"display:block\">${escH(ROLES[p.rol] || \"\")}</span>", poner: "<span class=\"mr-resultado-razon\">${p.nombre}</span><span class=\"mr-chico\" style=\"display:block\">${escH(ROLES[p.rol] || \"\")}</span>" },
  { nombre: "equipo: \"Sin recorrido\" muestra todos", archivo: 'index', prueba: 'recorrido-pantalla',
    espera: "filtros: Sin recorrido y Míos",
    buscar: "sin: todos.filter(p => !p.recorrido.length)", poner: "sin: todos" },
  { nombre: "equipo: el buscador de presentes no filtra", archivo: 'index', prueba: 'recorrido-pantalla',
    espera: "buscar presente filtra",
    buscar: ".filter(p => !q || q.split(\" \").every(w => normalizar(p.razon_social).includes(w)));", poner: ";" },
  { nombre: "equipo: \"Tomé el pedido\" aparece en presentes ajenos", archivo: 'index', prueba: 'recorrido-pantalla',
    espera: "\"Tomé el pedido\": solo en los míos",
    buscar: "(mio ? `<label class=\"mr-interruptor\">", poner: "(true ? `<label class=\"mr-interruptor\">" },
  { nombre: "equipo: quien salió del equipo sigue elegido", archivo: 'index', prueba: 'recorrido-pantalla',
    espera: "si la persona ya no está en el equipo",
    buscar: "      borrarLocal(YO);   // ya no está en el equipo activo: que vuelva a elegir", poner: "" },
  { nombre: "página: la clave del cartel queda en la URL", archivo: 'index', prueba: "cartel-pantalla",
    espera: "el QR del cartel guarda la clave",
    buscar: "claveDelLink(r.cartel, CLAVE_CARTEL, \"#buscar\");", poner: "guardarLocal(CLAVE_CARTEL, r.cartel);" },
  { nombre: "página: un \"no vamos\" viejo de la cola pisa la decisión nueva", archivo: 'index', prueba: "checkin",
    espera: "no pisa el \"sí vamos\" de después",
    buscar: "  descartarPendientes(misma);   // lo último que se decidió es lo que vale…", poner: "" },
  { nombre: "página: no parte la razón social en el primer \" - \"", archivo: 'index', prueba: "anchos",
    espera: "razón social con guion",
    buscar: "  const partes = partirRazon(texto);", poner: "  const partes = [texto];" },
  { nombre: "equipo: la clave del equipo queda en la URL", archivo: 'index', prueba: "recorrido-pantalla",
    espera: "el link del equipo guarda la clave",
    buscar: "claveDelLink(r.equipo, CLAVE_EQUIPO, \"#recorrido\");", poner: "guardarLocal(CLAVE_EQUIPO, r.equipo);" },
  { nombre: "equipo: una clave vencida queda guardada", archivo: 'index', prueba: "recorrido-pantalla",
    espera: "una clave del equipo vencida",
    buscar: "function claveEquipoVencida() {\n  borrarLocal(CLAVE_EQUIPO);", poner: "function claveEquipoVencida() {" },
  { nombre: "equipo: un \"Me anoto\" viejo de la cola pisa el \"Me bajo\"", archivo: 'index', prueba: "recorrido-pantalla",
    espera: "queda solo el \"Me bajo\"",
    buscar: "  descartarPendientes(i => misma.includes(i.fn) && i.args.p_equipo === args.p_equipo && i.args.p_visita === visita);", poner: "" },
  { nombre: "equipo: las acciones salen directo y se adelantan a la cola", archivo: 'index', prueba: "recorrido-pantalla",
    espera: "salen en orden y queda el pedido",
    buscar: "  const id = encolar(fn, args);\n  const { vista } = eq;\n  alSalir(id, vista, (r, error) => {\n    if (error) { eq.tostada = null; eq.aviso = mensajeDe(error); }\n    cargarPresentes(vista);   // lo que quedó de verdad en la base\n  });\n  eq.aviso = \"\";\n  mostrarTostada(fn, visita);\n  repintarPresentes();\n  procesarCola();\n}", poner: "  const { vista } = eq;\n  eq.aviso = \"\";\n  mostrarTostada(fn, visita);\n  repintarPresentes();\n  rpc(fn, args).catch(e => { if (e instanceof ErrorRed) { encolar(fn, args); repintarPresentes(); } else cargarPresentes(vista); });\n}" },
  { nombre: "equipo: la actualización pisa lo que está en camino", archivo: 'index', prueba: "recorrido-pantalla",
    espera: "no pisa un \"Me anoto\" que todavía está en camino",
    buscar: "  accionesPendientes(eq.yo.id).forEach(i => aplicarAccion(datos, i, eq.yo.nombre));", poner: "" },
  { nombre: "equipo: un rechazo de la base no se avisa", archivo: 'index', prueba: "recorrido-pantalla",
    espera: "si la base rechaza lo que se tocó",
    buscar: "    if (error) { eq.tostada = null; eq.aviso = mensajeDe(error); }", poner: "" },
  { nombre: "equipo: la lista no se actualiza sola", archivo: 'index', prueba: "recorrido-pantalla",
    espera: "se actualiza sola cada 15 segundos",
    buscar: "const REFRESCO_PRESENTES_MS = 15000;", poner: "const REFRESCO_PRESENTES_MS = 150000;" },
  { nombre: "equipo: \"Deshacer\" no baja a nadie", archivo: 'index', prueba: "recorrido-pantalla",
    espera: "\"Me anoto\": se ve en el acto",
    buscar: "  if (eq.tostada) $(\"#deshacer\").onclick = () => accionEquipo(\"expo_bajarme\", eq.tostada.visita);", poner: "" },
  { nombre: "equipo: la tostada no se va sola", archivo: 'index', prueba: "recorrido-pantalla",
    espera: "la tostada de \"Me anoto\" se va sola",
    buscar: "const TOSTADA_MS = 6000;", poner: "const TOSTADA_MS = 6000000;" },
  { nombre: "equipo: el foco se pierde al repintar", archivo: 'index', prueba: "recorrido-pantalla",
    espera: "deja el foco",
    buscar: "nadieLlego(datos);\n  volverAlFoco();\n", poner: "nadieLlego(datos);\n" },
  { nombre: "equipo: usa la lista guardada de ayer", archivo: 'index', prueba: "recorrido-pantalla",
    espera: "la lista guardada de hoy se usa",
    buscar: " && guardados.datos.hoy === hoyAR();", poner: ";" },
  { nombre: "equipo: los presentes salen en el orden de la base", archivo: 'index', prueba: "recorrido-pantalla",
    espera: "los últimos arriba",
    buscar: ".slice().sort((a, b) => new Date(b.llegada) - new Date(a.llegada));", poner: ".slice();" },
  { nombre: "equipo: \"▾\" borra a la persona elegida", archivo: 'index', prueba: "recorrido-pantalla",
    espera: "\"Volver\" deja la misma persona",
    buscar: "  $(\"#quiensoy\").onclick = () => pantallaQuienSos();", poner: "  $(\"#quiensoy\").onclick = () => { borrarLocal(YO); pantallaQuienSos(); };" },
  { nombre: "página: el registro sin señal se pierde si cambia de pantalla", archivo: 'index', prueba: "checkin",
    espera: "el registro igual queda guardado",
    buscar: "    if (e instanceof ErrorRed) {\n      const id = encolar(\"expo_registrar_visita\"", poner: "    if (vistaN !== vista) return;\n    if (e instanceof ErrorRed) {\n      const id = encolar(\"expo_registrar_visita\"" },
  { nombre: "página: la corrección sin señal se pierde si cambia de pantalla", archivo: 'index', prueba: "checkin",
    espera: "la corrección igual queda guardada",
    buscar: "      const id = encolar(\"expo_corregir_cantidad\", { p_token: token, p_cantidad: n });   // siempre (ver registrar)\n      if (vistaN !== vista) return;", poner: "      if (vistaN !== vista) return;\n      const id = encolar(\"expo_corregir_cantidad\", { p_token: token, p_cantidad: n });" },
  { nombre: "página: la confirmación sin señal se pierde si cambia de pantalla", archivo: 'index', prueba: "checkin",
    espera: "la confirmación igual queda guardada",
    buscar: "    const id = encolar(\"expo_confirmar\", args);   // siempre (ver registrar)\n    if (vistaN !== vista) return;", poner: "    if (vistaN !== vista) return;\n    const id = encolar(\"expo_confirmar\", args);" },
  { nombre: "página: un 404 se toma como rechazo y se tira lo guardado", archivo: 'index', prueba: "checkin",
    espera: "un 404",
    buscar: "    const aProposito = motivo.startsWith(\"expo_\") && !PASAJEROS.has(motivo);", poner: "    const aProposito = !PASAJEROS.has(motivo);" },
  { nombre: "página: sin almacenamiento, lo que no se pudo guardar se pierde", archivo: 'index', prueba: "checkin",
    espera: "con el almacenamiento lleno, sin señal igual deja pasar",
    buscar: "JSON.parse(enMemoria.has(clave) ? enMemoria.get(clave) : localStorage.getItem(clave))", poner: "JSON.parse(localStorage.getItem(clave))" },
  { nombre: "página: la clave del link sale de la URL aunque no se pudo guardar", archivo: 'index', prueba: "cartel-pantalla",
    espera: "con el almacenamiento bloqueado",
    buscar: "  if (!TOKEN_RE.test(valor) || guardarLocal(nombre, valor)) history", poner: "  if (!TOKEN_RE.test(valor) || guardarLocal(nombre, valor) || true) history" },
  { nombre: "página: con la clave vencida lo pendiente se tira", archivo: 'index', prueba: "recorrido-pantalla",
    espera: "recepción cambió la clave",
    buscar: "        if (CLAVE_VENCIDA.has(e.message)) { enPausa.add(item.id); continue; }\n", poner: "" },
  { nombre: "página: el link nuevo no manda lo que esperaba la clave", archivo: 'index', prueba: "recorrido-pantalla",
    espera: "recepción cambió la clave",
    buscar: "location.search + destino);\n  procesarCola();", poner: "location.search + destino);" },
  { nombre: "página: el alta se guarda recién cuando falla", archivo: 'index', prueba: "cartel-pantalla",
    espera: "queda guardada ANTES de mandarla",
    buscar: "  const id = encolar(\"expo_alta_rapida\", args);\n  ultimaBusqueda = \"\";", poner: "  const id = \"en-memoria\";\n  ultimaBusqueda = \"\";\n  setTimeout(() => encolar(\"expo_alta_rapida\", args), 8000);" },
  { nombre: "página: al recargar, el alta que espera no se muestra", archivo: 'index', prueba: "cartel-pantalla",
    espera: "sin señal y recarga",
    buscar: "function pantallaAlta() {\n  if (!claveCartel()) return pantallaSinClaveCartel();\n  if (altaPendiente()) return esperarAlta(altaPendiente());\n", poner: "function pantallaAlta() {\n  if (!claveCartel()) return pantallaSinClaveCartel();\n" },
  { nombre: "página: al volver al buscador, el alta que espera no se muestra", archivo: 'index', prueba: "cartel-pantalla",
    espera: "si vuelve al buscador mientras espera, ve la que espera",
    buscar: "function pantallaBuscar() {\n  if (!claveCartel()) return pantallaSinClaveCartel();\n  if (altaPendiente()) return esperarAlta(altaPendiente());\n", poner: "function pantallaBuscar() {\n  if (!claveCartel()) return pantallaSinClaveCartel();\n" },
  { nombre: "página: registrado con señal no queda en lo guardado", archivo: 'index', prueba: "checkin",
    espera: "al reabrir sin señal ya figura registrado",
    buscar: "    recordarVisita(token, r);\n    if (vistaN !== vista) return;", poner: "    if (vistaN !== vista) return;" },
  { nombre: "página: registrado por la cola no queda en lo guardado", archivo: 'index', prueba: "checkin",
    espera: "al reabrir sin señal ya figura registrado",
    buscar: "      if (!error && VISITA_DEL_CLIENTE.includes(item.fn)) recordarVisita(item.args.p_token, resultado);\n", poner: "" },
  { nombre: "página: la corrección nueva no espera a la vieja en camino", archivo: 'index', prueba: "checkin",
    espera: "una corrección vieja que la cola ya mandó",
    buscar: "    await esperarEnVuelo(misma);   // la vieja que ya salió llega antes que esta\n", poner: "" },
  { nombre: "página: el sí vamos no espera al no vamos en camino", archivo: 'index', prueba: "checkin",
    espera: "llega antes que el \"sí vamos\"",
    buscar: "  await esperarEnVuelo(misma);  // …y la vieja que ya salió llega antes que esta\n", poner: "" },
  { nombre: "sw: borra los cachés de la app de pedidos", archivo: 'sw', prueba: "service-worker",
    espera: "borra solo sus versiones viejas",
    buscar: "claves.filter(k => k.startsWith(PREFIJO) && k !== CACHE)", poner: "claves.filter(k => k !== CACHE)" },
  { nombre: "recepción: el tablero sin chequear es_admin", prueba: "recepcion",
    espera: "solo un admin",
    buscar: "  if not public.es_admin() then\n    raise exception 'expo_solo_admin';\n  end if;\n\n  select * into e from public.expo_ediciones where estado <> 'cerrada';", poner: "  select * into e from public.expo_ediciones where estado <> 'cerrada';" },
  { nombre: "recepción: el buscador de Finnegans sin chequear es_admin", prueba: "recepcion",
    espera: "solo un admin",
    buscar: "  if not public.es_admin() then\n    raise exception 'expo_solo_admin';\n  end if;\n  if char_length(v_cuit) <> 11 then", poner: "  if char_length(v_cuit) <> 11 then" },
  { nombre: "recepción: el anónimo puede pedir el tablero", prueba: "recepcion",
    espera: "solo un admin",
    buscar: "grant execute on function public.expo_recepcion()                to authenticated;", poner: "grant execute on function public.expo_recepcion()                to anon, authenticated;" },
  { nombre: "recepción: un alta marcada \"no es cliente\" cuenta como cliente", prueba: "recepcion",
    espera: "si es \"no cliente\", pasa a los no clientes",
    buscar: "         and coalesce(i.estado_vinculo, 'pendiente') <> 'no_cliente'\n$$;", poner: "\n$$;" },
  { nombre: "recepción: los que ya llegaron figuran como faltantes", prueba: "recepcion",
    espera: "quién tenía turno y no llegó",
    buscar: "         and not exists (select 1 from public.expo_visitas v\n                          where v.invitado_id = i.id and v.dia = hoy)), '[]'::jsonb),", poner: "         ), '[]'::jsonb)," },
  { nombre: "recepción: las altas ya resueltas siguen en la lista", prueba: "recepcion",
    espera: "al vincular un alta sale de la lista",
    buscar: "         and i.estado_vinculo = 'pendiente'), '[]'::jsonb),", poner: "         ), '[]'::jsonb)," },
  { nombre: "recepción: el buscador ofrece clientes dados de baja", prueba: "recepcion",
    espera: "por CUIT (con guiones o sin)",
    buscar: "       where c.activo\n", poner: "       where true\n" },
  { nombre: "recepción: el buscador devuelve más de 8", prueba: "recepcion",
    espera: "como mucho 8",
    buscar: "              k.razon_social\n     limit 8;", poner: "              k.razon_social;" },
  { nombre: "recepción: \"Coincide el CUIT\" compara mal", prueba: "recepcion",
    espera: "por CUIT (con guiones o sin)",
    buscar: "    select k.codigo_erp, k.razon_social, k.localidad, k.zona, k.vendedor,\n           coalesce(k.cuit in (v_cuit, v_cuit_escrito), false)", poner: "    select k.codigo_erp, k.razon_social, k.localidad, k.zona, k.vendedor,\n           k.cuit is not null" },
  { nombre: "página: canjea un ?code= sin el verificador de este navegador", archivo: 'index', prueba: "recepcion-pantalla",
    espera: "no empezó en este navegador",
    buscar: "  if (typeof verificador !== \"string\" || !q.get(\"code\")) return pantallaLogin();", poner: "  if (!q.get(\"code\")) return pantallaLogin();" },
  { nombre: "página: el code de Google queda en la URL", archivo: 'index', prueba: "recepcion-pantalla",
    espera: "sin dejar el code en la URL",
    buscar: "  history.replaceState(null, \"\", location.pathname + \"#recepcion\");   // el code no queda en la URL ni en el historial\n", poner: "" },
  { nombre: "página: el login manda el verificador en vez del reto (sin PKCE)", archivo: 'index', prueba: "recepcion-pantalla",
    espera: "con PKCE",
    buscar: "  u.searchParams.set(\"code_challenge\", await retoPkce(verificador));", poner: "  u.searchParams.set(\"code_challenge\", verificador);" },
  { nombre: "página: recepción pide sin la sesión", archivo: 'index', prueba: "recepcion-pantalla",
    espera: "las cuatro cifras",
    buscar: "    return await rpc(fn, args, await tokenValido());", poner: "    return await rpc(fn, args);" },
  { nombre: "página: si la base dice que la sesión venció, no la renueva", archivo: 'index', prueba: "recepcion-pantalla",
    espera: "la sesión se renueva sola",
    buscar: "    return rpc(fn, args, await tokenValido(true));", poner: "    throw e;" },
  { nombre: "página: la sesión vencida no se renueva antes de pedir", archivo: 'index', prueba: "recepcion-pantalla",
    espera: "la sesión se renueva sola",
    buscar: "  if (!forzar && Date.now() < s.vence - RENOVAR_ANTES_MS) return s.access_token;", poner: "  if (!forzar) return s.access_token;" },
  { nombre: "página: un faltante con un nombre raro se mete como HTML", archivo: 'index', prueba: "recepcion-pantalla",
    espera: "nunca como HTML",
    buscar: "`<li class=\"mr-falta\"><span class=\"mr-falta-razon\">${escH(f.razon_social)}</span>`", poner: "`<li class=\"mr-falta\"><span class=\"mr-falta-razon\">${f.razon_social}</span>`" },
  { nombre: "página: el nombre del alta en la hoja se mete como HTML", archivo: 'index', prueba: "recepcion-pantalla",
    espera: "nunca como HTML",
    buscar: "<h2 id=\"vTitulo\" class=\"mr-titulo\" style=\"margin-top:6px\">${escH(a.empresa)}</h2>", poner: "<h2 id=\"vTitulo\" class=\"mr-titulo\" style=\"margin-top:6px\">${a.empresa}</h2>" },
  { nombre: "página: al actualizarse el filtro pierde el foco", archivo: 'index', prueba: "recepcion-pantalla",
    espera: "el filtro por vendedor",
    buscar: "  cambiarSiHaceFalta(cuerpo, html);\n  volverAlFoco();", poner: "  cambiarSiHaceFalta(cuerpo, html);" },
  { nombre: "página: si no se puede actualizar, borra lo último que se vio", archivo: 'index', prueba: "recepcion-pantalla",
    espera: "deja lo último con la hora",
    buscar: "    yo.fallo = true;\n  }\n  repintarRecepcion();", poner: "    yo.fallo = true;\n    yo.datos = null;\n  }\n  repintarRecepcion();" },
  { nombre: "página: el atraso se cuenta desde el fin del turno", archivo: 'index', prueba: "recepcion-pantalla",
    espera: "las cuatro cifras",
    buscar: "Atrasado ${escH(duracion(ahora - minutosDe(desde)))}", poner: "Atrasado ${escH(duracion(ahora - minutosDe(hasta)))}" },
  { nombre: "página: una cuenta sin permiso ve un error genérico", archivo: 'index', prueba: "recepcion-pantalla",
    espera: "no es admin",
    buscar: "    if (e instanceof ErrorServidor && e.message === \"expo_solo_admin\") return pantallaSinAcceso();\n", poner: "" },
  { nombre: "página: si otra persona ya resolvió el alta, no se actualiza", archivo: 'index', prueba: "recepcion-pantalla",
    espera: "otra persona ya la resolvió",
    buscar: "    if (e instanceof ErrorServidor && rec) cargarRecepcion();   // otra persona ya la resolvió: que se vea\n", poner: "" },
  { nombre: "página: la hoja de vincular no busca por el CUIT que cargó", archivo: 'index', prueba: "recepcion-pantalla",
    espera: "busca en Finnegans por CUIT",
    buscar: "{ p_texto: texto, p_cuit: v.alta.cuit || null }", poner: "{ p_texto: texto, p_cuit: null }" },
  { nombre: "recepción: con turno hoy cuenta los turnos de todos los días", prueba: "recepcion",
    espera: "quién tenía turno y no llegó",
    buscar: "       where i.edicion_id = e.id\n         and t.dia = hoy),", poner: "       where i.edicion_id = e.id)," },
  { nombre: "recepción: los turnos de otro día figuran como faltantes de hoy", prueba: "recepcion",
    espera: "quién tenía turno y no llegó",
    buscar: "         and t.dia = hoy\n         and not exists", poner: "         and not exists" },
  { nombre: "recepción: \"sin turno hoy\" mira los turnos de cualquier día", prueba: "recepcion",
    espera: "quién tenía turno y no llegó",
    buscar: "left join public.expo_turnos t on t.invitado_id = i.id and t.dia = v.dia", poner: "left join public.expo_turnos t on t.invitado_id = i.id" },
  { nombre: "recepción: \"Es cliente nuevo\" no cuenta si dijo que venía con un cliente", prueba: "recepcion",
    espera: "\"Es cliente nuevo\" cuenta como cliente",
    buscar: "  select (i.categoria = 'cliente' or i.estado_vinculo = 'cliente_nuevo')", poner: "  select (i.categoria = 'cliente')" },
  { nombre: "recepción: un \"no es cliente\" que venía con un cliente sigue como \"cliente de un cliente\"", prueba: "recepcion",
    espera: "\"Es cliente nuevo\" cuenta como cliente",
    buscar: "case when i.categoria in ('cliente', 'cliente_de_cliente') and i.estado_vinculo = 'no_cliente'", poner: "case when i.categoria = 'cliente' and i.estado_vinculo = 'no_cliente'" },
  { nombre: "recepción: el tablero devuelve el token de las altas", prueba: "recepcion",
    espera: "cifras de hoy",
    buscar: "               'id',        i.id,", poner: "               'id',        i.id, 'token', i.token," },
  { nombre: "recepción: un CUIT escrito en la búsqueda no se busca como CUIT", prueba: "recepcion",
    espera: "por CUIT (con guiones o sin)",
    buscar: "  if char_length(v_cuit_escrito) <> 11 then\n    v_cuit_escrito := null;", poner: "  if true then\n    v_cuit_escrito := null;" },
  { nombre: "recepción: un invitado se busca solo por cómo figura en la copia", prueba: "recepcion",
    espera: "un invitado de la lista sale una vez",
    buscar: "             i.busqueda || ' ' || coalesce(c.busqueda, '') as busqueda", poner: "             coalesce(c.busqueda, i.busqueda) as busqueda" },
  { nombre: "recepción: el buscador ofrece las altas de la puerta", prueba: "recepcion",
    espera: "las altas nunca",
    buscar: "       where i.origen = 'lista'\n    ),", poner: "    )," },
  { nombre: "recepción: un invitado que está en la copia sale dos veces", prueba: "recepcion",
    espera: "un invitado de la lista sale una vez",
    buscar: "         and not exists (select 1 from lista l where l.codigo_erp = c.codigo_erp)\n", poner: "" },
  { nombre: "recepción: la verificación no frena si a recepción le faltan funciones", verificacion: true, prueba: "seguridad",
    espera: "la verificación de la migración frena",
    buscar: "    raise exception 'VERIFICACIÓN: a recepción le faltan funciones (la pantalla no andaría): %', hay;", poner: "" },
  { nombre: "página: lo renovado se guarda aunque hayan tocado Salir", archivo: 'index', prueba: "recepcion-pantalla",
    espera: "mientras se renueva la sesión",
    buscar: "      if (!ahora || ahora.email !== s.email) {", poner: "      if (false) {" },
  { nombre: "página: Salir cierra la sesión en todos lados (también en pedidos)", archivo: 'index', prueba: "recepcion-pantalla",
    espera: "no es admin",
    buscar: "/auth/v1/logout?scope=local`", poner: "/auth/v1/logout`" },
  { nombre: "página: al caerse la sesión la hoja queda abierta", archivo: 'index', prueba: "recepcion-pantalla",
    espera: "con la hoja abierta",
    buscar: "  cerrarHojas();\n  pantallaLogin(mensaje);", poner: "  pantallaLogin(mensaje);" },
  { nombre: "página: mientras vincula se puede cambiar de opción", archivo: 'index', prueba: "recepcion-pantalla",
    espera: "la hoja queda quieta",
    buscar: "  v.dlg.querySelectorAll(\"input, button\").forEach(x => { x.disabled = quieta; });\n", poner: "" },
  { nombre: "página: Escape cierra la hoja mientras guarda", archivo: 'index', prueba: "recepcion-pantalla",
    espera: "la hoja queda quieta",
    buscar: "  dlg.addEventListener(\"cancel\", e => { if (v.ocupado) e.preventDefault(); });\n", poner: "" },
  { nombre: "página: una actualización vieja pisa la nueva", archivo: 'index', prueba: "recepcion-pantalla",
    espera: "llega tarde no pisa",
    buscar: "  const vigente = () => rec === yo && vistaN === yo.vista && n === yo.pedido;", poner: "  const vigente = () => rec === yo && vistaN === yo.vista;" },
  { nombre: "página: el filtro por vendedor sigue en el celular", archivo: 'index', prueba: "recepcion-pantalla",
    espera: "el filtro por vendedor es de escritorio",
    buscar: "f => !ancha || !rec.vendedor || f.vendedor === rec.vendedor", poner: "f => !rec.vendedor || f.vendedor === rec.vendedor" },
  { nombre: "página: la renovación de sesión no tiene tope de tiempo", archivo: 'index', prueba: "recepcion-pantalla",
    espera: "no contesta",
    buscar: "      body: JSON.stringify(cuerpo),\n      signal: ctrl.signal,", poner: "      body: JSON.stringify(cuerpo)," },
  { nombre: "página: al abrir la hoja el foco no va a la búsqueda", archivo: 'index', prueba: "recepcion-pantalla",
    espera: "busca en Finnegans por CUIT",
    buscar: "  if (mqAncha.matches) v.en(\"buscar\").focus();\n", poner: "" },
  { nombre: "página: antes del primer día dice que la expo \"sigue\"", archivo: 'index', prueba: "recepcion-pantalla",
    espera: "hoy no hay expo",
    buscar: "${d.dias[0] > d.hoy ? \"empieza\" : \"sigue\"}", poner: "sigue" },
  { nombre: "página: un mail largo se sale de costado", archivo: 'index', prueba: "recepcion-pantalla",
    espera: "con un mail largo",
    buscar: ";overflow-wrap:anywhere\">${escH(s ? s.email : \"\")}", poner: "\">${escH(s ? s.email : \"\")}" },
  { nombre: "página: la lista de clientes queda guardada en la compu", archivo: 'index', prueba: "recepcion-pantalla",
    espera: "nunca queda guardada",
    buscar: "    Object.assign(yo, { datos, vistoEn: Date.now(), fallo: false });", poner: "    Object.assign(yo, { datos, vistoEn: Date.now(), fallo: false });\n    guardarLocal(\"expoRecepcion\", { datos });" },
  { nombre: "página: la hoja deja elegido el primero aunque no coincida el CUIT", archivo: 'index', prueba: "recepcion-pantalla",
    espera: "no deja nada elegido",
    buscar: "  const seguro = filas[0].coincide_cuit ? filas[0].codigo_erp : null;", poner: "  const seguro = filas[0].codigo_erp;" },
  { nombre: "página: la hoja busca por la forma societaria", archivo: 'index', prueba: "recepcion-pantalla",
    espera: "no deja nada elegido",
    buscar: "filter(w => w.length >= 3 && !SOCIEDADES.has(w))", poner: "filter(w => w.length >= 3)" },
  { nombre: "página: la hoja busca con una sola letra", archivo: 'index', prueba: "recepcion-pantalla",
    espera: "menos de 2 letras",
    buscar: "  if (!alcanza) {\n", poner: "  if (false) {\n" },
  { nombre: "página: Google entra directo con la última cuenta", archivo: 'index', prueba: "recepcion-pantalla",
    espera: "deja elegir la cuenta",
    buscar: "  u.searchParams.set(\"prompt\", \"select_account\");", poner: "" },
  { nombre: "página: la × de la hoja se achica", archivo: 'index', prueba: "recepcion-pantalla",
    espera: "la × no se achica",
    buscar: ".mr-hoja-cerrar { flex: none; }", poner: "" },
  { nombre: "mosaico: en la compu, sin datos, no usa el mosaico", archivo: 'index', prueba: "recepcion-pantalla",
    espera: "afiche y mosaico",
    buscar: "    html: ancha\n      ? mosaico(", poner: "    html: false\n      ? mosaico(" },
  { nombre: "mosaico: el login de la compu no usa el mosaico", archivo: 'index', prueba: "recepcion-pantalla",
    espera: "afiche y mosaico",
    buscar: "  const vista = pintar(mqAncha.matches\n    ? pantalla({ datos: [\"Recepción\"], ancha: true, arriba: false, cuerpo: mosaico({ titulo: \"Entrá", poner: "  const vista = pintar(false\n    ? pantalla({ datos: [\"Recepción\"], ancha: true, arriba: false, cuerpo: mosaico({ titulo: \"Entrá" },
  { nombre: "mosaico: quedan dos \"Salir\"", archivo: 'index', prueba: "recepcion-pantalla",
    espera: "afiche y mosaico",
    buscar: ".mr-pantalla:has(.mosaico) .pie-salir { display: none; }", poner: "" },
  { nombre: "mosaico: con pocos datos faltan los bloques de marca", archivo: 'index', prueba: "recepcion-pantalla",
    espera: "afiche y mosaico",
    buscar: "BLOQUES_DE_MARCA.slice(0, Math.max(0, FICHAS_EN_EL_MOSAICO - datos.length))", poner: "[]" },
  { nombre: 'recorrido: cambiar la clave no invalida la vieja', prueba: 'recorrido',
    espera: 'la vieja deja de andar en el acto',
    buscar: `     set clave_equipo_hash = public.expo__hash_clave(clave)
   where estado <> 'cerrada';`, poner: `     set clave_equipo_hash = clave_equipo_hash
   where estado <> 'cerrada';` },
];

const NODE_TEST = ['--test', '--test-force-exit', '--test-timeout=60000'];

// Corre node con esos argumentos y variables; devuelve { status, stdout, stderr }.
// Si Windows no puede abrir el proceso (sin memoria por un momento), espera y
// reintenta: una corrida de una hora no se cae por eso. Y si un test se cuelga
// (el navegador que no contesta), lo corta a los TOPE_TEST_MS: no traba toda la corrida.
const TOPE_TEST_MS = 8 * 60 * 1000;
async function correr(args, env, intentos = 3) {
  for (let i = 1; ; i++) {
    const r = await new Promise((ok) => {
      let hijo;
      try {
        hijo = spawn(process.execPath, args, { cwd: RAIZ, env: { ...process.env, ...env } });
      } catch (e) {
        return ok({ status: null, stdout: '', stderr: String(e), noAbrio: true });
      }
      let stdout = '', stderr = '';
      hijo.stdout.on('data', (d) => { stdout += d; });
      hijo.stderr.on('data', (d) => { stderr += d; });
      const tope = setTimeout(() => { colgado = true; hijo.kill(); }, TOPE_TEST_MS);
      let colgado = false;
      hijo.on('error', (e) => { clearTimeout(tope); ok({ status: null, stdout, stderr: String(e), noAbrio: true }); });
      hijo.on('close', (status) => { clearTimeout(tope); ok({ status, stdout, stderr, colgado }); });
    });
    if (!r.noAbrio || i >= intentos) return r;
    await new Promise((ok) => setTimeout(ok, 10000));
  }
}

// ¿El SQL mutado carga? Si no carga, la mutación no prueba nada.
async function carga(env) {
  const db = pathToFileURL(join(RAIZ, 'test', 'db.mjs')).href;
  const r = await correr(['--input-type=module', '-e', `import { nuevaBase } from '${db}'; await nuevaBase();`], env);
  return r.status === 0 ? null : (r.stderr.match(/error: (.+)/i) || [])[1] || r.stderr.slice(0, 200);
}

// Una mutación: devuelve { resultado: '✓' | '✗' | '?', linea }.
async function probar(m, n) {
  const archivo = dondeMutar(m);
  if (typeof archivo === 'string') return { resultado: '?', linea: `?  ${m.nombre}: el texto aparece ${archivo} (tiene que ser 1)` };
  const esSql = !m.archivo || m.archivo === 'sql';
  const mutado = join(dir, `mutado-${n}` + (esSql ? '.sql' : m.archivo === 'sw' ? '.js' : '.html'));
  // con una función: un texto de reemplazo con $$ (cierre de función SQL) se
  // volvería $ si se pasara como string
  writeFileSync(mutado, archivo.original.replace(m.buscar, () => m.poner));
  // Los bloques de VERIFICACIÓN frenan la migración si algo quedó abierto: se
  // sacan para medir a los tests, salvo cuando lo mutado es uno de ellos.
  const env = { [archivo.variable]: mutado };
  if (esSql) {
    env.EXPO_SQL_ARCHIVO = basename(archivo.ruta);
    if (!m.verificacion) env.EXPO_SIN_VERIFICACION = '1';
  }

  const error = esSql ? await carga(env) : null;
  if (error) return { resultado: '?', linea: `?  ${m.nombre}: el SQL mutado no carga (${error.trim()})` };

  const r = await correr([...NODE_TEST, `test/${m.prueba}.test.mjs`], env);
  if (r.noAbrio) return { resultado: '?', linea: `?  ${m.nombre}: no se pudo correr el test (${r.stderr.trim()}); probá con --retomar` };
  if (r.colgado) return { resultado: '?', linea: `?  ${m.nombre}: el test se colgó y se cortó a los ${TOPE_TEST_MS / 60000} min; probá con --retomar` };
  const fallaron = [...r.stdout.matchAll(/✖ (.+?) \(\d/g)].map((x) => x[1]);
  if (fallaron.some((t) => t.includes(m.espera))) return { resultado: '✓', linea: `✓  ${m.nombre}` };
  if (r.status === 0) return { resultado: '✗', linea: `✗  SOBREVIVIÓ  ${m.nombre}` };
  return { resultado: '✗', linea: `✗  SOBREVIVIÓ  ${m.nombre}: falló otro test y no "${m.espera}" (${fallaron.join(' | ') || 'sin detalle'})` };
}

const argumentos = process.argv.slice(2);
const retomar = argumentos.includes('--retomar');
const filtro = argumentos.find((a) => a !== '--retomar');
const LOG = join(RAIZ, '.mutacion.log');   // una línea JSON por mutación terminada (no va al repo)

const yaAtrapadas = new Set();
if (retomar && existsSync(LOG)) {
  for (const l of readFileSync(LOG, 'utf8').split('\n').filter(Boolean)) {
    const x = JSON.parse(l);
    if (x.resultado === '✓') yaAtrapadas.add(x.nombre);
  }
} else {
  writeFileSync(LOG, '');
}

const pendientes = MUTACIONES.filter((x) => (!filtro || x.nombre.includes(filtro)) && !yaAtrapadas.has(x.nombre));
if (yaAtrapadas.size) console.log(`Retomando: ${yaAtrapadas.size} ya atrapadas, faltan ${pendientes.length}.`);
const dir = mkdtempSync(join(tmpdir(), 'expo-mutacion-'));
let sobrevivieron = 0, rotas = 0;

for (const [n, m] of pendientes.entries()) {
  const { resultado, linea } = await probar(m, n);
  console.log(linea);
  appendFileSync(LOG, JSON.stringify({ nombre: m.nombre, resultado, linea }) + '\n');
  if (resultado === '✗') sobrevivieron++;
  if (resultado === '?') rotas++;
}

rmSync(dir, { recursive: true, force: true });
console.log(`\n${sobrevivieron} sobrevivieron, ${rotas} sin aplicar` + (yaAtrapadas.size ? ` (más ${yaAtrapadas.size} ya atrapadas antes).` : '.'));
process.exit(sobrevivieron || rotas ? 1 : 0);
