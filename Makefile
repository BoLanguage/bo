# Build, check and test everything from the repository root. Run `make help`.
SHELL := /bin/bash

PY ?= .venv/bin/python
EMSDK_ENV ?= $(HOME)/emsdk/emsdk_env.sh
EMSDK_DIR := $(patsubst %/,%,$(dir $(EMSDK_ENV)))
VERSION_NUMBER := $(word 1,$(file < VERSION))

HAVE_EMCC := $(shell command -v emcc >/dev/null 2>&1 || [ -f "$(EMSDK_ENV)" ] && echo yes)

# `make all` builds what this machine can; the explicit targets fail loudly instead.
# `make deps` installs everything these checks look for (except Emscripten: `make emsdk`).
ALL := generate c
ifeq ($(HAVE_EMCC),yes)
ALL += wasm
else
$(info note: Emscripten not found (`make emsdk`, or set EMSDK_ENV): skipping the WebAssembly build)
endif
ifneq ($(wildcard playground/vendor-src/node_modules),)
ALL += vendor
else
$(info note: playground/vendor-src/node_modules missing (`make deps`): skipping the playground editor bundle)
endif
ifneq ($(wildcard jupyterlab/node_modules),)
ALL += jupyterlab
else
$(info note: jupyterlab/node_modules missing (`make deps`): skipping the JupyterLab extension)
endif
ifneq ($(wildcard vscode/node_modules),)
ALL += vsix
else
$(info note: vscode/node_modules missing (`make deps`): skipping the VS Code extension package)
endif

.PHONY: all help deps tools emsdk generate c wasm vendor jupyterlab vsix playground playground-plus check test test-python test-diff test-wasm test-playground test-playground-plus llm-eval clean release

all: $(ALL) ## Generated files, C runtime, and whichever optional parts are available

help: ## List the targets
	@grep -hE '^[a-zA-Z_-]+:.*##' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  make %-12s %s\n", $$1, $$2}'

deps: tools $(PY) ## Install the dependencies for `make all`: .venv with uv, and npm packages
	uv pip install --python $(PY) -r pyproject.toml --extra jupyter
	npm install --prefix playground/vendor-src
	npm install --prefix jupyterlab
	npm install --prefix vscode
	npm install --prefix playground-plus
	@command -v emcc >/dev/null 2>&1 || [ -f "$(EMSDK_ENV)" ] || \
	    echo "note: Emscripten is not installed: run 'make emsdk' to get the WebAssembly build"

tools:
	@missing=; for tool in cc python3 node npm uv; do \
	    command -v $$tool >/dev/null 2>&1 || missing="$$missing $$tool"; done; \
	    [ -z "$$missing" ] || { echo "missing system tools:$$missing (install them with your package manager)" >&2; exit 1; }

$(PY):
	uv venv .venv

emsdk: ## Install Emscripten with emsdk into ~/emsdk (a large download, so opt-in)
	[ -d "$(EMSDK_DIR)" ] || git clone https://github.com/emscripten-core/emsdk.git "$(EMSDK_DIR)"
	cd "$(EMSDK_DIR)" && ./emsdk install latest && ./emsdk activate latest

generate: ## Regenerate include/core.bo, doc/*.md, the editor syntax data and the npm package versions
	python3 tools/sync_version.py
	python3 tools/generate_adapters.py
	python3 tools/bodoc.py
	python3 tools/generate_vscode_grammar.py

c: generate ## Build the native runtime (c/bo)
	$(MAKE) -C c

wasm: generate ## Build the WebAssembly runtime (wasm/build); needs Emscripten
	@if ! command -v emcc >/dev/null 2>&1; then \
	    [ -f "$(EMSDK_ENV)" ] || { echo "Emscripten not found: make emsdk, or set EMSDK_ENV" >&2; exit 1; }; \
	    source "$(EMSDK_ENV)" >/dev/null 2>&1; \
	fi; $(MAKE) -C c wasm

vendor: generate ## Rebuild the playground's CodeMirror bundle (playground/vendor/codemirror.js)
	cd playground/vendor-src && { [ -d node_modules ] || npm install; } && npm run build

jupyterlab: generate ## Build the JupyterLab highlighter extension
	cd jupyterlab && { [ -d node_modules ] || npm install; } && \
	    PATH="$(abspath $(dir $(PY))):$$PATH" npm run build

vsix: generate ## Package the VS Code extension as vscode/bolang-<VERSION>.vsix (install it manually)
	rm -f vscode/bolang-*.vsix
	cd vscode && { [ -d node_modules ] || npm install; } && \
	    npx vsce package -o bolang-$(VERSION_NUMBER).vsix

check: ## Verify that the generated files and package versions are up to date
	python3 tools/sync_version.py --check
	python3 tools/generate_adapters.py --check
	python3 tools/bodoc.py --check
	python3 tools/generate_vscode_grammar.py --check

test: all test-python test-diff test-wasm test-playground test-playground-plus ## Build, then run every test suite

test-python: $(PY) ## Python unit tests (also run the examples, docs and Node tests)
	$(PY) -m unittest discover tests

test-diff: $(PY) c ## Differential test: C runtime against the Python reference
	$(PY) -m tests.diff_c

test-wasm: ## Node tests for the WebAssembly runtime (need the WebAssembly build)
	@if [ ! -f wasm/build/bo-core.wasm ]; then echo "skipping wasm tests: no WebAssembly build"; exit 0; fi; \
	for t in examples parallel debugger; do \
	    echo "wasm/test_$$t.mjs"; node wasm/test_$$t.mjs || exit 1; \
	done

test-playground: ## Node tests for the playground (need the WebAssembly build)
	@if [ ! -f wasm/build/bo-core.wasm ]; then echo "skipping playground tests: no WebAssembly build"; exit 0; fi; \
	for t in puzzles store views helpers onboarding stackops; do \
	    echo "playground/test_$$t.mjs"; node playground/test_$$t.mjs || exit 1; \
	done

test-playground-plus: ## Node tests for Playground+ (the server needs no build, the WebAssembly build is optional)
	for t in db server api recorder harness compile brief new_puzzle profile watch stage launch generator agent_player service mcp eval; do \
	    echo "playground-plus/test_$$t.mjs"; node --disable-warning=ExperimentalWarning playground-plus/test_$$t.mjs || exit 1; \
	done

# PORT=n picks another port; OPEN=0 does not open a browser
PORT ?=
OPEN ?= 1

playground: ## Serve the playground and open it in a browser (needs `make wasm`; PORT=n, OPEN=0)
	python3 tools/serve_playground.py $(if $(PORT),--port $(PORT)) $(if $(filter 0,$(OPEN)),--no-open)

playground-plus: ## Run Playground+ and open it in a browser (needs `make wasm`; PORT=n, OPEN=0)
	cd playground-plus && npm start -- $(PORT) $(if $(filter 0,$(OPEN)),--no-open)

MODELS ?= qwen3.5:9b,gemma4:12b
TRIALS ?= 3

llm-eval: ## Ask local Ollama models to write puzzles through the MCP server (needs Ollama and `make wasm`; MODELS=a,b TRIALS=n)
	node --disable-warning=ExperimentalWarning playground-plus/eval/run.mjs --models "$(MODELS)" --trials $(TRIALS)

clean: ## Remove c/bo, wasm/build and the packaged VSIX
	$(MAKE) -C c clean
	rm -f vscode/bolang-*.vsix

# VERSION=x.y.z is required; the rest is optional
release: ## Release: make release VERSION=x.y.z [SUMMARY="..."] [DATE=] [SKIP_TESTS=1] [ALLOW_DIRTY=1]
	@[ -n "$(VERSION)" ] || { echo 'usage: make release VERSION=x.y.z [SUMMARY="title"]' >&2; exit 1; }
	python3 tools/release.py "$(VERSION)" $(if $(SUMMARY),--summary "$(SUMMARY)") \
	    $(if $(DATE),--date "$(DATE)") $(if $(SKIP_TESTS),--skip-tests) $(if $(ALLOW_DIRTY),--allow-dirty)
