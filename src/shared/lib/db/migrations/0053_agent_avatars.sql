ALTER TABLE `agents` ADD `avatar_color` text DEFAULT 'tonal-blue' NOT NULL;--> statement-breakpoint
ALTER TABLE `agents` ADD `avatar_shape` text DEFAULT 'circle' NOT NULL;--> statement-breakpoint
-- Backfill once in the same atomic migration as the column additions. Keep
-- this historical palette fixed: later palette edits must not reassign agents.
-- Applying abs after the remainder avoids SQLite's minimum-integer overflow.
UPDATE `agents` SET
  `avatar_color` = CASE abs(random() % 12)
    WHEN 0 THEN 'tonal-red'
    WHEN 1 THEN 'tonal-orange'
    WHEN 2 THEN 'tonal-amber'
    WHEN 3 THEN 'tonal-green'
    WHEN 4 THEN 'tonal-forest'
    WHEN 5 THEN 'tonal-teal'
    WHEN 6 THEN 'tonal-blue'
    WHEN 7 THEN 'Cobalt'
    WHEN 8 THEN 'tonal-purple'
    WHEN 9 THEN 'tonal-blush'
    WHEN 10 THEN 'tonal-pink'
    ELSE 'tonal-brown'
  END,
  `avatar_shape` = CASE abs(random() % 8)
    WHEN 0 THEN 'circle'
    WHEN 1 THEN 'squircle'
    WHEN 2 THEN 'triangle'
    WHEN 3 THEN 'diamond'
    WHEN 4 THEN 'hexagon'
    WHEN 5 THEN 'pill'
    WHEN 6 THEN 'arch'
    ELSE 'bloom'
  END;
