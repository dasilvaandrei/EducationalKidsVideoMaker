-- Curriculum bank seed. Loaded automatically by `supabase db reset` for
-- local dev (see config.toml's [db.seed] sql_paths). The live project was
-- seeded with this exact same content via the REST API on 2026-09-01 —
-- keep the two in sync if this list changes.
--
-- 48 topics, 8 per category, rotating across the six early-learning
-- categories per the plan's "broad early-learning rotation" curriculum.

insert into topics (category, title, slug, key_vocabulary) values
  ('phonics_abcs', 'Letter A: Apple, Alligator, Ant', 'letter-a', array['apple','alligator','ant','A']),
  ('phonics_abcs', 'Letter B: Ball, Bear, Butterfly', 'letter-b', array['ball','bear','butterfly','B']),
  ('phonics_abcs', 'Letter C: Cat, Cookie, Car', 'letter-c', array['cat','cookie','car','C']),
  ('phonics_abcs', 'Letter M: Moon, Monkey, Mouse', 'letter-m', array['moon','monkey','mouse','M']),
  ('phonics_abcs', 'Letter S: Sun, Snake, Star', 'letter-s', array['sun','snake','star','S']),
  ('phonics_abcs', 'Letter T: Tiger, Turtle, Train', 'letter-t', array['tiger','turtle','train','T']),
  ('phonics_abcs', 'Rhyming Words: Cat, Hat, Bat', 'rhyming-words-cat-hat-bat', array['cat','hat','bat','rhyme']),
  ('phonics_abcs', 'First Sounds: What Does It Start With?', 'first-sounds', array['sound','letter','start','word']),

  ('counting_numbers', 'Counting to 5', 'counting-to-5', array['one','two','three','four','five']),
  ('counting_numbers', 'Counting to 10', 'counting-to-10', array['six','seven','eight','nine','ten']),
  ('counting_numbers', 'Numbers on the Farm', 'numbers-on-the-farm', array['count','farm','animals','number']),
  ('counting_numbers', 'Big and Small: Comparing Sizes', 'big-and-small', array['big','small','bigger','smaller']),
  ('counting_numbers', 'Counting Backwards from 5', 'counting-backwards-from-5', array['five','four','three','two','one','blastoff']),
  ('counting_numbers', 'More or Less: Which Group Has More?', 'more-or-less', array['more','less','group','compare']),
  ('counting_numbers', 'Odd One Out: Counting Groups', 'counting-groups', array['group','count','match','different']),
  ('counting_numbers', 'Counting by Twos', 'counting-by-twos', array['two','pair','count','twos']),

  ('colors_shapes', 'Primary Colors: Red, Yellow, Blue', 'primary-colors', array['red','yellow','blue','color']),
  ('colors_shapes', 'Circle and Square', 'circle-and-square', array['circle','square','round','corner']),
  ('colors_shapes', 'Triangle and Star', 'triangle-and-star', array['triangle','star','point','shape']),
  ('colors_shapes', 'Mixing Colors: Making Green and Purple', 'mixing-colors', array['green','purple','mix','color']),
  ('colors_shapes', 'Colors in Nature', 'colors-in-nature', array['color','flower','sky','grass']),
  ('colors_shapes', 'Shapes All Around Us', 'shapes-all-around-us', array['shape','circle','square','triangle']),
  ('colors_shapes', 'Rainbow Colors', 'rainbow-colors', array['rainbow','red','orange','yellow','green','blue','purple']),
  ('colors_shapes', 'Sorting by Shape', 'sorting-by-shape', array['sort','shape','same','group']),

  ('animals', 'Farm Animals: Cow, Pig, Chicken', 'farm-animals', array['cow','pig','chicken','farm']),
  ('animals', 'Ocean Animals: Fish, Whale, Octopus', 'ocean-animals', array['fish','whale','octopus','ocean']),
  ('animals', 'Jungle Animals: Lion, Elephant, Monkey', 'jungle-animals', array['lion','elephant','monkey','jungle']),
  ('animals', 'Baby Animals and Their Names', 'baby-animals', array['puppy','kitten','calf','baby']),
  ('animals', 'Animal Sounds', 'animal-sounds', array['moo','woof','meow','sound']),
  ('animals', 'Animals That Fly', 'animals-that-fly', array['bird','butterfly','bee','fly']),
  ('animals', 'Nocturnal Animals: Who''s Awake at Night?', 'nocturnal-animals', array['owl','bat','night','awake']),
  ('animals', 'Pets We Love', 'pets-we-love', array['dog','cat','pet','friend']),

  ('science_how_things_work', 'Why Does It Rain?', 'why-does-it-rain', array['rain','cloud','water','weather']),
  ('science_how_things_work', 'How Do Plants Grow?', 'how-do-plants-grow', array['seed','plant','water','sun']),
  ('science_how_things_work', 'Why Is the Sky Blue?', 'why-is-the-sky-blue', array['sky','blue','sun','light']),
  ('science_how_things_work', 'Floating and Sinking', 'floating-and-sinking', array['float','sink','water','heavy']),
  ('science_how_things_work', 'Day and Night', 'day-and-night', array['day','night','sun','moon']),
  ('science_how_things_work', 'The Four Seasons', 'the-four-seasons', array['spring','summer','fall','winter']),
  ('science_how_things_work', 'How Do Magnets Work?', 'how-do-magnets-work', array['magnet','stick','pull','metal']),
  ('science_how_things_work', 'Where Does Our Food Come From?', 'where-does-food-come-from', array['farm','food','grow','eat']),

  ('emotions_manners', 'Feeling Happy', 'feeling-happy', array['happy','smile','joy','glad']),
  ('emotions_manners', 'Feeling Sad and How to Feel Better', 'feeling-sad', array['sad','hug','better','feelings']),
  ('emotions_manners', 'Saying Please and Thank You', 'please-and-thank-you', array['please','thank you','polite','kind']),
  ('emotions_manners', 'Sharing With Friends', 'sharing-with-friends', array['share','friend','turn','kind']),
  ('emotions_manners', 'Feeling Scared, and That''s OK', 'feeling-scared-its-ok', array['scared','brave','safe','ok']),
  ('emotions_manners', 'Taking Turns', 'taking-turns', array['turn','wait','share','fair']),
  ('emotions_manners', 'Saying Sorry', 'saying-sorry', array['sorry','oops','forgive','friend']),
  ('emotions_manners', 'Being a Good Friend', 'being-a-good-friend', array['friend','kind','help','share'])
on conflict (slug) do nothing;
