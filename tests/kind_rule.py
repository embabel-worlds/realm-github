"""The FileChange.kind rule, once, in two languages.

`KIND_CYPHER` is the expression a child realm's producer computes from the file's path (`r.filename`
on GitHub); `kind(path)` is the same rule in Python, so a battery can derive the expected figures
from the forge's raw diff and hold the realm to them exactly. Change one, change both: the test
suite below the two definitions runs the Python half over fixed paths, and the GitHub battery runs
the Cypher half over live diffs against the Python half."""
import re

TEST_DIRS = ["/test/", "/tests/", "/__tests__/", "/spec/", "/it/", "/testing/", "/testdata/"]
TEST_TOPS = ["test/", "tests/", "spec/", "testing/", "testdata/"]
TEST_SUFFIX_CASED = ["Test.kt", "Tests.kt", "Test.java", "Tests.java", "Test.scala", "Spec.kt", "Spec.scala",
                     "Test.cs", "Tests.cs", "Test.swift", "Tests.swift", "Test.groovy", "Spec.groovy"]
TEST_SUFFIX_LOWER = [".test.ts", ".test.tsx", ".test.js", ".test.jsx", ".test.mjs", ".test.cjs",
                     ".spec.ts", ".spec.tsx", ".spec.js", ".spec.jsx", ".spec.mjs",
                     "_test.go", "_test.py", "_test.rb", "_spec.rb", "_test.exs", "_test.dart"]
DOC_EXT = ["md", "mdx", "adoc", "asciidoc", "rst", "txt"]
DOC_DIRS = ["docs/", "doc/"]
DOC_NAMES = ["license", "notice", "changelog", "contributing", "code_of_conduct", "authors", "security", "codeowners"]
BUILD_NAMES = ["pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts", "gradle.properties",
               "mvnw", "mvnw.cmd", "gradlew", "gradlew.bat", "package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock",
               "pyproject.toml", "setup.py", "setup.cfg", "pipfile", "pipfile.lock", "poetry.lock", "uv.lock",
               "go.mod", "go.sum", "cargo.toml", "cargo.lock", "gemfile", "gemfile.lock", "makefile", "cmakelists.txt",
               "jenkinsfile", "flake.nix", "flake.lock", ".gitlab-ci.yml", "bitbucket-pipelines.yml", "renovate.json",
               "build.xml", "build.sbt", "project.clj", "deps.edn", "mix.exs", "composer.json", "composer.lock",
               "webpack.config.js", "vite.config.ts", "vite.config.js", "vitest.config.ts", "vitest.config.mjs",
               "jest.config.js", "jest.config.ts", "babel.config.js", "rollup.config.js", "esbuild.mjs",
               ".npmrc", ".nvmrc", ".tool-versions", "sonar-project.properties", ".sonarcloud.properties"]
BUILD_PREFIX = ["tsconfig", "dockerfile", "docker-compose", "compose.", "requirements"]
BUILD_SUFFIX = [".csproj", ".fsproj", ".vbproj", ".sln", ".props", ".targets", ".gradle", ".gradle.kts", ".nix", ".lock", ".cmake"]
BUILD_DIRS = [".github/", ".gitlab/", ".circleci/", ".buildkite/", ".mvn/", "gradle/", ".azure-pipelines/", ".devcontainer/"]
SOURCE_EXT = ["kt", "kts", "java", "scala", "groovy", "clj", "cljs", "ts", "tsx", "js", "jsx", "mjs", "cjs", "vue", "svelte",
              "py", "pyi", "go", "rs", "rb", "php", "cs", "fs", "vb", "swift", "m", "mm", "c", "cc", "cpp", "cxx", "h", "hpp", "hh",
              "sh", "bash", "zsh", "fish", "ps1", "bat", "cmd", "sql", "cypher", "cql", "html", "htm", "css", "scss", "sass", "less",
              "dart", "lua", "pl", "pm", "r", "jl", "ex", "exs", "erl", "hs", "ml", "mli", "elm", "proto", "graphql", "gql",
              "tf", "hcl", "wasm", "wat", "ipynb", "jinja", "j2", "ftl", "mustache", "hbs", "ejs", "jsp", "thymeleaf", "scm", "lisp", "el"]
DATA_EXT = ["csv", "tsv", "parquet", "avro", "orc", "jsonl", "ndjson", "xlsx", "xls", "sqlite", "db", "arrow", "feather", "npy"]
CONFIG_EXT = ["yml", "yaml", "json", "json5", "xml", "properties", "toml", "ini", "cfg", "conf", "env", "editorconfig",
              "gitignore", "gitattributes", "dockerignore", "npmignore", "prettierrc", "eslintrc", "plist", "service"]


def kind(path):
    p = path.lower()
    f = p.rsplit("/", 1)[-1]
    cased = path.rsplit("/", 1)[-1]
    e = f.rsplit(".", 1)[-1] if "." in f else ""
    if (any(d in p for d in TEST_DIRS) or any(p.startswith(t) for t in TEST_TOPS)
            or any(cased.endswith(s) for s in TEST_SUFFIX_CASED) or any(f.endswith(s) for s in TEST_SUFFIX_LOWER)
            or (f.startswith("test_") and e == "py")):
        return "test"
    if (e in DOC_EXT or any(p.startswith(d) for d in DOC_DIRS) or any("/" + d in p for d in DOC_DIRS)
            or f in DOC_NAMES or f.startswith("readme") or f.startswith("license")):
        return "docs"
    if (f in BUILD_NAMES or any(f.startswith(x) for x in BUILD_PREFIX) or any(f.endswith(x) for x in BUILD_SUFFIX)
            or any(p.startswith(d) for d in BUILD_DIRS) or "/.github/" in p):
        return "build"
    if e in SOURCE_EXT:
        return "source"
    if e in DATA_EXT:
        return "data"
    if e in CONFIG_EXT or f.startswith("."):
        return "config"
    return "other"


def _lst(xs):
    return "[" + ", ".join("'" + x + "'" for x in xs) + "]"


def _any(var, op, xs):
    return "any(x IN " + _lst(xs) + " WHERE " + var + " " + op + " x)"


def _any_contains_in(var, xs):
    return "any(x IN " + _lst(xs) + " WHERE " + var + " CONTAINS x)"


CASE = (
    "CASE"
    " WHEN " + _any_contains_in("p", TEST_DIRS) + " OR " + _any("p", "STARTS WITH", TEST_TOPS)
    + " OR " + _any("c", "ENDS WITH", TEST_SUFFIX_CASED) + " OR " + _any("f", "ENDS WITH", TEST_SUFFIX_LOWER)
    + " OR (f STARTS WITH 'test_' AND e = 'py') THEN 'test'"
    " WHEN e IN " + _lst(DOC_EXT) + " OR " + _any("p", "STARTS WITH", DOC_DIRS) + " OR " + _any_contains_in("p", ["/" + d for d in DOC_DIRS])
    + " OR f IN " + _lst(DOC_NAMES) + " OR f STARTS WITH 'readme' OR f STARTS WITH 'license' THEN 'docs'"
    " WHEN f IN " + _lst(BUILD_NAMES) + " OR " + _any("f", "STARTS WITH", BUILD_PREFIX) + " OR " + _any("f", "ENDS WITH", BUILD_SUFFIX)
    + " OR " + _any("p", "STARTS WITH", BUILD_DIRS) + " OR p CONTAINS '/.github/' THEN 'build'"
    " WHEN e IN " + _lst(SOURCE_EXT) + " THEN 'source'"
    " WHEN e IN " + _lst(DATA_EXT) + " THEN 'data'"
    " WHEN e IN " + _lst(CONFIG_EXT) + " OR f STARTS WITH '.' THEN 'config'"
    " ELSE 'other' END"
)

# p: the lower-cased path; c: the file name as written (CamelCase test suffixes are matched
# case-sensitively so `latest.kt` is not a test); f: the lower-cased file name; e: the extension.
KIND_CYPHER = (
    "head([p IN [toLower(r.filename)] | head([c IN [last(split(r.filename, '/'))] | head([f IN [toLower(c)] | "
    "head([e IN [CASE WHEN f CONTAINS '.' THEN last(split(f, '.')) ELSE '' END] | " + CASE + "])])])])"
)

CASES = {
    "src/main/kotlin/com/embabel/agent/Foo.kt": "source",
    "src/test/kotlin/com/embabel/agent/FooTest.kt": "test",
    "embabel-agent-api/src/main/kotlin/Latest.kt": "source",
    "embabel-agent-api/src/main/kotlin/ArchitectureTest.kt": "test",
    "me-app/src/chat.test.ts": "test",
    "tests/ship-rate.spec.mjs": "test",
    "src/test/resources/application.yml": "test",
    "README.md": "docs", "docs/index.adoc": "docs", "LICENSE": "docs", "CLAUDE.md": "docs",
    "pom.xml": "build", "embabel-agent-api/pom.xml": "build", ".github/workflows/ci.yml": "build",
    "package.json": "build", "package-lock.json": "build", "tsconfig.build.json": "build", "Dockerfile": "build",
    "flake.nix": "build", "mvnw": "build", "build.gradle.kts": "build",
    "src/main/resources/application.yml": "config", ".gitignore": "config", "spotbugs-concurrency.xml": "config",
    "apis/api.github.com.json": "config", "data/prices.csv": "data", "logo.png": "other", "lib/thing.jar": "other",
    "scripts/run.sh": "source", "views/vocabulary.yml": "config", "src/main/java/Commit.java": "source",
}
if __name__ == "__main__":
    bad = {k: (kind(k), v) for k, v in CASES.items() if kind(k) != v}
    print("python rule:", "OK" if not bad else bad)
    print("cypher length:", len(KIND_CYPHER))
