// Prueba de mutación: saca (o afloja) cada línea que protege algo y verifica
// que el test que la cuida se dé cuenta. Si una mutación "sobrevive", ese
// test no sirve.
//
//   npm run mutacion                 todas
//   npm run mutacion -- vincular     solo las que tengan "vincular" en el nombre
//
// Para que una mutación cuente como atrapada no alcanza con que "algo falle":
// · el texto a mutar tiene que aparecer UNA sola vez en la última migración
//   (si el SQL cambió y ya no está, se avisa en vez de pasar en silencio);
// · el SQL mutado tiene que cargar (si no carga, fallaría todo y no probaría
//   nada);
// · y entre los tests que fallan tiene que estar el de "espera".
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { archivosMigracion } from './db.mjs';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');

// Se muta la última migración; las anteriores corren tal cual (ver db.mjs).
const ARCHIVO = archivosMigracion().at(-1);
const ORIGINAL = readFileSync(ARCHIVO, 'utf8');

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
    buscar: `     limit 8;`, poner: `     limit 80;` },
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
  { nombre: 'recorrido: cambiar la clave no invalida la vieja', prueba: 'recorrido',
    espera: 'la vieja deja de andar en el acto',
    buscar: `     set clave_equipo_hash = public.expo__hash_clave(clave)
   where estado <> 'cerrada';`, poner: `     set clave_equipo_hash = clave_equipo_hash
   where estado <> 'cerrada';` },
];

const NODE_TEST = ['--test', '--test-force-exit', '--test-timeout=60000'];

// ¿El SQL mutado carga? Si no carga, la mutación no prueba nada.
function carga(sql) {
  const db = pathToFileURL(join(RAIZ, 'test', 'db.mjs')).href;
  const r = spawnSync(process.execPath,
    ['--input-type=module', '-e', `import { nuevaBase } from '${db}'; await nuevaBase();`],
    { cwd: RAIZ, env: { ...process.env, EXPO_SQL: sql }, encoding: 'utf8' });
  return r.status === 0 ? null : (r.stderr.match(/error: (.+)/i) || [])[1] || r.stderr.slice(0, 200);
}

const filtro = process.argv[2];
const dir = mkdtempSync(join(tmpdir(), 'expo-mutacion-'));
let sobrevivieron = 0, rotas = 0;

for (const m of MUTACIONES.filter((x) => !filtro || x.nombre.includes(filtro))) {
  const veces = ORIGINAL.split(m.buscar).length - 1;
  if (veces !== 1) {
    console.log(`?  ${m.nombre}: el texto aparece ${veces} veces en ${basename(ARCHIVO)} (tiene que ser 1)`);
    rotas++;
    continue;
  }
  const mutado = join(dir, 'mutado.sql');
  // con una función: un texto de reemplazo con $$ (cierre de función SQL) se
  // volvería $ si se pasara como string
  writeFileSync(mutado, ORIGINAL.replace(m.buscar, () => m.poner));

  const error = carga(mutado);
  if (error) {
    console.log(`?  ${m.nombre}: el SQL mutado no carga (${error.trim()})`);
    rotas++;
    continue;
  }

  const r = spawnSync(process.execPath, [...NODE_TEST, `test/${m.prueba}.test.mjs`],
    { cwd: RAIZ, env: { ...process.env, EXPO_SQL: mutado }, encoding: 'utf8' });
  const fallaron = [...r.stdout.matchAll(/✖ (.+?) \(\d/g)].map((x) => x[1]);
  if (fallaron.some((t) => t.includes(m.espera))) {
    console.log(`✓  ${m.nombre}`);
  } else if (r.status === 0) {
    console.log(`✗  SOBREVIVIÓ  ${m.nombre}`);
    sobrevivieron++;
  } else {
    console.log(`✗  SOBREVIVIÓ  ${m.nombre}: falló otro test y no "${m.espera}" (${fallaron.join(' | ') || 'sin detalle'})`);
    sobrevivieron++;
  }
}

rmSync(dir, { recursive: true, force: true });
console.log(`\n${sobrevivieron} sobrevivieron, ${rotas} sin aplicar.`);
process.exit(sobrevivieron || rotas ? 1 : 0);
