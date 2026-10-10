package store

import (
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"testing"
)

func TestSplitSQL(t *testing.T) {
	got := splitSQL(`-- leading; comment
CREATE TABLE a (v text DEFAULT 'x;y', "odd;name" int); /* block; /* nested; */ still */
CREATE FUNCTION f() RETURNS text LANGUAGE sql AS $body$ SELECT ';' || $1; $body$;
INSERT INTO a VALUES (E'it\'s; fine', 1);
SELECT 'don''t; split' ;
-- trailing comment only
`)
	want := []string{
		`-- leading; comment
CREATE TABLE a (v text DEFAULT 'x;y', "odd;name" int)`,
		`/* block; /* nested; */ still */
CREATE FUNCTION f() RETURNS text LANGUAGE sql AS $body$ SELECT ';' || $1; $body$`,
		`INSERT INTO a VALUES (E'it\'s; fine', 1)`,
		`SELECT 'don''t; split'`,
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("statements:\n%q\nwant:\n%q", got, want)
	}
}

func TestNormalizeSQLIgnoresLayoutOnly(t *testing.T) {
	compact := `create function f() returns text language plpgsql as $$begin -- why
return 'Kept  Case';end$$; create index i on t using btree(a,"Mixed");`
	formatted := `CREATE FUNCTION f ()
    RETURNS text
    LANGUAGE plpgsql
    AS $$
BEGIN
    RETURN 'Kept  Case';
END
$$;

/* moved comment */
CREATE INDEX i ON t USING btree (a, "Mixed");
`
	if normalizeSQL(compact) != normalizeSQL(formatted) {
		t.Fatalf("layout changed the identity:\n%s\n%s", normalizeSQL(compact), normalizeSQL(formatted))
	}
	for _, changed := range []string{
		`create function f() returns text language plpgsql as $$begin return 'kept  case';end$$; create index i on t using btree(a,"Mixed");`,
		`create function f() returns text language plpgsql as $$begin return 'Kept Case';end$$; create index i on t using btree(a,"Mixed");`,
		`create function f() returns text language plpgsql as $$begin return 'Kept  Case';end$$; create index i on t using btree(a,"mixed");`,
		`create function f() returns text language plpgsql as $$begin return 'Kept  Case';end$$; create index i on t using btree(b,"Mixed");`,
	} {
		if normalizeSQL(changed) == normalizeSQL(compact) {
			t.Fatalf("a real change kept the identity: %s", changed)
		}
	}
}

// The formatter's own output must not change what a migration is, whichever
// options or version produced the file that was applied.
func TestNormalizeSQLSurvivesFormatter(t *testing.T) {
	formatter := os.Getenv("TEST_PG_FORMAT")
	if formatter == "" {
		t.Skip("TEST_PG_FORMAT not set")
	}
	names, err := filepath.Glob("migrations/*.sql")
	if err != nil || len(names) == 0 {
		t.Fatal(names, err)
	}
	reformatted := false
	for _, name := range names {
		body, err := os.ReadFile(name)
		if err != nil {
			t.Fatal(err)
		}
		for _, options := range [][]string{
			{"--keyword-case", "1", "--function-case", "1", "--spaces", "2"},
			{"--keyword-case", "2", "--comma-start"},
			{"--nocomment", "--no-space-function"},
		} {
			out, err := exec.Command(formatter, append(options, name)...).Output()
			if err != nil {
				t.Fatal(name, options, err)
			}
			reformatted = reformatted || string(out) != string(body)
			if normalizeSQL(string(out)) != normalizeSQL(string(body)) {
				t.Errorf("%s changed identity under %v", name, options)
			}
		}
	}
	if !reformatted {
		t.Fatal("the formatter options changed no file, so nothing was compared")
	}
}
