-- A folder no longer chooses between posts and accounts: its list shows
-- each kind in a tab. `entity_type` stays only as a platform filter, naming
-- both kinds of the platform (`x.post,x.profile`), the way folders.ts now
-- writes it; naming both platforms (or neither) is no filter, so it goes.
-- Folder filters are canonical query strings with one `entity_type` and
-- `,` written `%2C`; replacing the parameter in place keeps the keys in
-- order, so the result is canonical too.
UPDATE `folders`
SET `filter` = (
  SELECT trim(head || CASE
      WHEN has_x AND NOT has_instagram THEN 'entity_type=x.post%2Cx.profile&'
      WHEN has_instagram AND NOT has_x
        THEN 'entity_type=instagram.post%2Cinstagram.profile&'
      ELSE '' END || tail, '&')
  FROM (
    SELECT head, tail,
      instr(types, ',x.') > 0 AS has_x,
      instr(types, ',instagram.') > 0 AS has_instagram
    FROM (
      SELECT substr(wrapped, 1, at) AS head,
        ',' || replace(substr(rest, 13, instr(rest, '&') - 13), '%2C', ',') AS types,
        substr(rest, instr(rest, '&') + 1) AS tail
      FROM (
        SELECT wrapped, at, substr(wrapped, at + 1) AS rest
        FROM (
          SELECT '&' || `folders`.`filter` || '&' AS wrapped,
            instr('&' || `folders`.`filter` || '&', '&entity_type=') AS at
        )
      )
    )
  )
)
WHERE instr('&' || `filter` || '&', '&entity_type=') > 0;
