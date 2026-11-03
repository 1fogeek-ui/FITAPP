-- Tempo : accès par prénom (sans e-mail ni mot de passe)
-- À exécuter une fois dans Supabase → SQL Editor. Remplace le schéma précédent.
--
-- Principe : l'appli calcule une clé secrète (SHA-256 du prénom + code facultatif) et la
-- fournit à chaque appel. Les tables ne sont PAS accessibles directement : seules les
-- 8 fonctions ci-dessous le sont, et chacune ne touche qu'aux lignes de la clé fournie.

-- 0) Nettoyage de l'ancien schéma (tables vides, créé avec e-mail et mot de passe)
drop table if exists public.tempo_photos, public.tempo_profiles cascade;
drop function if exists public.tempo_touch();

-- 1) Tables
create table public.tempo_profiles (
  owner_key  text not null check (owner_key ~ '^[0-9a-f]{64}$'),
  id         text not null check (char_length(id) between 1 and 64),
  name       text not null check (char_length(name) between 1 and 100),
  data       jsonb not null default '{}'::jsonb check (pg_column_size(data) < 8000000),
  updated_at timestamptz not null default now(),
  primary key (owner_key, id)
);

create table public.tempo_photos (
  owner_key   text not null,
  profile_id  text not null,
  exercise_id text not null check (char_length(exercise_id) between 1 and 120),
  image       text not null check (char_length(image) < 200000),
  updated_at  timestamptz not null default now(),
  primary key (owner_key, profile_id, exercise_id),
  foreign key (owner_key, profile_id) references public.tempo_profiles (owner_key, id) on delete cascade
);

-- 2) Fermeture des tables : RLS activée et aucune règle = aucun accès direct par l'API
alter table public.tempo_profiles enable row level security;
alter table public.tempo_photos   enable row level security;
revoke all on public.tempo_profiles, public.tempo_photos from anon, authenticated;

-- 3) Fonctions d'accès (security definer : elles passent par-dessus la RLS, mais uniquement
--    pour la clé fournie, après vérification de son format)

create function public.tempo_profiles_list(p_key text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_key is null or p_key !~ '^[0-9a-f]{64}$' then raise exception 'cle invalide'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'data', t.data, 'updated_at', t.updated_at) order by t.id)
    from public.tempo_profiles t
    where t.owner_key = p_key
  ), '[]'::jsonb);
end;
$$;

create function public.tempo_profiles_put(p_key text, p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  result jsonb;
begin
  if p_key is null or p_key !~ '^[0-9a-f]{64}$' then raise exception 'cle invalide'; end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 20 then raise exception 'donnees invalides'; end if;
  if (select count(*) from public.tempo_profiles t where t.owner_key = p_key) > 40 then raise exception 'trop de profils'; end if;

  with up as (
    insert into public.tempo_profiles as t (owner_key, id, name, data)
    select p_key, r.id, r.name, coalesce(r.data, '{}'::jsonb)
    from jsonb_to_recordset(p_rows) as r(id text, name text, data jsonb)
    on conflict (owner_key, id) do update
      set name = excluded.name, data = excluded.data, updated_at = now()
    returning t.id, t.updated_at
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', up.id, 'updated_at', up.updated_at)), '[]'::jsonb)
  into result
  from up;

  return result;
end;
$$;

create function public.tempo_profile_delete(p_key text, p_id text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_key is null or p_key !~ '^[0-9a-f]{64}$' then raise exception 'cle invalide'; end if;
  delete from public.tempo_profiles t where t.owner_key = p_key and t.id = p_id;
end;
$$;

create function public.tempo_photos_list(p_key text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_key is null or p_key !~ '^[0-9a-f]{64}$' then raise exception 'cle invalide'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('profile_id', t.profile_id, 'exercise_id', t.exercise_id, 'updated_at', t.updated_at))
    from public.tempo_photos t
    where t.owner_key = p_key
  ), '[]'::jsonb);
end;
$$;

create function public.tempo_photos_get(p_key text, p_profile text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_key is null or p_key !~ '^[0-9a-f]{64}$' then raise exception 'cle invalide'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('exercise_id', t.exercise_id, 'image', t.image, 'updated_at', t.updated_at))
    from public.tempo_photos t
    where t.owner_key = p_key and t.profile_id = p_profile
  ), '[]'::jsonb);
end;
$$;

create function public.tempo_photos_put(p_key text, p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  result jsonb;
begin
  if p_key is null or p_key !~ '^[0-9a-f]{64}$' then raise exception 'cle invalide'; end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 10 then raise exception 'donnees invalides'; end if;
  if (select count(*) from public.tempo_photos t where t.owner_key = p_key) > 1500 then raise exception 'trop de photos'; end if;

  with up as (
    insert into public.tempo_photos as t (owner_key, profile_id, exercise_id, image)
    select p_key, r.profile_id, r.exercise_id, r.image
    from jsonb_to_recordset(p_rows) as r(profile_id text, exercise_id text, image text)
    on conflict (owner_key, profile_id, exercise_id) do update
      set image = excluded.image, updated_at = now()
    returning t.profile_id, t.exercise_id, t.updated_at
  )
  select coalesce(jsonb_agg(jsonb_build_object('profile_id', up.profile_id, 'exercise_id', up.exercise_id, 'updated_at', up.updated_at)), '[]'::jsonb)
  into result
  from up;

  return result;
end;
$$;

create function public.tempo_photo_delete(p_key text, p_profile text, p_exercise text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_key is null or p_key !~ '^[0-9a-f]{64}$' then raise exception 'cle invalide'; end if;
  delete from public.tempo_photos t where t.owner_key = p_key and t.profile_id = p_profile and t.exercise_id = p_exercise;
end;
$$;

create function public.tempo_state(p_key text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_key is null or p_key !~ '^[0-9a-f]{64}$' then raise exception 'cle invalide'; end if;
  return jsonb_build_object(
    'profiles', coalesce((
      select jsonb_agg(jsonb_build_object('id', t.id, 'updated_at', t.updated_at))
      from public.tempo_profiles t where t.owner_key = p_key
    ), '[]'::jsonb),
    'photos', coalesce((
      select jsonb_agg(jsonb_build_object('profile_id', t.profile_id, 'exercise_id', t.exercise_id, 'updated_at', t.updated_at))
      from public.tempo_photos t where t.owner_key = p_key
    ), '[]'::jsonb)
  );
end;
$$;

-- 4) Droits : seul le rôle « anon » (clé publishable, sans connexion) peut appeler ces fonctions
revoke all on function public.tempo_profiles_list(text)                from public, anon, authenticated;
revoke all on function public.tempo_profiles_put(text, jsonb)          from public, anon, authenticated;
revoke all on function public.tempo_profile_delete(text, text)         from public, anon, authenticated;
revoke all on function public.tempo_photos_list(text)                  from public, anon, authenticated;
revoke all on function public.tempo_photos_get(text, text)             from public, anon, authenticated;
revoke all on function public.tempo_photos_put(text, jsonb)            from public, anon, authenticated;
revoke all on function public.tempo_photo_delete(text, text, text)     from public, anon, authenticated;
revoke all on function public.tempo_state(text)                        from public, anon, authenticated;

grant execute on function public.tempo_profiles_list(text)             to anon;
grant execute on function public.tempo_profiles_put(text, jsonb)       to anon;
grant execute on function public.tempo_profile_delete(text, text)      to anon;
grant execute on function public.tempo_photos_list(text)               to anon;
grant execute on function public.tempo_photos_get(text, text)          to anon;
grant execute on function public.tempo_photos_put(text, jsonb)         to anon;
grant execute on function public.tempo_photo_delete(text, text, text)  to anon;
grant execute on function public.tempo_state(text)                     to anon;
