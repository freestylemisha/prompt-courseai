-- Plumb leaderboard setup.
-- Uses the same Supabase project as Hexed, in its own table.
-- Paste this whole file into Supabase: SQL Editor -> New query -> Run.
-- It is safe to run more than once.

create table if not exists public.plumb_scores (
  id          bigint generated always as identity primary key,
  day         int         not null check (day >= 1),            -- puzzle number (No. 1 = 9 Nov 2026)
  player_id   uuid        not null,                             -- random id kept in the player's browser
  name        text        not null check (char_length(name) between 1 and 20),
  total       int         not null check (total between 0 and 1000),
  rounds      int[]       not null check (array_length(rounds, 1) = 10
                                          and 0 <= all (rounds) and 100 >= all (rounds)),
  created_at  timestamptz not null default now(),
  unique (day, player_id)
);

alter table public.plumb_scores enable row level security;

drop policy if exists "Anyone can read Plumb scores" on public.plumb_scores;
create policy "Anyone can read Plumb scores"
  on public.plumb_scores for select
  to anon, authenticated
  using (true);

-- Players can only post a score for (roughly) today's puzzle, once each,
-- and the total has to match the ten rounds. The +/- 1 day allows for
-- time zones. Nobody can edit or delete scores through the public key.
drop policy if exists "Anyone can post today's Plumb score" on public.plumb_scores;
create policy "Anyone can post today's Plumb score"
  on public.plumb_scores for insert
  to anon, authenticated
  with check (
    day between (current_date - date '2026-11-08') - 1
            and (current_date - date '2026-11-08') + 1
    and total = (select coalesce(sum(r), 0) from unnest(rounds) as r)
  );

grant select, insert on public.plumb_scores to anon, authenticated;

create index if not exists plumb_scores_day_idx on public.plumb_scores (day);
create index if not exists plumb_scores_player_idx on public.plumb_scores (player_id);

-- All-time table per player (uses the name from their latest score).
create or replace view public.plumb_player_stats with (security_invoker = on) as
select
  player_id,
  (array_agg(name order by created_at desc))[1] as name,
  count(*)                                      as games,
  round(avg(total))::int                        as avg_total,
  max(total)                                    as best
from public.plumb_scores
group by player_id;

grant select on public.plumb_player_stats to anon, authenticated;
