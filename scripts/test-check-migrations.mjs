#!/usr/bin/env node
import assert from "node:assert/strict";
import { test } from "node:test";

import { problems } from "./check-migrations.mjs";

const base = ["0001_initial.sql", "20260102000000_b.sql"];

test("new migrations after the base are accepted", () => {
  assert.deepEqual(problems(base, [...base, "20260103000000_c.sql"]), []);
  assert.deepEqual(problems(base, base), []);
  assert.deepEqual(problems([], ["0001_initial.sql"]), []);
});

test("a new migration that sorts into the base history is reported", () => {
  assert.deepEqual(problems(base, [...base, "20260101000000_a.sql"]), [
    "20260101000000_a.sql sorts before 20260102000000_b.sql; rename it to run last",
  ]);
});

test("removing or renaming a base migration is reported", () => {
  assert.deepEqual(
    problems(base, ["0001_initial.sql", "20260104000000_b.sql"]),
    [
      "20260102000000_b.sql was removed or renamed; an applied migration stays as it is",
    ],
  );
});
