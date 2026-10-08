-- ============================================================
--  EXPO · MIGRACIÓN v01 — tablas, RLS y funciones de la recepción
--  Se corre en Supabase -> SQL Editor, ANTES de publicar el index.html.
--  Es idempotente: se puede correr dos veces sin problema.
-- ============================================================
--
-- QUÉ HACE
-- Crea las tablas expo_* de la recepción de la expo, les prende el RLS y
-- define las funciones que llama la app.
--
-- QUÉ NO TOCA
-- Ninguna tabla de pedidos. Usa public.es_admin() de la app de pedidos tal
-- como está (decide contra el mail del JWT); no la redefine.
--
-- LA FRONTERA
-- · El anónimo NO lee ni escribe ninguna tabla. Solo llama funciones, que
--   devuelven solo lo que muestra la pantalla.
-- · Cliente: entra con el token de su link (expo_ver_invitado,
--   expo_confirmar, expo_registrar_visita, expo_corregir_cantidad).
-- · Cartel de la entrada (decidido el 06/10): el QR impreso lleva una clave
--   del cartel. Sin ella no se busca ni se da de alta (expo_buscar,
--   expo_alta_rapida). Así nadie, desde afuera, saca el link personal de un
--   cliente buscándolo por nombre ni traba las altas del día.
-- · Equipo de recorrido (decidido el 06/10: opción A): un link con una clave
--   que el celular recuerda. Con la clave se ve la lista del equipo y los
--   presentes del día, y se anota, se baja o marca "Tomé el pedido"; nada más.
-- · Las dos claves: la base guarda solo su hash, valen para una edición y
--   recepción las cambia cuando quiera (la vieja deja de andar en el acto; la
--   del cartel obliga a reimprimir el QR).
-- · Recepción e informe: usuario de Supabase con es_admin().
--
-- OJO CON SUPABASE
-- Supabase le da EXECUTE a anon y authenticated sobre toda función nueva del
-- esquema public, y PostgREST expone toda función de public como /rpc. Por eso
-- al final se le saca el permiso a TODAS las funciones expo_* y se lo devuelve
-- una por una solo a las que tienen que ser públicas.
-- ============================================================


-- ------------------------------------------------------------
-- 0. Requisito: es_admin() de la app de pedidos
-- ------------------------------------------------------------
do $$
begin
  if to_regprocedure('public.es_admin()') is null then
    raise exception 'Falta public.es_admin(): esta base no es la de la app de pedidos.';
  end if;
end
$$;


-- ------------------------------------------------------------
-- 1. Ayudas
-- ------------------------------------------------------------

-- El día argentino de un momento. Supabase corre en UTC: a las 21 h de acá
-- en UTC ya es "mañana". Es el único lugar donde está la zona horaria.
create or replace function public.expo__dia_ar(t timestamptz)
returns date
language sql
stable
set search_path = public
as $$
  select (t at time zone 'America/Argentina/Buenos_Aires')::date
$$;

-- El día de hoy en Argentina.
create or replace function public.expo_hoy()
returns date
language sql
stable
set search_path = public
as $$
  select public.expo__dia_ar(now())
$$;

-- Cuántas personas se aceptan por visita o confirmación: de 1 a 30 (el "6+"
-- del contador sube hasta 30). Las columnas repiten el mismo rango en su check.
create or replace function public.expo__cantidad_valida(n integer)
returns boolean
language sql
immutable
set search_path = public
as $$
  select coalesce(n between 1 and 30, false)
$$;

-- Hash de la clave del link del equipo: la base guarda esto, nunca la clave.
create or replace function public.expo__hash_clave(clave text)
returns text
language sql
immutable
set search_path = public
as $$
  select encode(sha256(convert_to(clave, 'UTF8')), 'hex')
$$;

-- Espacios: Finnegans trae dobles y al principio.
create or replace function public.expo_espacios(t text)
returns text
language sql
immutable
set search_path = public
as $$
  select btrim(regexp_replace(t, '\s+', ' ', 'g'))
$$;

-- Para buscar: sin tildes, sin mayúsculas, sin puntos (S.R.L. = srl), y todo
-- lo que no es letra o número pasa a ser un espacio.
create or replace function public.expo_normalizar(t text)
returns text
language sql
immutable
set search_path = public
as $$
  select btrim(regexp_replace(regexp_replace(
           lower(translate(coalesce(t, ''),
             'ÁÀÄÂÃáàäâãÉÈËÊéèëêÍÌÏÎíìïîÓÒÖÔÕóòöôõÚÙÜÛúùüûÑñÇç',
             'aaaaaaaaaaeeeeeeeeiiiiiiiioooooooooouuuuuuuunncc')),
           '\.', '', 'g'),
         '[^a-z0-9]+', ' ', 'g'))
$$;


-- ------------------------------------------------------------
-- 2. Tablas
-- ------------------------------------------------------------

-- Una fila por expo. El estado lo cambia recepción a mano y es lo que decide
-- si el link del cliente dice "Confirmo que voy" o "Estoy acá".
create table if not exists public.expo_ediciones (
  id               bigint generated always as identity primary key,
  anio             smallint not null unique check (anio between 2020 and 2100),
  dias             date[]   not null check (cardinality(dias) between 1 and 7
                                           and array_position(dias, null) is null),
  estado           text     not null default 'previa'
                            check (estado in ('previa', 'en_curso', 'cerrada')),
  hora_apertura    time     not null default '09:00',  -- "Abre a las 9:00"
  dias_seguimiento smallint not null default 14         -- "día 6 de 14 desde el cierre"
                            check (dias_seguimiento between 1 and 90),
  -- sha256 de las claves de los links (las claves no se guardan):
  -- la del equipo de recorrido y la del QR impreso del cartel de la entrada
  clave_equipo_hash text    check (clave_equipo_hash ~ '^[0-9a-f]{64}$'),
  clave_cartel_hash text    check (clave_cartel_hash ~ '^[0-9a-f]{64}$'),
  creado_en        timestamptz not null default now()
);

-- Una sola expo abierta a la vez: el cartel busca en "la que está en curso".
create unique index if not exists expo_ediciones_una_abierta
  on public.expo_ediciones ((true)) where estado <> 'cerrada';


-- Copia de los clientes activos de Finnegans, para "Vincular" un alta: buscar
-- por CUIT o por nombre a alguien que puede no estar invitado. La carga el
-- script de importación. Solo la lee recepción.
create table if not exists public.expo_clientes (
  codigo_erp      text primary key check (codigo_erp ~ '^[0-9A-Za-z.-]{1,20}$'),
  razon_social    text not null check (char_length(razon_social) between 1 and 200),
  nombre_fantasia text check (char_length(nombre_fantasia) <= 120),
  cuit            text check (cuit ~ '^[0-9]{11}$'),
  zona            text check (char_length(zona) <= 60),
  localidad       text check (char_length(localidad) <= 80),
  vendedor        text check (char_length(vendedor) <= 80),
  activo          boolean not null default true,
  busqueda        text generated always as (public.expo_normalizar(
                    razon_social || ' ' || coalesce(nombre_fantasia, '') || ' ' || codigo_erp)) stored,
  actualizado_en  timestamptz not null default now()
);
create index if not exists expo_clientes_cuit on public.expo_clientes (cuit);


-- Un cliente invitado a una edición. También las altas de la puerta.
create table if not exists public.expo_invitados (
  id                  uuid primary key default gen_random_uuid(),
  edicion_id          bigint not null references public.expo_ediciones(id) on delete restrict,
  codigo_erp          text check (codigo_erp ~ '^[0-9A-Za-z.-]{1,20}$'),
  razon_social        text not null check (char_length(razon_social) between 1 and 200),
  nombre_fantasia     text check (char_length(nombre_fantasia) <= 120),
  nombre_credencial   text check (char_length(nombre_credencial) <= 40),
  zona                text check (char_length(zona) <= 60),
  localidad           text check (char_length(localidad) <= 80),
  vendedor            text check (char_length(vendedor) <= 80),
  categoria           text not null default 'cliente'
                      check (categoria in ('cliente', 'comex', 'proveedor', 'licencia', 'cliente_de_cliente')),
  -- Lo que va en el QR. 122 bits al azar (gen_random_uuid sin guiones).
  token               text not null unique
                      default replace(gen_random_uuid()::text, '-', '')
                      check (token ~ '^[0-9a-f]{32}$'),
  confirmado          boolean,                  -- null = no contestó
  confirmado_cantidad smallint check (confirmado_cantidad between 1 and 30),
  confirmado_en       timestamptz,
  origen              text not null default 'lista' check (origen in ('lista', 'alta_puerta')),
  -- Solo para las altas de la puerta:
  estado_vinculo      text check (estado_vinculo in ('pendiente', 'vinculada', 'cliente_nuevo', 'no_cliente')),
  alta_nombre         text check (char_length(alta_nombre) <= 80),   -- quién se registró
  alta_empresa        text check (char_length(alta_empresa) <= 120), -- lo que escribió, tal cual
  alta_cuit           text check (char_length(alta_cuit) <= 20),     -- "CUIT o código", tal cual
  alta_clave          uuid unique,              -- la genera el celular: un reintento no duplica el alta
  vinculado_a         uuid references public.expo_invitados(id),
  vinculado_por       text,                     -- mail de quien vinculó
  vinculado_en        timestamptz,
  busqueda            text generated always as (public.expo_normalizar(
                        razon_social || ' ' || coalesce(nombre_fantasia, '') || ' ' || coalesce(codigo_erp, ''))) stored,
  creado_en           timestamptz not null default now(),

  constraint expo_invitados_codigo_obligatorio
    check (codigo_erp is not null or origen = 'alta_puerta'),
  constraint expo_invitados_vinculo_solo_altas
    check ((origen = 'alta_puerta') = (estado_vinculo is not null)),
  constraint expo_invitados_vinculada_dice_quien
    check (estado_vinculo is distinct from 'vinculada'
           or (vinculado_por is not null and vinculado_en is not null)),
  constraint expo_invitados_cantidad_solo_si_va
    check (confirmado is true or confirmado_cantidad is null)
);

-- El código es la llave del cruce con facturación: uno por edición.
create unique index if not exists expo_invitados_codigo_unico
  on public.expo_invitados (edicion_id, codigo_erp) where codigo_erp is not null;
create index if not exists expo_invitados_edicion on public.expo_invitados (edicion_id);


-- Turno: uno por día por invitado.
create table if not exists public.expo_turnos (
  id          bigint generated always as identity primary key,
  invitado_id uuid not null references public.expo_invitados(id) on delete cascade,
  dia         date not null,
  desde       time not null,
  hasta       time not null,
  constraint expo_turnos_horario     check (desde < hasta),
  constraint expo_turnos_uno_por_dia unique (invitado_id, dia)
);


-- Una fila por visita. Venir otro día es otra visita; el mismo día, no:
-- se corrige la cantidad.
create table if not exists public.expo_visitas (
  id           uuid primary key default gen_random_uuid(),
  invitado_id  uuid not null references public.expo_invitados(id) on delete restrict,
  dia          date not null,
  llegada      timestamptz not null default now(),
  cantidad     smallint not null check (cantidad between 1 and 30),
  sin_senal    boolean not null default false,  -- se guardó en el celular y llegó después
  creado_en    timestamptz not null default now(),
  corregido_en timestamptz,
  constraint expo_visitas_una_por_dia unique (invitado_id, dia)
);
create index if not exists expo_visitas_dia on public.expo_visitas (dia, llegada desc);


-- Las ~30 personas del recorrido. NO son los vendedores.
create table if not exists public.expo_equipo (
  id        uuid primary key default gen_random_uuid(),
  nombre    text not null check (char_length(nombre) between 2 and 60),
  rol       text not null constraint expo_equipo_rol check (rol in ('hostess', 'marketing')),
  activo    boolean not null default true,
  creado_en timestamptz not null default now()
);
-- "Sofía Giménez" y "sofia gimenez" son la misma persona: no se carga dos veces.
create unique index if not exists expo_equipo_nombre_unico
  on public.expo_equipo (public.expo_normalizar(nombre));


-- Quién del equipo le hizo el recorrido a una visita. Pueden ser varios.
-- "Lo atiende su vendedor" es NO tener filas acá: no hay columna de texto
-- donde escribirlo, y equipo_id solo apunta a hostess o marketing.
-- tomo_pedido: alguien del equipo (no el vendedor) tomó el pedido con el
-- usuario del vendedor. El cruce con facturación se lo atribuye al vendedor;
-- esto dice quién lo tomó de verdad. Si lo tomó el vendedor, queda en false.
create table if not exists public.expo_recorridos (
  visita_id   uuid not null references public.expo_visitas(id) on delete cascade,
  equipo_id   uuid not null references public.expo_equipo(id) on delete restrict,
  tomo_pedido boolean not null default false,
  creado_en   timestamptz not null default now(),
  primary key (visita_id, equipo_id)
);


-- Cuando vincular une dos visitas del mismo día, la del alta se borra. Esto
-- recuerda a cuál fue a parar, para que un "Me anoto" que quedó en la cola
-- sin señal con la visita vieja no se pierda.
create table if not exists public.expo_visitas_fusion (
  vieja uuid primary key,
  nueva uuid not null references public.expo_visitas(id) on delete cascade
);


-- Primera factura de cada cliente después del cierre. La escribe
-- scripts/cruce_facturacion.py con la service key.
create table if not exists public.expo_facturacion (
  edicion_id      bigint not null references public.expo_ediciones(id),
  codigo_erp      text   not null,
  primera_factura date   not null,
  actualizado_en  timestamptz not null default now(),
  primary key (edicion_id, codigo_erp)
);

-- Cada corrida del cruce, salga bien o mal: de acá sale "Facturación de
-- Finnegans al mar 06/10, 9:10" y el aviso "No se pudo leer la facturación".
create table if not exists public.expo_cruces (
  id         bigint generated always as identity primary key,
  edicion_id bigint not null references public.expo_ediciones(id),
  corrido_en timestamptz not null default now(),
  ok         boolean not null,
  facturas   integer,
  clientes   integer,
  error      text check (char_length(error) <= 500)
);


-- ------------------------------------------------------------
-- 3. El día de turnos y visitas tiene que ser un día de la expo
-- ------------------------------------------------------------
create or replace function public.expo__validar_dia()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1
      from public.expo_invitados i
      join public.expo_ediciones e on e.id = i.edicion_id
     where i.id = new.invitado_id
       and new.dia = any (e.dias)
  ) then
    raise exception 'expo_dia_fuera_de_la_expo';
  end if;
  return new;
end
$$;

drop trigger if exists expo_turnos_dia on public.expo_turnos;
create trigger expo_turnos_dia
  before insert or update of dia, invitado_id on public.expo_turnos
  for each row execute function public.expo__validar_dia();

drop trigger if exists expo_visitas_dia on public.expo_visitas;
create trigger expo_visitas_dia
  before insert or update of dia, invitado_id on public.expo_visitas
  for each row execute function public.expo__validar_dia();


-- ------------------------------------------------------------
-- 4. Row Level Security
--    Anónimo: nada (ni política ni permiso). Recepción: es_admin().
-- ------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array[
    'expo_ediciones', 'expo_clientes', 'expo_invitados', 'expo_turnos',
    'expo_visitas', 'expo_visitas_fusion', 'expo_equipo', 'expo_recorridos',
    'expo_facturacion', 'expo_cruces'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon', t);
    -- el RLS no frena un TRUNCATE: que recepción tampoco lo tenga
    execute format('revoke truncate, references, trigger on public.%I from authenticated', t);
    execute format('drop policy if exists %I on public.%I', t || '_admin', t);
    execute format(
      'create policy %I on public.%I for all to authenticated
         using (public.es_admin()) with check (public.es_admin())',
      t || '_admin', t);
  end loop;
end
$$;


-- ------------------------------------------------------------
-- 5. Funciones del cliente (por token) y del cartel (anónimas)
--    Errores: el mensaje es un código (expo_...) que la app traduce.
-- ------------------------------------------------------------

-- Interna: el invitado de un token. Si era un alta ya vinculada, devuelve el
-- cliente con el que se unió. NO es pública (devuelve la fila entera).
create or replace function public.expo__por_token(p_token text)
returns public.expo_invitados
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  i public.expo_invitados;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{32}$' then
    return null;
  end if;
  select * into i from public.expo_invitados where token = p_token;
  if found and i.vinculado_a is not null then
    select * into i from public.expo_invitados where id = i.vinculado_a;
  end if;
  return i;
end
$$;


-- Pantalla 1: qué mostrar. Devuelve solo lo que se ve.
create or replace function public.expo_ver_invitado(p_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  i   public.expo_invitados;
  e   public.expo_ediciones;
  hoy date := public.expo_hoy();
  r   jsonb;
begin
  i := public.expo__por_token(p_token);
  if i.id is null then
    return jsonb_build_object('estado', 'invalido');
  end if;

  select * into e from public.expo_ediciones where id = i.edicion_id;
  -- link de una expo vieja: "Puede ser de otro año"
  if e.estado = 'cerrada'
     and exists (select 1 from public.expo_ediciones n where n.anio > e.anio) then
    return jsonb_build_object('estado', 'invalido');
  end if;

  r := jsonb_build_object(
    'estado',   e.estado,
    'edicion',  jsonb_build_object(
                  'anio', e.anio,
                  'dias', (select jsonb_agg(d order by d) from unnest(e.dias) d),
                  'hoy',  hoy,
                  -- "La expo sigue el jueves 16 · abre a las 9:00"
                  'hora_apertura', e.hora_apertura),
    'invitado', jsonb_build_object(
                  'razon_social', i.razon_social,
                  'codigo_erp',   i.codigo_erp,
                  'localidad',    i.localidad));

  if e.estado = 'previa' then
    r := r || jsonb_build_object(
      'confirmado',          i.confirmado,
      'confirmado_cantidad', i.confirmado_cantidad,
      'turno', (select jsonb_build_object('dia', t.dia, 'desde', t.desde, 'hasta', t.hasta)
                  from public.expo_turnos t
                 where t.invitado_id = i.id
                 order by t.dia
                 limit 1));
  elsif e.estado = 'en_curso' then
    r := r || jsonb_build_object(
      'nombre_credencial', i.nombre_credencial,
      'turno_hoy', (select jsonb_build_object('desde', t.desde, 'hasta', t.hasta)
                      from public.expo_turnos t
                     where t.invitado_id = i.id and t.dia = hoy),
      'visita_hoy', (select jsonb_build_object('llegada', v.llegada, 'cantidad', v.cantidad)
                       from public.expo_visitas v
                      where v.invitado_id = i.id and v.dia = hoy),
      'visita_anterior', (select jsonb_build_object('dia', v.dia, 'cantidad', v.cantidad)
                            from public.expo_visitas v
                           where v.invitado_id = i.id and v.dia < hoy
                           order by v.dia desc
                           limit 1));
  else
    -- "Para hacer tu pedido, hablá con Juan Pérez, tu vendedor."
    r := r || jsonb_build_object('vendedor', i.vendedor);
  end if;

  return r;
end
$$;


-- Antes de la expo: "Confirmo que voy · somos 2" / "No vamos a poder ir".
create or replace function public.expo_confirmar(p_token text, p_cantidad integer, p_va boolean)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  i public.expo_invitados;
  e public.expo_ediciones;
begin
  i := public.expo__por_token(p_token);
  if i.id is null then
    raise exception 'expo_token_invalido';
  end if;
  select * into e from public.expo_ediciones where id = i.edicion_id;
  if e.estado <> 'previa' then
    raise exception 'expo_no_es_previa';
  end if;
  if p_va is null then
    raise exception 'expo_falta_respuesta';
  end if;
  if p_va and not public.expo__cantidad_valida(p_cantidad) then
    raise exception 'expo_cantidad_invalida';
  end if;

  update public.expo_invitados
     set confirmado          = p_va,
         confirmado_cantidad = case when p_va then p_cantidad end,
         confirmado_en       = now()
   where id = i.id;

  return public.expo_ver_invitado(p_token);
end
$$;


-- Durante la expo: "Estoy acá · somos 2".
-- Si ya hay visita ese día NO crea otra: devuelve la que hay con nueva = false
-- (así un reintento sin señal no falla ni duplica).
-- p_llegada: solo la manda la cola sin señal, con la hora del celular (ISO
-- con zona, toISOString()). Se acepta si es creíble: un día de la expo, no
-- más de una hora en el futuro, no de hace más de 3 días.
create or replace function public.expo_registrar_visita(
  p_token    text,
  p_cantidad integer,
  p_llegada  timestamptz default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  i         public.expo_invitados;
  e         public.expo_ediciones;
  v         public.expo_visitas;
  hoy       date := public.expo_hoy();
  v_dia     date;
  v_llegada timestamptz;
  nueva     boolean;
begin
  -- si recepción está vinculando esta alta en este momento, esperar a que
  -- termine: así la visita va a parar al cliente y no queda una suelta
  perform 1 from public.expo_invitados where token = p_token for share;
  i := public.expo__por_token(p_token);
  if i.id is null then
    raise exception 'expo_token_invalido';
  end if;
  if not public.expo__cantidad_valida(p_cantidad) then
    raise exception 'expo_cantidad_invalida';
  end if;
  select * into e from public.expo_ediciones where id = i.edicion_id;

  if p_llegada is null then
    if e.estado <> 'en_curso' or not (hoy = any (e.dias)) then
      raise exception 'expo_no_es_dia_de_expo';
    end if;
    v_dia     := hoy;
    v_llegada := now();
  else
    v_dia := public.expo__dia_ar(p_llegada);
    if e.estado = 'previa'
       or not (v_dia = any (e.dias))
       or p_llegada > now() + interval '1 hour'  -- reloj adelantado: least() lo corrige
       or p_llegada < now() - interval '3 days' then
      raise exception 'expo_no_es_dia_de_expo';
    end if;
    v_llegada := least(p_llegada, now());
  end if;

  insert into public.expo_visitas (invitado_id, dia, llegada, cantidad, sin_senal)
  values (i.id, v_dia, v_llegada, p_cantidad, p_llegada is not null)
  on conflict (invitado_id, dia) do nothing
  returning * into v;
  nueva := found;

  if not nueva then
    select * into v from public.expo_visitas where invitado_id = i.id and dia = v_dia;
  end if;

  return jsonb_build_object(
    'nueva',             nueva,
    'dia',               v.dia,
    'llegada',           v.llegada,
    'cantidad',          v.cantidad,
    'razon_social',      i.razon_social,
    'nombre_credencial', i.nombre_credencial);
end
$$;


-- "Corregir la cantidad" de la visita de hoy.
create or replace function public.expo_corregir_cantidad(p_token text, p_cantidad integer)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  i public.expo_invitados;
  e public.expo_ediciones;
  v public.expo_visitas;
begin
  perform 1 from public.expo_invitados where token = p_token for share;  -- ver registrar_visita
  i := public.expo__por_token(p_token);
  if i.id is null then
    raise exception 'expo_token_invalido';
  end if;
  if not public.expo__cantidad_valida(p_cantidad) then
    raise exception 'expo_cantidad_invalida';
  end if;
  select * into e from public.expo_ediciones where id = i.edicion_id;
  if e.estado <> 'en_curso' then
    raise exception 'expo_no_es_dia_de_expo';
  end if;

  update public.expo_visitas
     set cantidad = p_cantidad, corregido_en = now()
   where invitado_id = i.id and dia = public.expo_hoy()
  returning * into v;
  if not found then
    raise exception 'expo_sin_visita_hoy';
  end if;

  return jsonb_build_object('dia', v.dia, 'llegada', v.llegada, 'cantidad', v.cantidad);
end
$$;


-- Interna: la edición en curso cuya clave del cartel es esta (la del QR
-- impreso). Si la clave no es, error. NO es pública.
create or replace function public.expo__edicion_del_cartel(p_clave text)
returns public.expo_ediciones
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  e public.expo_ediciones;
begin
  if p_clave is not null and p_clave ~ '^[0-9a-f]{32}$' then
    select * into e
      from public.expo_ediciones
     where estado <> 'cerrada'
       and clave_cartel_hash = public.expo__hash_clave(p_clave);
  end if;
  if e.id is null then
    raise exception 'expo_clave_cartel_invalida';
  end if;
  return e;
end
$$;


-- Cartel: "Buscá tu empresa". Como máximo 8, solo con 3 letras o más, sin
-- tildes ni mayúsculas, en razón social, fantasía y código. Todas las palabras
-- tienen que aparecer. Solo con la clave del cartel, solo durante la expo y
-- solo invitados de la lista (las altas de la puerta no se muestran a otros).
create or replace function public.expo_buscar(p_clave text, p_texto text)
returns table (token text, razon_social text, localidad text, codigo_erp text)
language plpgsql
stable
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  e public.expo_ediciones := public.expo__edicion_del_cartel(p_clave);
  q text := public.expo_normalizar(left(p_texto, 80));
begin
  if e.estado <> 'en_curso' or char_length(replace(q, ' ', '')) < 3 then
    return;
  end if;
  return query
    select i.token, i.razon_social, i.localidad, i.codigo_erp
      from public.expo_invitados i
     where i.edicion_id = e.id
       and i.origen = 'lista'
       and not exists (
             select 1 from unnest(string_to_array(q, ' ')) p
              where strpos(i.busqueda, p) = 0)
     order by strpos(i.busqueda, q) = 1 desc,
              strpos(i.busqueda, q) > 0 desc,
              i.razon_social
     limit 8;
end
$$;


-- Interna: si el celular ya creó esta alta (se cortó la respuesta y
-- reintenta), lo que ya se creó; si no, null.
create or replace function public.expo__alta_ya_creada(p_clave uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  a public.expo_invitados;
  v public.expo_visitas;
begin
  if p_clave is null then
    return null;
  end if;
  select * into a from public.expo_invitados where alta_clave = p_clave;
  if not found then
    return null;
  end if;
  -- si recepción ya la vinculó, la visita es del cliente
  select * into v
    from public.expo_visitas
   where invitado_id = coalesce(a.vinculado_a, a.id)
   order by dia
   limit 1;
  return jsonb_build_object(
    'nueva', false, 'token', a.token, 'razon_social', a.alta_empresa,
    'llegada', v.llegada, 'cantidad', v.cantidad);
end
$$;


-- Cartel: "Registrarme sin estar en la lista". Crea el invitado
-- (origen alta_puerta) y la visita de hoy.
-- Freno: la clave del cartel, largos acotados, 12 altas por minuto y 300 por
-- día en toda la expo (en el predio todos salen por la misma IP, así que no
-- se puede frenar por IP).
create or replace function public.expo_alta_rapida(
  p_clave_cartel text,
  p_nombre    text,
  p_empresa   text,
  p_categoria text,
  p_cuit      text,
  p_cantidad  integer,
  p_clave     uuid default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  e         public.expo_ediciones;
  nuevo     public.expo_invitados;
  v         public.expo_visitas;
  hoy       date := public.expo_hoy();
  v_nombre  text := public.expo_espacios(p_nombre);
  v_empresa text := public.expo_espacios(p_empresa);
  v_cuit    text := nullif(public.expo_espacios(p_cuit), '');
  n         integer;
  r         jsonb;
  -- el freno (los dos errores empiezan con expo_demasiadas_altas)
  tope_por_minuto constant integer := 12;
  tope_por_dia    constant integer := 300;
begin
  e := public.expo__edicion_del_cartel(p_clave_cartel);

  r := public.expo__alta_ya_creada(p_clave);
  if r is not null then
    return r;
  end if;

  if coalesce(char_length(v_nombre), 0) not between 2 and 80 then
    raise exception 'expo_nombre_invalido';
  end if;
  if coalesce(char_length(v_empresa), 0) not between 2 and 120 then
    raise exception 'expo_empresa_invalida';
  end if;
  if p_categoria is null
     or p_categoria not in ('cliente', 'comex', 'proveedor', 'licencia', 'cliente_de_cliente') then
    raise exception 'expo_categoria_invalida';
  end if;
  if v_cuit is not null and v_cuit !~ '^[0-9A-Za-z .-]{1,20}$' then
    raise exception 'expo_cuit_invalido';
  end if;
  if not public.expo__cantidad_valida(p_cantidad) then
    raise exception 'expo_cantidad_invalida';
  end if;

  if e.estado <> 'en_curso' or not (hoy = any (e.dias)) then
    raise exception 'expo_no_es_dia_de_expo';
  end if;

  -- de a una por vez, así el conteo del freno es exacto
  perform pg_advisory_xact_lock(hashtext('expo_alta_rapida'));
  -- otra vez: dos reintentos simultáneos del mismo celular pasaron juntos el
  -- primer chequeo; el segundo recién ve el alta después del lock
  r := public.expo__alta_ya_creada(p_clave);
  if r is not null then
    return r;
  end if;
  select count(*) into n
    from public.expo_invitados
   where origen = 'alta_puerta' and creado_en > now() - interval '1 minute';
  if n >= tope_por_minuto then
    raise exception 'expo_demasiadas_altas_minuto';
  end if;
  select count(*) into n
    from public.expo_invitados
   where origen = 'alta_puerta' and edicion_id = e.id
     and public.expo__dia_ar(creado_en) = hoy;
  if n >= tope_por_dia then
    raise exception 'expo_demasiadas_altas_dia';
  end if;

  insert into public.expo_invitados (
    edicion_id, razon_social, categoria, origen, estado_vinculo,
    alta_nombre, alta_empresa, alta_cuit, alta_clave)
  values (
    e.id, v_empresa, p_categoria, 'alta_puerta',
    -- proveedor, comex y licencias no se vinculan: no son clientes
    case when p_categoria in ('cliente', 'cliente_de_cliente') then 'pendiente' else 'no_cliente' end,
    v_nombre, v_empresa, v_cuit, p_clave)
  returning * into nuevo;

  insert into public.expo_visitas (invitado_id, dia, cantidad)
  values (nuevo.id, hoy, p_cantidad)
  returning * into v;

  return jsonb_build_object(
    'nueva', true, 'token', nuevo.token, 'razon_social', nuevo.alta_empresa,
    'llegada', v.llegada, 'cantidad', v.cantidad);
end
$$;


-- ------------------------------------------------------------
-- 5b. Funciones del equipo de recorrido (anónimas, con la clave del link)
-- ------------------------------------------------------------

-- Interna: la edición abierta cuya clave de equipo es esta. NO es pública.
create or replace function public.expo__edicion_por_clave(p_clave text)
returns public.expo_ediciones
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  e public.expo_ediciones;
begin
  if p_clave is null or p_clave !~ '^[0-9a-f]{32}$' then
    return null;
  end if;
  select * into e
    from public.expo_ediciones
   where estado <> 'cerrada'
     and clave_equipo_hash = public.expo__hash_clave(p_clave);
  return e;
end
$$;

-- Interna: valida clave y persona del equipo; devuelve la edición.
create or replace function public.expo__equipo_valido(p_clave text, p_equipo uuid)
returns public.expo_ediciones
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  e public.expo_ediciones;
begin
  e := public.expo__edicion_por_clave(p_clave);
  if e.id is null then
    raise exception 'expo_clave_invalida';
  end if;
  if p_equipo is null
     or not exists (select 1 from public.expo_equipo q where q.id = p_equipo and q.activo) then
    raise exception 'expo_equipo_invalido';
  end if;
  return e;
end
$$;


-- "¿Quién sos?": la lista del equipo activo.
create or replace function public.expo_equipo_lista(p_clave text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  e public.expo_ediciones;
begin
  e := public.expo__edicion_por_clave(p_clave);
  if e.id is null then
    raise exception 'expo_clave_invalida';
  end if;
  return coalesce(
    (select jsonb_agg(jsonb_build_object('id', q.id, 'nombre', q.nombre, 'rol', q.rol)
                      order by q.nombre)
       from public.expo_equipo q
      where q.activo),
    '[]'::jsonb);
end
$$;


-- Presentes del día, los últimos arriba. Solo lo que muestra la tarjeta.
-- recorrido: quienes se anotaron y si tomaron el pedido (vacío = "Lo atiende
-- su vendedor").
create or replace function public.expo_presentes(p_clave text, p_equipo uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  e   public.expo_ediciones;
  hoy date := public.expo_hoy();
begin
  e := public.expo__equipo_valido(p_clave, p_equipo);

  return jsonb_build_object(
    'estado',        e.estado,
    'hoy',           hoy,
    'es_dia',        hoy = any (e.dias),
    'hora_apertura', e.hora_apertura,
    'presentes', coalesce((
      select jsonb_agg(jsonb_build_object(
               'visita_id',    v.id,
               'llegada',      v.llegada,
               'cantidad',     v.cantidad,
               'razon_social', i.razon_social,
               'zona',         i.zona,
               'categoria',    i.categoria,
               'sin_codigo',   i.codigo_erp is null,
               'vendedor',     i.vendedor,
               'recorrido',    coalesce((
                                 select jsonb_agg(jsonb_build_object('id', q.id, 'nombre', q.nombre,
                                                                     'tomo_pedido', r.tomo_pedido)
                                                  order by r.creado_en)
                                   from public.expo_recorridos r
                                   join public.expo_equipo q on q.id = r.equipo_id
                                  where r.visita_id = v.id), '[]'::jsonb))
             order by v.llegada desc)
        from public.expo_visitas v
        join public.expo_invitados i on i.id = v.invitado_id
       where i.edicion_id = e.id
         and v.dia = hoy
         and e.estado = 'en_curso'), '[]'::jsonb));
end
$$;


-- Interna: la visita a la que fue a parar esta, si vincular la unió con otra.
create or replace function public.expo__visita_actual(p_visita uuid)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select f.nueva from public.expo_visitas_fusion f where f.vieja = p_visita), p_visita)
$$;


-- "Me anoto". Repetirlo no duplica (la cola sin señal puede reintentar).
create or replace function public.expo_anotarme(p_clave text, p_equipo uuid, p_visita uuid)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  e       public.expo_ediciones;
  visita  uuid := public.expo__visita_actual(p_visita);
begin
  e := public.expo__equipo_valido(p_clave, p_equipo);
  if e.estado <> 'en_curso' then
    raise exception 'expo_no_es_dia_de_expo';
  end if;
  if not exists (
    select 1
      from public.expo_visitas v
      join public.expo_invitados i on i.id = v.invitado_id
     where v.id = visita and i.edicion_id = e.id
       and v.dia = public.expo_hoy()   -- con la lista de ayer guardada en el celular no se anota en una visita de ayer
  ) then
    raise exception 'expo_visita_invalida';
  end if;

  insert into public.expo_recorridos (visita_id, equipo_id)
  values (visita, p_equipo)
  on conflict do nothing;
end
$$;


-- "Me bajo" y el "Deshacer" de la tostada. Repetirlo no falla.
create or replace function public.expo_bajarme(p_clave text, p_equipo uuid, p_visita uuid)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  e public.expo_ediciones;
begin
  e := public.expo__equipo_valido(p_clave, p_equipo);
  delete from public.expo_recorridos r
   using public.expo_visitas v, public.expo_invitados i
   where r.visita_id = public.expo__visita_actual(p_visita)
     and r.equipo_id = p_equipo
     and v.id = r.visita_id
     and i.id = v.invitado_id
     and i.edicion_id = e.id;
end
$$;


-- "Tomé el pedido" (y deshacerlo): solo en una visita donde esa persona se
-- anotó. Si el pedido lo tomó el vendedor, nadie marca nada.
create or replace function public.expo_tome_pedido(
  p_clave  text,
  p_equipo uuid,
  p_visita uuid,
  p_tomo   boolean)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  e public.expo_ediciones;
begin
  e := public.expo__equipo_valido(p_clave, p_equipo);
  if e.estado <> 'en_curso' then
    raise exception 'expo_no_es_dia_de_expo';
  end if;
  if p_tomo is null then
    raise exception 'expo_falta_respuesta';
  end if;

  update public.expo_recorridos r
     set tomo_pedido = p_tomo
    from public.expo_visitas v, public.expo_invitados i
   where r.visita_id = public.expo__visita_actual(p_visita)
     and r.equipo_id = p_equipo
     and v.id = r.visita_id
     and i.id = v.invitado_id
     and i.edicion_id = e.id;
  if not found then
    raise exception 'expo_no_anotado';
  end if;
end
$$;


-- ------------------------------------------------------------
-- 6. Funciones de recepción (es_admin)
-- ------------------------------------------------------------

-- Clave nueva para el link del equipo de la edición abierta. Devuelve la
-- clave UNA vez (la base guarda solo el hash). La anterior deja de andar.
create or replace function public.expo_nueva_clave_equipo()
returns text
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  clave text := replace(gen_random_uuid()::text, '-', '');
begin
  if not public.es_admin() then
    raise exception 'expo_solo_admin';
  end if;
  update public.expo_ediciones
     set clave_equipo_hash = public.expo__hash_clave(clave)
   where estado <> 'cerrada';
  if not found then
    raise exception 'expo_sin_edicion_abierta';
  end if;
  return clave;
end
$$;

-- Clave nueva para el QR impreso del cartel de la edición abierta. Igual que
-- la del equipo, pero cambiarla obliga a reimprimir el cartel: se genera una
-- vez antes de imprimir y se cambia solo si el QR se filtra.
create or replace function public.expo_nueva_clave_cartel()
returns text
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  clave text := replace(gen_random_uuid()::text, '-', '');
begin
  if not public.es_admin() then
    raise exception 'expo_solo_admin';
  end if;
  update public.expo_ediciones
     set clave_cartel_hash = public.expo__hash_clave(clave)
   where estado <> 'cerrada';
  if not found then
    raise exception 'expo_sin_edicion_abierta';
  end if;
  return clave;
end
$$;


-- Vincular un alta a un código de Finnegans.
-- · Si ese código ya está invitado: sus visitas pasan a ese invitado. Si ese
--   día ya tenía visita, se unen en una con la cantidad mayor, la llegada más
--   temprana y los recorridos de las dos.
-- · Si no está invitado: el alta toma el código y los datos de expo_clientes
--   (razón social, vendedor, zona, localidad). Lo que escribió queda en
--   alta_empresa.
-- Siempre queda quién vinculó y cuándo.
create or replace function public.expo_vincular(p_alta uuid, p_codigo text)
returns uuid  -- el invitado al que quedó apuntando la visita
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  a       public.expo_invitados;
  destino public.expo_invitados;
  c       public.expo_clientes;
  va      public.expo_visitas;
  vd      public.expo_visitas;
  quien   text := lower(coalesce(auth.jwt() ->> 'email', ''));
begin
  if not public.es_admin() then
    raise exception 'expo_solo_admin';
  end if;

  select * into a from public.expo_invitados where id = p_alta for update;
  if not found or a.origen <> 'alta_puerta' or a.estado_vinculo = 'vinculada' then
    raise exception 'expo_alta_no_disponible';
  end if;

  select * into destino
    from public.expo_invitados
   where edicion_id = a.edicion_id and codigo_erp = p_codigo
   for update;

  if found then
    for va in select * from public.expo_visitas where invitado_id = a.id for update loop
      select * into vd
        from public.expo_visitas
       where invitado_id = destino.id and dia = va.dia
       for update;
      if found then
        update public.expo_visitas
           set cantidad = greatest(vd.cantidad, va.cantidad),
               llegada  = least(vd.llegada, va.llegada)
         where id = vd.id;
        -- si la misma persona estaba en las dos, "tomó el pedido" en
        -- cualquiera de las dos cuenta
        insert into public.expo_recorridos (visita_id, equipo_id, tomo_pedido, creado_en)
        select vd.id, r.equipo_id, r.tomo_pedido, r.creado_en
          from public.expo_recorridos r
         where r.visita_id = va.id
        on conflict (visita_id, equipo_id) do update
          set tomo_pedido = expo_recorridos.tomo_pedido or excluded.tomo_pedido;
        update public.expo_visitas_fusion set nueva = vd.id where nueva = va.id;
        insert into public.expo_visitas_fusion (vieja, nueva) values (va.id, vd.id);
        delete from public.expo_visitas where id = va.id;
      else
        update public.expo_visitas set invitado_id = destino.id where id = va.id;
      end if;
    end loop;

    update public.expo_invitados
       set estado_vinculo = 'vinculada',
           vinculado_a    = destino.id,
           vinculado_por  = quien,
           vinculado_en   = now()
     where id = a.id;
    return destino.id;
  end if;

  select * into c from public.expo_clientes where codigo_erp = p_codigo;
  if not found then
    raise exception 'expo_codigo_desconocido';
  end if;

  update public.expo_invitados
     set codigo_erp      = c.codigo_erp,
         razon_social    = c.razon_social,
         nombre_fantasia = c.nombre_fantasia,
         zona            = c.zona,
         localidad       = c.localidad,
         vendedor        = c.vendedor,
         categoria       = 'cliente',
         estado_vinculo  = 'vinculada',
         vinculado_por   = quien,
         vinculado_en    = now()
   where id = a.id;
  return a.id;
end
$$;


-- "Es cliente nuevo" / "No es cliente" (o volver a pendiente).
create or replace function public.expo_marcar_alta(p_alta uuid, p_estado text)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
begin
  if not public.es_admin() then
    raise exception 'expo_solo_admin';
  end if;
  if p_estado is null or p_estado not in ('pendiente', 'cliente_nuevo', 'no_cliente') then
    raise exception 'expo_estado_invalido';
  end if;

  update public.expo_invitados
     set estado_vinculo = p_estado,
         vinculado_por  = lower(coalesce(auth.jwt() ->> 'email', '')),
         vinculado_en   = now()
   where id = p_alta
     and origen = 'alta_puerta'
     and estado_vinculo <> 'vinculada';
  if not found then
    raise exception 'expo_alta_no_disponible';
  end if;
end
$$;


-- ------------------------------------------------------------
-- 7. Permisos de ejecución
--    Primero se le saca a todas; después se da una por una.
-- ------------------------------------------------------------
do $$
declare
  f regprocedure;
begin
  for f in
    select p.oid::regprocedure
      from pg_proc p
     where p.pronamespace = 'public'::regnamespace
       and p.proname like 'expo\_%'
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
end
$$;

-- Lo usan las columnas generadas y los índices cuando recepción carga datos.
grant execute on function public.expo_normalizar(text) to authenticated;
grant execute on function public.expo_espacios(text)   to authenticated;
grant execute on function public.expo_hoy()            to authenticated;
grant execute on function public.expo__dia_ar(timestamptz) to authenticated;  -- la usa expo_hoy

-- Cliente y cartel (sin login).
grant execute on function public.expo_ver_invitado(text)                                    to anon, authenticated;
grant execute on function public.expo_confirmar(text, integer, boolean)                     to anon, authenticated;
grant execute on function public.expo_registrar_visita(text, integer, timestamptz)          to anon, authenticated;
grant execute on function public.expo_corregir_cantidad(text, integer)                      to anon, authenticated;
grant execute on function public.expo_buscar(text, text)                                    to anon, authenticated;
grant execute on function public.expo_alta_rapida(text, text, text, text, text, integer, uuid) to anon, authenticated;

-- Equipo de recorrido (sin login, con la clave del link).
grant execute on function public.expo_equipo_lista(text)             to anon, authenticated;
grant execute on function public.expo_presentes(text, uuid)          to anon, authenticated;
grant execute on function public.expo_anotarme(text, uuid, uuid)     to anon, authenticated;
grant execute on function public.expo_bajarme(text, uuid, uuid)      to anon, authenticated;
grant execute on function public.expo_tome_pedido(text, uuid, uuid, boolean) to anon, authenticated;

-- Recepción (adentro chequean es_admin()).
grant execute on function public.expo_vincular(uuid, text)      to authenticated;
grant execute on function public.expo_marcar_alta(uuid, text)   to authenticated;
grant execute on function public.expo_nueva_clave_equipo()      to authenticated;
grant execute on function public.expo_nueva_clave_cartel()      to authenticated;

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
  -- lo único que el anónimo puede ejecutar: las de la sección 7
  publicas text[] := array[
    'expo_alta_rapida', 'expo_anotarme', 'expo_bajarme', 'expo_buscar', 'expo_confirmar',
    'expo_corregir_cantidad', 'expo_equipo_lista', 'expo_presentes', 'expo_registrar_visita',
    'expo_tome_pedido', 'expo_ver_invitado'];
  -- la única interna que puede ejecutar un logueado: la usa expo_hoy (sección 7)
  internas_logueado text[] := array['expo__dia_ar'];
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
end
$verificacion$;

-- Lo único que muestra el SQL Editor. Si llegó hasta acá, pasó los controles.
select 'listo: expo v01 verificada' as resultado,
       (select count(*) from pg_class c
         where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
           and c.relname like 'expo\_%' and c.relrowsecurity) as tablas_con_rls,
       (select count(*) from pg_proc p
         where p.pronamespace = 'public'::regnamespace and p.proname like 'expo\_%'
           and has_function_privilege('anon', p.oid, 'execute')) as funciones_del_anonimo;
