# Build, check and test everything from the repository root. Run `make help`.
SHELL := /bin/bash

PY ?= .venv/bin/python
EMSDK_ENV ?= $(HOME)/emsdk/emsdk_env.sh
EMSDK_DIR := $(patsubst %/,%,$(dir $(EMSDK_ENV)))
VERSION_NUMBER := $(word 1,$(file < VERSION))

.PHONY: all help deps tools emsdk ensure-emsdk generate c wasm vendor jupyterlab vsix playground playground-plus check test test-python test-diff test-wasm test-playground test-playground-plus llm-eval clean release

all: ## Install missing dependencies and build all components (first run downloads Emscripten)
	$(MAKE) deps
	$(MAKE) ensure-emsdk
	$(MAKE) c wasm vendor jupyterlab vsix

help: ## List the targets
	@grep -hE '^[a-zA-Z_-]+:.*##' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  make %-12s %s\n", $$1, $$2}'

deps: tools ## Check and install project dependencies if needed
	$(MAKE) $(PY)
	@if uv pip install --check --offline --python $(PY) -r pyproject.toml --extra jupyter >/dev/null 2>&1; then \
	    echo "Python dependencies already installed"; \
	else \
	    echo "Installing Python dependencies"; \
	    uv pip install --python $(PY) -r pyproject.toml --extra jupyter || exit $$?; \
	fi
	@for dir in playground/vendor-src playground-plus jupyterlab vscode; do \
	    if npm ls --all --silent --prefix "$$dir" >/dev/null 2>&1 && \
	        node tools/check_npm_lock.mjs "$$dir" >/dev/null 2>&1; then \
	        echo "$$dir dependencies already installed"; \
	    else \
	        echo "Installing $$dir dependencies"; \
	        npm install --prefix "$$dir" || exit $$?; \
	    fi; \
	done

tools:
	@missing=; for tool in cc python3 node npm uv git; do \
	    command -v $$tool >/dev/null 2>&1 || missing="$$missing $$tool"; done; \
	    [ -z "$$missing" ] || { \
	        echo "Missing system tools:$$missing. Install them using your system package manager." >&2; \
	        case "$$(uname -s)" in \
	            Linux) echo "On Debian/Ubuntu, install the compiler, Python and Git with: sudo apt install build-essential python3 git" >&2 ;; \
	            Darwin) echo "On macOS, install the command-line developer tools with: xcode-select --install" >&2 ;; \
	        esac; \
	        echo "Node.js: https://nodejs.org/  uv: https://docs.astral.sh/uv/getting-started/installation/" >&2; \
	        exit 1; \
	    }
	@node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 22 || (major === 22 && minor < 13)) { console.error("Node.js 22.13 or later is required: https://nodejs.org/"); process.exit(1); }'

$(PY):
	uv venv .venv

emsdk: ## Install Emscripten with emsdk into ~/emsdk (a large download)
	[ -d "$(EMSDK_DIR)" ] || git clone https://github.com/emscripten-core/emsdk.git "$(EMSDK_DIR)"
	cd "$(EMSDK_DIR)" && ./emsdk install latest && ./emsdk activate latest

ensure-emsdk:
	@if command -v emcc >/dev/null 2>&1; then \
	    emcc --version >/dev/null || { echo "The emcc on PATH is not usable. Repair your Emscripten installation." >&2; exit 1; }; \
	    echo "Emscripten already available"; \
	elif [ -f "$(EMSDK_ENV)" ]; then \
	    if source "$(EMSDK_ENV)" >/dev/null 2>&1 && command -v emcc >/dev/null 2>&1 && emcc --version >/dev/null; then \
	        echo "Emscripten already available in $(EMSDK_DIR)"; \
	    else \
	        echo "Emscripten environment $(EMSDK_ENV) is not usable. Repair it or set EMSDK_ENV to a working installation." >&2; \
	        exit 1; \
	    fi; \
	else \
	    echo "Installing Emscripten into $(EMSDK_DIR) (this is a large download)"; \
	    $(MAKE) emsdk || exit $$?; \
	    if [ ! -f "$(EMSDK_ENV)" ] || ! (source "$(EMSDK_ENV)" >/dev/null 2>&1 && command -v emcc >/dev/null 2>&1 && emcc --version >/dev/null); then \
	        echo "Emscripten was installed but $(EMSDK_ENV) does not provide emcc." >&2; \
	        exit 1; \
	    fi; \
	fi
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

test: all ## Build, then run every test suite
	$(MAKE) test-python test-diff test-wasm test-playground test-playground-plus

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
