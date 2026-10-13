-- ============================================================
--  EXPO · MIGRACIÓN v02 — recepción en vivo
--  Se corre en Supabase -> SQL Editor, DESPUÉS de la v01 y ANTES de
--  publicar el index.html que la usa.
--  Es idempotente: se puede correr dos veces sin problema.
-- ============================================================
--
-- QUÉ HACE
-- Agrega las dos funciones que usa la pantalla de recepción (con login de
-- Google, solo admins), más una interna (expo__es_cliente) para las cifras:
-- · expo_recepcion(): todo lo del día en una sola llamada (las cifras, quién
--   tenía turno y no llegó, las altas sin código y los no clientes).
-- · expo_buscar_cliente(): "¿Quién es en Finnegans?" al vincular un alta.
--
-- QUÉ NO TOCA
-- Ninguna tabla (ni de pedidos ni expo_). Las dos funciones solo leen.
--
-- LA FRONTERA
-- Las dos chequean es_admin() adentro y solo las puede ejecutar un usuario
-- logueado; el anónimo no. Lo controla la VERIFICACIÓN del final.
-- ============================================================


-- ------------------------------------------------------------
-- 0. Requisito: la v01
-- ------------------------------------------------------------
do $$
begin
  if to_regprocedure('public.expo_vincular(uuid, text)') is null then
    raise exception 'Falta la migración v01: corré primero sql/expo-migracion-v01.sql.';
  end if;
end
$$;


-- ------------------------------------------------------------
-- 1. ¿Es cliente? (para las cifras)
-- ------------------------------------------------------------
-- Cuenta como cliente quien está en la categoría cliente, o quien recepción
-- marcó "Es cliente nuevo" (aunque haya dicho que venía con un cliente), y
-- no fue marcado "No es cliente". Los demás (comex, proveedor, licencia,
-- quien vino con un cliente) quedan fuera de las cifras.
create or replace function public.expo__es_cliente(i public.expo_invitados)
returns boolean
language sql
immutable
set search_path = public
as $$
  select (i.categoria = 'cliente' or i.estado_vinculo = 'cliente_nuevo')
         and coalesce(i.estado_vinculo, 'pendiente') <> 'no_cliente'
$$;


-- ------------------------------------------------------------
-- 2. Recepción en vivo
-- ------------------------------------------------------------
-- Todo lo de hoy de la expo abierta. Las horas de los turnos van como
-- vienen ("09:00:00"): "atrasado" o "en su turno" lo decide la pantalla con
-- su reloj, que se actualiza sola.
create or replace function public.expo_recepcion()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  e    public.expo_ediciones;
  hoy  date := public.expo_hoy();
  ayer date;
begin
  if not public.es_admin() then
    raise exception 'expo_solo_admin';
  end if;

  select * into e from public.expo_ediciones where estado <> 'cerrada';
  if not found then
    return jsonb_build_object('estado', 'sin_edicion', 'hoy', hoy);
  end if;

  -- el último día de expo antes de hoy ("Ayer · martes 14")
  select max(d) into ayer from unnest(e.dias) d where d < hoy;

  return jsonb_build_object(
    'estado',        e.estado,
    'anio',          e.anio,
    'dias',          (select jsonb_agg(d order by d) from unnest(e.dias) d),
    'hoy',           hoy,
    'es_dia',        hoy = any (e.dias),
    'hora_apertura', e.hora_apertura,

    'cifras', (
      select jsonb_build_object(
               'clientes',             count(*) filter (where c),
               'personas',             coalesce(sum(v.cantidad) filter (where c), 0),
               'sin_turno',            count(*) filter (where c and t.id is null),
               'no_clientes',          count(*) filter (where not c),
               'no_clientes_personas', coalesce(sum(v.cantidad) filter (where not c), 0))
        from public.expo_visitas v
        join public.expo_invitados i on i.id = v.invitado_id
        left join public.expo_turnos t on t.invitado_id = i.id and t.dia = v.dia
        cross join lateral (select public.expo__es_cliente(i) as c) x
       where i.edicion_id = e.id
         and v.dia = hoy),

    'con_turno', (
      select count(*)
        from public.expo_turnos t
        join public.expo_invitados i on i.id = t.invitado_id
       where i.edicion_id = e.id
         and t.dia = hoy),

    -- tenían turno hoy y no llegaron (también los de más tarde)
    'faltantes', coalesce((
      select jsonb_agg(jsonb_build_object(
               'invitado_id',  i.id,
               'razon_social', i.razon_social,
               'localidad',    i.localidad,
               'zona',         i.zona,
               'vendedor',     i.vendedor,
               'desde',        t.desde,
               'hasta',        t.hasta)
             order by t.desde, t.hasta, i.razon_social)
        from public.expo_turnos t
        join public.expo_invitados i on i.id = t.invitado_id
       where i.edicion_id = e.id
         and t.dia = hoy
         and not exists (select 1 from public.expo_visitas v
                          where v.invitado_id = i.id and v.dia = hoy)), '[]'::jsonb),

    -- altas de la puerta que esperan que recepción diga quién son (de
    -- cualquier día: sin código no entran en el cruce con facturación)
    'altas', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id',        i.id,
               'empresa',   coalesce(i.alta_empresa, i.razon_social),
               'nombre',    i.alta_nombre,
               'categoria', i.categoria,
               'cuit',      i.alta_cuit,
               'dia',       pv.dia,
               'llegada',   pv.llegada,
               'cantidad',  pv.cantidad)
             order by pv.llegada desc nulls last)
        from public.expo_invitados i
        left join lateral (
               select v.dia, v.llegada, v.cantidad
                 from public.expo_visitas v
                where v.invitado_id = i.id
                order by v.llegada
                limit 1) pv on true
       where i.edicion_id = e.id
         and i.origen = 'alta_puerta'
         and i.estado_vinculo = 'pendiente'), '[]'::jsonb),

    -- no clientes de hoy, por categoría
    'no_clientes', coalesce((
      select jsonb_agg(jsonb_build_object('categoria', categoria, 'cantidad', n, 'personas', p)
                       order by n desc, categoria)
        -- quien dijo ser cliente (o venir con uno) y recepción marcó "No es
        -- cliente" va como no_cliente; comex, proveedor y licencia, con lo suyo
        from (select case when i.categoria in ('cliente', 'cliente_de_cliente') and i.estado_vinculo = 'no_cliente'
                          then 'no_cliente' else i.categoria end as categoria,
                     count(*) as n, sum(v.cantidad) as p
                from public.expo_visitas v
                join public.expo_invitados i on i.id = v.invitado_id
               where i.edicion_id = e.id
                 and v.dia = hoy
                 and not public.expo__es_cliente(i)
               group by 1) g), '[]'::jsonb),

    -- "Antes de abrir": cómo fue el último día
    'ayer', case when ayer is null then null else (
      select jsonb_build_object(
               'dia',      ayer,
               'clientes', count(*) filter (where public.expo__es_cliente(i)),
               'personas', coalesce(sum(v.cantidad) filter (where public.expo__es_cliente(i)), 0))
        from public.expo_visitas v
        join public.expo_invitados i on i.id = v.invitado_id
       where i.edicion_id = e.id
         and v.dia = ayer) end);
end
$$;


-- ------------------------------------------------------------
-- 3. "¿Quién es en Finnegans?" (vincular un alta)
-- ------------------------------------------------------------
-- Busca en la lista de invitados de la expo abierta y en la copia de
-- clientes de Finnegans (un código, una sola vez; de los invitados se busca
-- también por cómo figuran en la lista, aunque en la copia estén con otro
-- nombre o dados de baja). Por CUIT (el que cargó la persona, p_cuit, o uno
-- escrito en la búsqueda) y por nombre o código. Máximo 8; primero los que
-- coinciden por CUIT.
create or replace function public.expo_buscar_cliente(p_texto text, p_cuit text default null)
returns table (codigo_erp text, razon_social text, localidad text, zona text, vendedor text,
               coincide_cuit boolean)
language plpgsql
stable
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  -- con v_ adelante: no se confunden con las columnas (use_column)
  v_q     text := public.expo_normalizar(left(p_texto, 80));
  v_cuit  text := regexp_replace(coalesce(left(p_cuit, 20), ''), '[^0-9]', '', 'g');
  v_cuit_escrito text := regexp_replace(coalesce(left(p_texto, 80), ''), '[^0-9]', '', 'g');   -- un CUIT tipeado en la búsqueda
begin
  if not public.es_admin() then
    raise exception 'expo_solo_admin';
  end if;
  if char_length(v_cuit) <> 11 then
    v_cuit := null;
  end if;
  if char_length(v_cuit_escrito) <> 11 then
    v_cuit_escrito := null;
  end if;
  if char_length(replace(v_q, ' ', '')) < 2 and v_cuit is null and v_cuit_escrito is null then
    return;
  end if;

  return query
    with lista as (
      -- los invitados de la expo abierta, con los datos de Finnegans si están en la copia
      select i.codigo_erp,
             coalesce(c.razon_social, i.razon_social) as razon_social,
             coalesce(c.localidad, i.localidad)       as localidad,
             coalesce(c.zona, i.zona)                 as zona,
             coalesce(c.vendedor, i.vendedor)         as vendedor,
             c.cuit,
             i.busqueda || ' ' || coalesce(c.busqueda, '') as busqueda
        from public.expo_invitados i
        join public.expo_ediciones e on e.id = i.edicion_id and e.estado <> 'cerrada'
        left join public.expo_clientes c on c.codigo_erp = i.codigo_erp
       where i.origen = 'lista'
    ),
    candidatos as (
      select * from lista
      union all
      -- los clientes activos de Finnegans que no están en la lista
      select c.codigo_erp, c.razon_social, c.localidad, c.zona, c.vendedor, c.cuit, c.busqueda
        from public.expo_clientes c
       where c.activo
         and not exists (select 1 from lista l where l.codigo_erp = c.codigo_erp)
    )
    select k.codigo_erp, k.razon_social, k.localidad, k.zona, k.vendedor,
           coalesce(k.cuit in (v_cuit, v_cuit_escrito), false)
      from candidatos k
     where k.cuit in (v_cuit, v_cuit_escrito)
        or (char_length(replace(v_q, ' ', '')) >= 2
            and not exists (
                  select 1 from unnest(string_to_array(v_q, ' ')) p
                   where strpos(k.busqueda, p) = 0))
     order by coalesce(k.cuit in (v_cuit, v_cuit_escrito), false) desc,
              strpos(k.busqueda, v_q) = 1 desc,
              k.razon_social
     limit 8;
end
$$;


-- ------------------------------------------------------------
-- 4. Permisos
--    Supabase le da EXECUTE a anon y authenticated sobre toda función nueva:
--    se le saca a las de esta migración y se le da solo a un logueado
--    (adentro chequean es_admin()).
-- ------------------------------------------------------------
revoke all on function public.expo__es_cliente(public.expo_invitados) from public, anon, authenticated;
revoke all on function public.expo_recepcion()                        from public, anon, authenticated;
revoke all on function public.expo_buscar_cliente(text, text)         from public, anon, authenticated;

grant execute on function public.expo_recepcion()                to authenticated;
grant execute on function public.expo_buscar_cliente(text, text) to authenticated;

-- Que PostgREST vea las funciones nuevas sin esperar.
notify pgrst, 'reload schema';


-- ============================================================
--  VERIFICACIÓN
--  El SQL Editor de Supabase muestra solo el resultado de la ÚLTIMA consulta.
--  Por eso los controles van en un bloque que FRENA la migración entera si
--  algo quedó abierto (todo corre en una sola transacción: no queda nada a
--  medias), y al final hay una sola fila con el resumen.
-- ============================================================
do $verificacion$
declare
  -- lo único que el anónimo puede ejecutar: las de la sección 7 de la v01
  publicas text[] := array[
    'expo_alta_rapida', 'expo_anotarme', 'expo_bajarme', 'expo_buscar', 'expo_confirmar',
    'expo_corregir_cantidad', 'expo_equipo_lista', 'expo_presentes', 'expo_registrar_visita',
    'expo_tome_pedido', 'expo_ver_invitado'];
  -- la única interna que puede ejecutar un logueado: la usa expo_hoy (v01)
  internas_logueado text[] := array['expo__dia_ar'];
  -- las de recepción (un logueado; adentro chequean es_admin()). Volver a
  -- correr la v01 se las saca: hay que correr después la v02.
  de_recepcion text[] := array[
    'expo_buscar_cliente', 'expo_marcar_alta', 'expo_nueva_clave_cartel', 'expo_nueva_clave_equipo',
    'expo_recepcion', 'expo_vincular'];
  hay text;
begin
  select string_agg(c.relname, ', ') into hay
    from pg_class c
   where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
     and c.relname like 'expo\_%' and not c.relrowsecurity;
  if hay is not null then
    raise exception 'VERIFICACIÓN: tablas sin RLS: %', hay;
  end if;

  select string_agg(c.relname, ', ') into hay
    from pg_class c
   where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
     and c.relname like 'expo\_%'
     and has_table_privilege('anon', c.oid, 'select, insert, update, delete, truncate, references, trigger');
  if hay is not null then
    raise exception 'VERIFICACIÓN: el anónimo puede tocar estas tablas: %', hay;
  end if;

  select string_agg(c.relname, ', ') into hay
    from pg_class c
   where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
     and c.relname like 'expo\_%'
     and has_table_privilege('authenticated', c.oid, 'truncate, references, trigger');
  if hay is not null then
    raise exception 'VERIFICACIÓN: un usuario logueado puede vaciar estas tablas: %', hay;
  end if;

  select string_agg(p.proname, ', ') into hay
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace and p.proname like 'expo\_%'
     and has_function_privilege('anon', p.oid, 'execute')
     and p.proname <> all (publicas);
  if hay is not null then
    raise exception 'VERIFICACIÓN: el anónimo puede ejecutar funciones que no son públicas: %', hay;
  end if;

  select string_agg(f, ', ') into hay
    from unnest(publicas) f
   where not exists (select 1 from pg_proc p
                      where p.pronamespace = 'public'::regnamespace and p.proname = f
                        and has_function_privilege('anon', p.oid, 'execute'));
  if hay is not null then
    raise exception 'VERIFICACIÓN: al anónimo le faltan funciones (la app no andaría): %', hay;
  end if;

  select string_agg(p.proname, ', ') into hay
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace and p.proname like 'expo\_\_%'
     and has_function_privilege('authenticated', p.oid, 'execute')
     and p.proname <> all (internas_logueado);
  if hay is not null then
    raise exception 'VERIFICACIÓN: un usuario logueado puede ejecutar funciones internas: %', hay;
  end if;

  select string_agg(f, ', ') into hay
    from unnest(de_recepcion) f
   where not exists (select 1 from pg_proc p
                      where p.pronamespace = 'public'::regnamespace and p.proname = f
                        and has_function_privilege('authenticated', p.oid, 'execute'));
  if hay is not null then
    raise exception 'VERIFICACIÓN: a recepción le faltan funciones (la pantalla no andaría): %', hay;
  end if;
end
$verificacion$;

-- Lo único que muestra el SQL Editor. Si llegó hasta acá, pasó los controles.
select 'listo: expo v02 verificada' as resultado,
       (select count(*) from pg_class c
         where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
           and c.relname like 'expo\_%' and c.relrowsecurity) as tablas_con_rls,
       (select count(*) from pg_proc p
         where p.pronamespace = 'public'::regnamespace and p.proname like 'expo\_%'
           and has_function_privilege('anon', p.oid, 'execute')) as funciones_del_anonimo;
