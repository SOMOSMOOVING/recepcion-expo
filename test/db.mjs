// Base de prueba: Postgres de verdad (PGlite) con lo que Supabase trae de
// fábrica y la migración expo encima. No toca la base real.
//
// Lo de fábrica que importa imitar:
// · los roles anon y authenticated
// · que Supabase les da permiso sobre TODA tabla y función nueva de public
//   (si la migración se olvida de sacarlo, los tests lo tienen que ver)
// · auth.jwt(), que lee los claims del pedido
// · es_admin() tal como está en la app de pedidos
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');

const SUPABASE = `
create role anon nologin;
create role authenticated nologin;
grant usage on schema public to anon, authenticated;
alter default privileges in schema public grant all on tables    to anon, authenticated;
alter default privileges in schema public grant all on functions to anon, authenticated;
alter default privileges in schema public grant all on sequences to anon, authenticated;

create schema auth;
grant usage on schema auth to anon, authenticated;
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;
grant execute on function auth.jwt() to anon, authenticated;

-- copiado de la app de pedidos (supabase-pedidos.sql)
create table public.admins (
  email text primary key, nota text, creado_en timestamptz not null default now()
);
create or replace function public.es_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.admins a
    where lower(a.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;
alter table public.admins enable row level security;
insert into public.admins (email) values ('recepcion@mooving.com.ar');
`;

// Los archivos de migración en orden (v01, v02, ... v10: por número, no por texto).
export function archivosMigracion() {
  const dir = join(RAIZ, 'sql');
  return readdirSync(dir)
    .filter((f) => /^expo-migracion-v\d+\.sql$/.test(f))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]))
    .map((f) => join(dir, f));
}

// El SQL de cada migración. EXPO_SQL reemplaza SOLO la última (la prueba de
// mutación la muta); las anteriores se corren igual que en la base real.
export function leerMigraciones() {
  const archivos = archivosMigracion();
  if (process.env.EXPO_SQL) archivos[archivos.length - 1] = process.env.EXPO_SQL;
  return archivos.map((f) => readFileSync(f, 'utf8'));
}

// Supabase corre en UTC; PGlite toma la zona de la máquina. Si los tests
// corrieran en hora argentina, un error de zona horaria pasaría inadvertido.
const EN_UTC = `set timezone to 'UTC'`;

export async function nuevaBase() {
  const db = new PGlite();
  await db.exec(EN_UTC);
  await db.exec(SUPABASE);
  for (const sql of leerMigraciones()) await db.exec(sql);
  return db;
}

// Cada test arranca de una base limpia: se arma una vez por archivo y se
// clona (arrancar Postgres de cero tarda ~2 s). Los tests de un archivo
// corren de a uno, así que al pedir una copia nueva se cierra la anterior
// (cada copia ocupa cientos de MB).
const plantillas = new Map();
let copiaAbierta = null;
export async function base(op = {}) {
  if (copiaAbierta) await copiaAbierta.close().catch(() => {});
  copiaAbierta = null;
  const clave = JSON.stringify(op);
  if (!plantillas.has(clave)) {
    plantillas.set(clave, (async () => {
      const db = await nuevaBase();
      const s = await sembrar(db, op);
      return { db, s };
    })());
  }
  const { db, s } = await plantillas.get(clave);
  const copia = await db.clone();
  await copia.exec(EN_UTC);
  copiaAbierta = copia;
  return { db: copia, s };
}

export const ADMIN = { email: 'recepcion@mooving.com.ar', role: 'authenticated' };
export const VENDEDOR = { email: 'juan.perez@mooving.com.ar', role: 'authenticated' };

// Corre fn como un rol (anon / authenticated) con esos claims, en una
// transacción. Si fn tira error, la transacción se deshace y el error sigue.
export async function como(db, rol, claims, fn) {
  return db.transaction(async (tx) => {
    await tx.query(`select set_config('role', $1, true), set_config('request.jwt.claims', $2, true)`,
      [rol, JSON.stringify(claims || {})]);
    return fn(tx);
  });
}

// Llama una función RPC como lo haría PostgREST y devuelve su valor.
export async function rpc(db, rol, claims, fn, args = []) {
  const ph = args.map((_, i) => `$${i + 1}`).join(', ');
  return como(db, rol, claims, async (tx) => {
    const r = await tx.query(`select public.${fn}(${ph}) as r`, args);
    return r.rows[0].r;
  });
}

export const anon = (db, fn, ...args) => rpc(db, 'anon', {}, fn, args);
export const admin = (db, fn, ...args) => rpc(db, 'authenticated', ADMIN, fn, args);

// Un valor suelto, como superusuario (para preparar y mirar datos).
export async function uno(db, sql, params = []) {
  const r = await db.query(sql, params);
  const fila = r.rows[0];
  return fila ? Object.values(fila)[0] : undefined;
}

export const CLAVE_EQUIPO = '0123456789abcdef0123456789abcdef';
export const CLAVE_CARTEL = 'cafecafecafecafecafecafecafecafe';

// Una expo con ayer, hoy y mañana como días, unos invitados, turnos y equipo.
export async function sembrar(db, { estado = 'en_curso' } = {}) {
  const edicion = await uno(db, `
    insert into expo_ediciones (anio, dias, estado, clave_equipo_hash, clave_cartel_hash)
    values (2026, array[expo_hoy() - 1, expo_hoy(), expo_hoy() + 1], $1,
            encode(sha256(convert_to($2, 'UTF8')), 'hex'),
            encode(sha256(convert_to($3, 'UTF8')), 'hex'))
    returning id`, [estado, CLAVE_EQUIPO, CLAVE_CARTEL]);

  const invitado = async (codigo, razon, extra = {}) => {
    const r = await db.query(`
      insert into expo_invitados
        (edicion_id, codigo_erp, razon_social, nombre_fantasia, nombre_credencial,
         zona, localidad, vendedor, categoria)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      returning id, token`,
      [edicion, codigo, razon, extra.fantasia ?? null, extra.credencial ?? null,
       extra.zona ?? 'Zona Sur', extra.localidad ?? 'Lanús', extra.vendedor ?? 'Juan Pérez',
       extra.categoria ?? 'cliente']);
    return r.rows[0];
  };

  const papeltec = await invitado('10234', 'MINUCHIN MARTA LILIANA - LIBRERIA PAPELTEC',
    { credencial: 'LIBRERÍA PAPELTEC' });
  const trebol = await invitado('12577', 'GONZALEZ HNOS S.A. - JUGUETERIA EL TREBOL',
    { zona: 'Zona Oeste', localidad: 'Castelar', vendedor: 'Diego Acosta' });
  const lujan = await invitado('14420', 'COOPERATIVA ESCOLAR NUESTRA SEÑORA DE LUJAN LTDA',
    { zona: 'Zona Oeste', localidad: 'Luján', vendedor: 'Martín Ibarra' });

  await db.query(`insert into expo_turnos (invitado_id, dia, desde, hasta)
                  values ($1, expo_hoy(), '10:00', '11:00')`, [papeltec.id]);

  const sofia = await uno(db, `insert into expo_equipo (nombre, rol) values ('Sofía Giménez', 'hostess') returning id`);
  const ana = await uno(db, `insert into expo_equipo (nombre, rol) values ('Ana López', 'marketing') returning id`);

  await db.query(`insert into expo_clientes (codigo_erp, razon_social, cuit, zona, localidad, vendedor)
                  values ('15877', 'FERNANDEZ SILVINA - MARROQUINERIA KALU', '27284551203', 'CABA', 'Caballito', 'Laura Benítez')`);

  return { edicion, papeltec, trebol, lujan, equipo: { sofia, ana } };
}
