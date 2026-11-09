-- Hexed leaderboard setup.
-- Paste this whole file into Supabase: SQL Editor -> New query -> Run.
-- It is safe to run more than once.

create table if not exists public.scores (
  id          bigint generated always as identity primary key,
  day         int         not null check (day >= 0),           -- puzzle number minus 1 (No. 1 = day 0)
  player_id   uuid        not null,                            -- random id kept in the player's browser
  name        text        not null check (char_length(name) between 1 and 20),
  guesses     int         not null check (guesses between 1 and 7), -- 7 means not solved
  won         boolean     not null,
  best_match  int         not null check (best_match between 0 and 100),
  created_at  timestamptz not null default now(),
  unique (day, player_id),
  check ((won and guesses <= 6) or (not won and guesses = 7))
);

alter table public.scores enable row level security;

drop policy if exists "Anyone can read scores" on public.scores;
create policy "Anyone can read scores"
  on public.scores for select
  to anon, authenticated
  using (true);

-- Players can only post a score for (roughly) today's puzzle, once each.
-- The +/- 1 day allows for time zones. Nobody can edit or delete scores
-- through the public key.
drop policy if exists "Anyone can post today's score" on public.scores;
create policy "Anyone can post today's score"
  on public.scores for insert
  to anon, authenticated
  with check (day between (current_date - date '2026-11-09') - 1
                      and (current_date - date '2026-11-09') + 1);

grant select, insert on public.scores to anon, authenticated;

create index if not exists scores_day_idx on public.scores (day);
create index if not exists scores_player_idx on public.scores (player_id);

-- All-time ranking per player (uses the name from their latest score).
create or replace view public.player_stats with (security_invoker = on) as
select
  player_id,
  (array_agg(name order by created_at desc))[1]       as name,
  count(*)                                            as games,
  count(*) filter (where won)                         as wins,
  round(avg(guesses) filter (where won), 2)           as avg_guesses
from public.scores
group by player_id;

-- Totals across everyone.
create or replace view public.global_stats with (security_invoker = on) as
select
  count(*)                                  as games,
  count(*) filter (where won)               as wins,
  round(avg(guesses) filter (where won), 2) as avg_guesses,
  count(distinct player_id)                 as players
from public.scores;

grant select on public.player_stats, public.global_stats to anon, authenticated;
