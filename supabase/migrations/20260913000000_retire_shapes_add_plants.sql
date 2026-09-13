-- Curriculum direction change: no more shapes content, and animals/
-- plants/counting become the emphasized categories (see
-- worker/src/jobs/pick-topic.ts's weighted-LRU selection). 'colors_shapes'
-- is retired as a category name (the four real color topics move to a new
-- 'colors' category); the four pure-shape topics are marked `retired`
-- rather than deleted, since `episodes.topic_id references topics(id) on
-- delete restrict` would block deleting one that's already been aired.

alter table topics add column retired boolean not null default false;

-- The constraint must come off before these rows can be recategorized —
-- 'colors_shapes' won't be a valid value under the new constraint added
-- below, so every affected row has to move first.
alter table topics drop constraint topics_category_check;

-- Every former colors_shapes row (color or shape) needs a category value
-- that's still valid under the new constraint added next.
update topics set category = 'colors' where category = 'colors_shapes';

-- The shape-only topics: kept in place for existing episode history, just
-- excluded from future rotation.
update topics set retired = true
  where slug in ('circle-and-square', 'triangle-and-star', 'shapes-all-around-us', 'sorting-by-shape');

alter table topics add constraint topics_category_check check (category in
  ('phonics_abcs', 'counting_numbers', 'colors', 'animals', 'plants',
   'science_how_things_work', 'emotions_manners'));

insert into topics (category, title, slug, key_vocabulary) values
  ('plants', 'Parts of a Plant: Roots, Stem, Leaves', 'parts-of-a-plant', array['root','stem','leaf','plant']),
  ('plants', 'How Do Seeds Grow?', 'how-do-seeds-grow', array['seed','sprout','soil','grow']),
  ('plants', 'Flowers and Their Colors', 'flowers-and-their-colors', array['flower','petal','bloom','color']),
  ('plants', 'Trees Give Us Shade', 'trees-give-us-shade', array['tree','branch','leaf','shade']),
  ('plants', 'Fruits and Vegetables We Eat', 'fruits-and-vegetables-we-eat', array['fruit','vegetable','plant','eat']),
  ('plants', 'Plants Need Sun and Water', 'plants-need-sun-and-water', array['sun','water','plant','grow']),
  ('plants', 'Big Trees, Small Flowers', 'big-trees-small-flowers', array['tree','flower','big','small']),
  ('plants', 'How Plants Help Animals', 'how-plants-help-animals', array['plant','animal','food','home'])
on conflict (slug) do nothing;
