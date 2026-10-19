-- Final credential placeholders (sample demo values):
--   business address of record (federal grants): 123 Main Street, Suite 100, Springfield, ST 00000
--   NJ MBE certification: effective 1/2025, expiration 1/2030
--
-- the operator supplied MONTH AND YEAR only ("1/2025", "1/2030") — rendered as
-- "January 2025" / "January 2030", never as an ISO date. A fabricated
-- day-of-month in a compliance document is exactly the failure mode this
-- library avoids, and an MBE expiry is a field funders check.
--
-- Same discipline as migrations 035/036: UPDATE by key, guarded on the
-- placeholder text so it is a no-op wherever a human already edited the
-- block, never delete-and-reinsert, version + updated_at bumped on a real
-- change. Fresh installs get the corrected seeds.

UPDATE boilerplate_blocks
   SET body_markdown = REPLACE(
         body_markdown,
         'Address: [insert business address of record]',
         'Address (federal-grant address of record): 123 Main Street, Suite 100, Springfield, ST 00000'
       ),
       version = version + 1,
       updated_at = CAST(strftime('%s','now') AS INTEGER) * 1000
 WHERE key = 'acme-consulting-contact-info'
   AND body_markdown LIKE '%[insert business address of record]%';

UPDATE boilerplate_blocks
   SET body_markdown = REPLACE(
         REPLACE(body_markdown, '- Effective: [insert date]', '- Effective: January 2025'),
         '- Expiration: [insert date]',
         '- Expiration: January 2030'
       ),
       version = version + 1,
       updated_at = CAST(strftime('%s','now') AS INTEGER) * 1000
 WHERE key = 'acme-consulting-mbe-cert'
   AND body_markdown LIKE '%[insert date]%';
