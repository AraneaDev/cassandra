# Changelog

## [0.0.2](https://github.com/AraneaDev/cassandra/compare/v0.0.1...v0.0.2) (2026-08-28)


### Documentation

* stop saying the same thing twice, and drop a hollow contrast ([#2](https://github.com/AraneaDev/cassandra/issues/2)) ([c04d43b](https://github.com/AraneaDev/cassandra/commit/c04d43b9208ef1d45e8d6dfb39fbfd0ca6069918))

## 0.0.1 (2026-08-28)


### Features

* add the cassandra CLI and slash command ([abafce0](https://github.com/AraneaDev/cassandra/commit/abafce005ceb2ae11b82b36da1de04291335f153))
* compile the hook binary and wire the plugin's six events ([85fd6c7](https://github.com/AraneaDev/cassandra/commit/85fd6c7856f789ae18c6d4c487087fc980aec6e0))
* count compactions per session for boundary attribution ([d0328dd](https://github.com/AraneaDev/cassandra/commit/d0328dd0fa8b167427c5e978e81dc0610de72a27))
* fingerprint Bash and MCP calls with stingy normalization ([230d39e](https://github.com/AraneaDev/cassandra/commit/230d39eb8def9ad358cf64a5c38b4e2ed173715b))
* log warning efficacy and attribute each warning to a boundary ([fb2ccd9](https://github.com/AraneaDev/cassandra/commit/fb2ccd940b1e64f414301c3198ba7dabd394e9ce))
* probe workspace freshness with a git path and a bounded mtime fallback ([dd775fa](https://github.com/AraneaDev/cassandra/commit/dd775faf7b04bccd5f3d83abf7a45f6a15f24cf0))
* resolve data root, repo root and per-project index paths ([993dcfa](https://github.com/AraneaDev/cassandra/commit/993dcfa3ce8d35b2b0320fb258cfb4a0a7af7263))
* route hook events through record, gate and warn paths ([df2668f](https://github.com/AraneaDev/cassandra/commit/df2668fe61b3f63479104fb055bf3d1d41bf5059))
* store, increment and self-heal failure records ([28772f7](https://github.com/AraneaDev/cassandra/commit/28772f7c1a8e032097819e8d96a1cf91ea6e974f))


### Fixes

* accept the hash prefix that list actually prints ([bd17c52](https://github.com/AraneaDev/cassandra/commit/bd17c52e27fa830459c06e78d69a9368df1010ea))
* anchor matcher patterns to avoid over-matching tool names ([2d42ad3](https://github.com/AraneaDev/cassandra/commit/2d42ad3ad03dfa043fc3fd8f49765d67b865a27d))
* correct boundary attribution and validate event shapes ([be2b7d7](https://github.com/AraneaDev/cassandra/commit/be2b7d7749d114dc0a614c6f1b722d759bf1e906))
* guard every derived path segment behind one shared sanitizer ([a38b325](https://github.com/AraneaDev/cassandra/commit/a38b325be2e282b58817ddafc3e54b0c0d586b25))
* guard pendingPath against path traversal via degenerate inputs ([ad99aab](https://github.com/AraneaDev/cassandra/commit/ad99aab12ebd27280b7f896084c6028c8ef1647e))
* handle non-string tool_use_id and hook_event_name; widen fuzz with unwritable-path test ([e33a3df](https://github.com/AraneaDev/cassandra/commit/e33a3dff7f99f30b0b11ce046edd67e02d36ede5))
* name the scope the freshness probe actually checked ([8fb95c3](https://github.com/AraneaDev/cassandra/commit/8fb95c3f9c29e3ce077652d360e567b5f8fd4bc1))
* preserve newlines when normalising commands ([aa25e6a](https://github.com/AraneaDev/cassandra/commit/aa25e6ac0ae64c36ff875c31340abf19220c88e6))
* replace stray control bytes in the plan with escape sequences ([15f82ca](https://github.com/AraneaDev/cassandra/commit/15f82ca326c7977a5d445c0fd9af6969b7f919b0))
* stage and rename record writes, and sweep stale pending markers ([d40d7dc](https://github.com/AraneaDev/cassandra/commit/d40d7dcf90f6b1afd7d44cf486fc1e2312b9f556))
* stop markdownlint from linting the git-ignored .superpowers workspace ([5c5dfe7](https://github.com/AraneaDev/cassandra/commit/5c5dfe70f6a01050e5c070a67d71d4a94c8eb9f3))
* stop the mtime walk conflating unreadable subtrees with deleted ones ([8539520](https://github.com/AraneaDev/cassandra/commit/85395208db69c9fd92af4c5cf04d301f3406e742))
* strip control characters from the stored excerpt and fence it on replay ([7f8839d](https://github.com/AraneaDev/cassandra/commit/7f8839d71b49d12147247d04b0de0ebd07d159fb))
* two defects found by running the plugin for real ([9afdad5](https://github.com/AraneaDev/cassandra/commit/9afdad5f6d98a134abc530ae9657e7a4c7ebb2fb))
* validate all required fields and handle stray index entries ([99db3dd](https://github.com/AraneaDev/cassandra/commit/99db3dd638d30c66d48007470d7269e7e3eb1325))


### Documentation

* add Cassandra design spec ([368a3a9](https://github.com/AraneaDev/cassandra/commit/368a3a95d30f932b72b091f2dea468ac9fae23ff))
* add Cassandra implementation plan ([2df90e5](https://github.com/AraneaDev/cassandra/commit/2df90e542ca4ff5d47963213a1482592ac68a8a0))
* add README and close the PostCompact wiring gap in the spec ([2992edf](https://github.com/AraneaDev/cassandra/commit/2992edf73c025a9c3655a7c4e8295c80f4930fd3))
* correct the overhead figure, what Cassandra reads, and the probe outlier ([e94885d](https://github.com/AraneaDev/cassandra/commit/e94885dc8891f67563857704dd57461ef3acdd5b))
* correct the test-count badge ([17fa0c7](https://github.com/AraneaDev/cassandra/commit/17fa0c79a69f8b6382b1150c70f8c0f269f5eea9))
* tighten Cassandra spec after self-review ([225eab1](https://github.com/AraneaDev/cassandra/commit/225eab13e7382cc3ffd1eb7b89d3d31eab132ca6))


### Tests

* assert the hook never throws, never exits non-zero and never emits stray stdout ([6563b15](https://github.com/AraneaDev/cassandra/commit/6563b151aa8242e199fb36db71f1a080d8ace1f3))
* cover the CLI refusal of a hash that is not a fingerprint ([27e2b3a](https://github.com/AraneaDev/cassandra/commit/27e2b3a8a25a07b0e3cfed7b0c1bf3c3754603ad))
* discriminate the agentId wiring in attributeBoundary ([10bc100](https://github.com/AraneaDev/cassandra/commit/10bc10091201ad0342d55776c66579a3714f1d75))
* drive a non-ENOENT failure through the mtime walk ([aaf9b90](https://github.com/AraneaDev/cassandra/commit/aaf9b90b62d9f1c4387f6c59102952a677eb6982))
* exercise the hook against payloads harvested from real transcripts ([c353b12](https://github.com/AraneaDev/cassandra/commit/c353b12fbe368eb26a548565495bc22bc7467c96))
* **fixtures:** exercise warning emission on real harvested payloads ([e7c6b52](https://github.com/AraneaDev/cassandra/commit/e7c6b528184feba601d61be22062cfa0fa1b9e14))
* hold the fixture replay to a proportional warning floor ([e95fef1](https://github.com/AraneaDev/cassandra/commit/e95fef1b71732070b895fed37dc802f91b1e688a))
* make the four robustness shape assertions actually execute ([205c190](https://github.com/AraneaDev/cassandra/commit/205c190acd731a7b20f60b366eb0893e111b4739))
* record the freshness probe baseline across real repositories ([99f2d3d](https://github.com/AraneaDev/cassandra/commit/99f2d3d1e1c3732b7ca490b2534442eae820bbfc))
* rename test to describe what it actually exercises ([5f8f6d1](https://github.com/AraneaDev/cassandra/commit/5f8f6d11e589eb1b9239e058467cc2311fd82530))
* run everywhere, not only on the machine that wrote them ([9051e2b](https://github.com/AraneaDev/cassandra/commit/9051e2bead909cd6bb293b6f20d86119ad46c804))


### Continuous integration

* run the checks the other plugins in this marketplace run ([609a5e0](https://github.com/AraneaDev/cassandra/commit/609a5e02b938d3e084955a54923bf5c1a3f98d4c))


### Refactoring

* drop the project-wide knip export suppression ([91f0506](https://github.com/AraneaDev/cassandra/commit/91f05061006248c8089bc13edbddd9bb09b68130))
