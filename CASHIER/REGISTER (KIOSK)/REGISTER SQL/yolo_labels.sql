-- ============================================================
-- Link every kept YOLO class to its product (products.yolo_label). Safe to re-run.
-- yolo_label must be the class name exactly as in data.yaml (case/spaces/punctuation are ignored).
-- Step 1: run the SELECT at the bottom first to see your real product names, then adjust any
--         ilike pattern that doesn't match what you actually named the product.
-- ============================================================

-- the 5 products you already have (exact names)
update products set yolo_label = 'lemon square'   where name = 'Lemon Square Cheesecake';
update products set yolo_label = 'hansel'         where name = 'Hansel Crackers';
update products set yolo_label = 'pillows'        where name = 'Pillows Chocolate';
update products set yolo_label = 'piattos cheese' where name = 'Piattos Cheese';
update products set yolo_label = 'moby chocolate' where name = 'Moby Chocolate';

-- the other kept classes: they only link once a product with a matching name exists (0 rows = no such product yet)
update products set yolo_label = 'Moby Caramel'    where name ilike '%moby%caramel%';
update products set yolo_label = 'cheezy'          where name ilike '%cheezy%';
update products set yolo_label = 'choco mucho'     where name ilike '%choco%mucho%';
update products set yolo_label = 'fita'            where name ilike '%fita%';
update products set yolo_label = 'loaded'          where name ilike '%loaded%';
update products set yolo_label = 'mountain dew'    where name ilike '%mountain dew%';
update products set yolo_label = 'mr chips'        where name ilike '%mr%chips%';
update products set yolo_label = 'oishi crackers'  where name ilike '%oishi%cracker%';
update products set yolo_label = 'pepsi'           where name ilike '%pepsi%';
update products set yolo_label = 'royal'           where name ilike '%royal%';
update products set yolo_label = 'sky flakes'      where name ilike '%sky%flakes%';
update products set yolo_label = 'sprite'          where name ilike '%sprite%';
update products set yolo_label = 'sting'           where name ilike '%sting%';
update products set yolo_label = 'vcut cheese'     where name ilike '%vcut%' or name ilike '%v-cut%' or name ilike '%v cut%';

-- clear labels of the 22 removed classes, so nothing points at a class the model no longer has
update products set yolo_label = null
where regexp_replace(lower(yolo_label), '[^a-z0-9]', '', 'g') in (
  'afritada','datuputipatis','datuputisoysauce','datuputisuka','sugar','tomi','argentinacornedbeef',
  'argentinameatloaf','bearbrand','colgate','creamsilk','egg','energen','ketchupufc','kopikoblack',
  'luckymecicken','mangtomas','palmolivesoap','pancitcantoncalamansi','pancitcantonsweetandspicy',
  'reno','sanmarino');

-- check: every product the camera should see must have a yolo_label; the rest can stay NULL
select name, yolo_label from products where status = 'active' order by name;