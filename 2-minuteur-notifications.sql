-- Tempo : minuteur des notifications (à exécuter UNE fois, APRÈS avoir créé la fonction « tempo-push »)
-- 1) Remplacez REMPLACE_PAR_TON_SECRET par le même secret que celui enregistré dans la fonction (TEMPO_PUSH_SECRET).
-- 2) Ne mettez PAS ce fichier (avec le secret) dans le dépôt GitHub public.
create extension if not exists pg_net;
create extension if not exists pg_cron;

-- Si le minuteur existe déjà, on le remplace
select cron.unschedule('tempo-push-tick') where exists (select 1 from cron.job where jobname = 'tempo-push-tick');

select cron.schedule(
  'tempo-push-tick',
  '* * * * *',                                   -- toutes les minutes
  $cron$
    select net.http_post(
      url     := 'https://mmkrzwmezowkxjxkongu.supabase.co/functions/v1/tempo-push',
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-tempo-secret', 'REMPLACE_PAR_TON_SECRET'),
      body    := '{"action":"tick"}'::jsonb,
      timeout_milliseconds := 20000
    );
  $cron$
);

-- Pour tout arrêter :        select cron.unschedule('tempo-push-tick');
-- Pour voir les passages :   select * from cron.job_run_details order by start_time desc limit 10;
