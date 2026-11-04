-- Tempo : notifications du coach (à exécuter UNE fois dans Supabase → SQL Editor)
-- Le script peut être relancé sans risque. Il ne touche ni à vos profils ni à vos séances.
--
-- Principe : chaque appareil qui active les notifications enregistre un « abonnement » (une adresse d'envoi
-- fournie par Apple / Google). Une fonction (Edge Function « tempo-push », étape 2) est appelée chaque minute
-- par le minuteur (étape 3) : elle envoie les messages du coach aux abonnements marqués « coach ».

-- 1) Tables (fermées : aucun accès direct depuis l'appli, comme les autres tables de Tempo)
create table if not exists public.tempo_push_subs (
  id          uuid primary key default gen_random_uuid(),
  owner_key   text not null check (owner_key ~ '^[0-9a-f]{64}$'),
  label       text not null default '' check (char_length(label) <= 100),     -- prénom du profil au moment de l'activation
  endpoint    text not null unique check (endpoint ~ '^https://' and char_length(endpoint) < 1000),
  p256dh      text not null check (char_length(p256dh) between 80 and 100),
  auth        text not null check (char_length(auth) between 20 and 30),
  coach       boolean not null default false,                                  -- true = reçoit les messages du coach (à activer par vous, voir plus bas)
  train_days  int[] not null default '{1,3,5}',                                -- jours de séance : 1 = lundi … 7 = dimanche
  train_time  time not null default '17:30',                                   -- heure du rappel de séance (heure de Paris)
  fail_count  int not null default 0,
  last_error  text,
  created_at  timestamptz not null default now(),
  last_ok_at  timestamptz
);
create index if not exists tempo_push_subs_owner on public.tempo_push_subs (owner_key);

create table if not exists public.tempo_push_log (
  owner_key text not null,
  kind      text not null,
  day       text not null,                    -- « 2026-11-05 », ou « 2026-11-05#q12 » pour un événement de la file d'attente
  variant   text not null default '',
  sent_at   timestamptz not null default now(),
  primary key (owner_key, kind, day)
);
create index if not exists tempo_push_log_recent on public.tempo_push_log (owner_key, kind, sent_at desc);

create table if not exists public.tempo_push_queue (
  id         bigint generated always as identity primary key,
  owner_key  text not null,
  kind       text not null check (kind in ('finish', 'test')),
  payload    jsonb not null default '{}'::jsonb check (pg_column_size(payload) < 4000),
  due_at     timestamptz not null default now(),
  sent_at    timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists tempo_push_queue_due on public.tempo_push_queue (due_at) where sent_at is null;

create table if not exists public.tempo_push_config (
  name       text primary key,
  value      jsonb not null,                  -- clés d'identification de l'expéditeur (créées automatiquement, ne jamais les partager)
  updated_at timestamptz not null default now()
);

alter table public.tempo_push_subs   enable row level security;
alter table public.tempo_push_log    enable row level security;
alter table public.tempo_push_queue  enable row level security;
alter table public.tempo_push_config enable row level security;
revoke all on public.tempo_push_subs, public.tempo_push_log, public.tempo_push_queue, public.tempo_push_config from anon, authenticated;

-- 2) Fonctions utilisées par l'appli (security definer : uniquement pour la clé fournie, après vérification de son format)
create or replace function public.tempo_push_public_key(p_key text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_key is null or p_key !~ '^[0-9a-f]{64}$' then raise exception 'cle invalide'; end if;
  -- seule la partie PUBLIQUE de la clé est renvoyée
  return (select jsonb_build_object('public_key', c.value ->> 'publicKey') from public.tempo_push_config c where c.name = 'vapid');
end;
$$;

create or replace function public.tempo_push_subscribe(p_key text, p_label text, p_endpoint text, p_p256dh text, p_auth text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_coach boolean;
begin
  if p_key is null or p_key !~ '^[0-9a-f]{64}$' then raise exception 'cle invalide'; end if;
  if p_endpoint is null or p_endpoint !~ '^https://' or p_p256dh is null or p_auth is null then raise exception 'donnees invalides'; end if;
  if (select count(*) from public.tempo_push_subs s where s.owner_key = p_key and s.endpoint <> p_endpoint) >= 10 then raise exception 'trop d appareils'; end if;

  insert into public.tempo_push_subs as s (owner_key, label, endpoint, p256dh, auth)
  values (p_key, left(coalesce(p_label, ''), 100), p_endpoint, p_p256dh, p_auth)
  on conflict (endpoint) do update
    set coach      = case when s.owner_key = excluded.owner_key then s.coach else false end,   -- un autre compte sur le même appareil repart sans le coach
        owner_key  = excluded.owner_key,
        label      = excluded.label,
        p256dh     = excluded.p256dh,
        auth       = excluded.auth,
        fail_count = 0,
        last_error = null;

  select s.coach into v_coach from public.tempo_push_subs s where s.endpoint = p_endpoint;
  return jsonb_build_object('ok', true, 'coach', coalesce(v_coach, false));
end;
$$;

create or replace function public.tempo_push_unsubscribe(p_key text, p_endpoint text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_key is null or p_key !~ '^[0-9a-f]{64}$' then raise exception 'cle invalide'; end if;
  delete from public.tempo_push_subs s where s.owner_key = p_key and s.endpoint = p_endpoint;
end;
$$;

create or replace function public.tempo_push_status(p_key text, p_endpoint text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_key is null or p_key !~ '^[0-9a-f]{64}$' then raise exception 'cle invalide'; end if;
  return coalesce((
    select jsonb_build_object('subscribed', true, 'coach', s.coach)
    from public.tempo_push_subs s where s.owner_key = p_key and s.endpoint = p_endpoint
  ), jsonb_build_object('subscribed', false, 'coach', false));
end;
$$;

-- Fin de séance : met un message de félicitations dans la file d'attente (envoyé ~25 s plus tard).
-- Rien n'est mis en file pour un compte qui n'a pas le coach, ni plus d'une fois toutes les 20 minutes.
create or replace function public.tempo_push_finished(p_key text, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  clean jsonb;
begin
  if p_key is null or p_key !~ '^[0-9a-f]{64}$' then raise exception 'cle invalide'; end if;
  if not exists (select 1 from public.tempo_push_subs s where s.owner_key = p_key and s.coach) then return jsonb_build_object('queued', false); end if;
  if exists (select 1 from public.tempo_push_queue q where q.owner_key = p_key and q.kind = 'finish' and q.created_at > now() - interval '20 minutes') then return jsonb_build_object('queued', false); end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then p_payload := '{}'::jsonb; end if;

  clean := jsonb_build_object(
    'sets',    least(coalesce(nullif(left(regexp_replace(p_payload ->> 'sets', '[^0-9]', '', 'g'), 4), '')::int, 0), 500),
    'minutes', least(coalesce(nullif(left(regexp_replace(p_payload ->> 'minutes', '[^0-9]', '', 'g'), 4), '')::int, 0), 600),
    'done',    least(coalesce(nullif(left(regexp_replace(p_payload ->> 'done', '[^0-9]', '', 'g'), 4), '')::int, 0), 50),
    'goal',    least(greatest(coalesce(nullif(left(regexp_replace(p_payload ->> 'goal', '[^0-9]', '', 'g'), 4), '')::int, 3), 1), 7),
    'name',    left(coalesce(p_payload ->> 'name', ''), 60),
    'recs',    case when jsonb_typeof(p_payload -> 'recs') = 'array'
                    then (select coalesce(jsonb_agg(t.v), '[]'::jsonb) from (select left(x, 60) as v from jsonb_array_elements_text(p_payload -> 'recs') as x limit 3) t)
                    else '[]'::jsonb end
  );
  insert into public.tempo_push_queue (owner_key, kind, payload, due_at) values (p_key, 'finish', clean, now() + interval '25 seconds');
  return jsonb_build_object('queued', true);
end;
$$;

-- 3) Droits : seul le rôle « anon » (clé publishable) peut appeler ces fonctions
revoke all on function public.tempo_push_public_key(text)                          from public, anon, authenticated;
revoke all on function public.tempo_push_subscribe(text, text, text, text, text)   from public, anon, authenticated;
revoke all on function public.tempo_push_unsubscribe(text, text)                   from public, anon, authenticated;
revoke all on function public.tempo_push_status(text, text)                        from public, anon, authenticated;
revoke all on function public.tempo_push_finished(text, jsonb)                     from public, anon, authenticated;

grant execute on function public.tempo_push_public_key(text)                        to anon;
grant execute on function public.tempo_push_subscribe(text, text, text, text, text) to anon;
grant execute on function public.tempo_push_unsubscribe(text, text)                 to anon;
grant execute on function public.tempo_push_status(text, text)                      to anon;
grant execute on function public.tempo_push_finished(text, jsonb)                   to anon;

-- 4) ACTIVER LE COACH POUR HÉLÈNE (après qu'elle a activé les notifications sur son téléphone, voir le guide) :
--    d'abord, vérifier qu'on la voit :
--      select id, label, left(owner_key, 8) as compte, coach, created_at from public.tempo_push_subs order by created_at desc;
--    puis l'activer (adapter le prénom si besoin) :
--      update public.tempo_push_subs set coach = true where label ilike 'h_l_ne';
--    Régler ses jours de séance (1 = lundi … 7 = dimanche) et l'heure du rappel :
--      update public.tempo_push_subs set train_days = '{1,3,5}', train_time = '17:30' where label ilike 'h_l_ne';
--    Mettre le coach en pause / le retirer :
--      update public.tempo_push_subs set coach = false where label ilike 'h_l_ne';
