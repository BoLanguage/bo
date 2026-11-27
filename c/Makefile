CC ?= gcc
CFLAGS ?= -O2 -g -Wall -Wextra -std=gnu11
ROOT := $(abspath ..)
VERSION := $(word 1,$(file < ../VERSION))
VDATE := $(word 2,$(file < ../VERSION))

bo: Makefile main.c machine.c heap.c units.c names.c lower.c lineedit.c debugger.inc bo.h ../VERSION
	$(CC) $(CFLAGS) -DBO_VERSION='"$(VERSION)"' -DBO_DATE='"$(VDATE)"' -o $@ main.c machine.c heap.c units.c names.c lower.c lineedit.c -lm

# WebAssembly build (needs Emscripten: `source ~/emsdk/emsdk_env.sh`); output goes to ../wasm/build
WASM_SRC := wasm.c machine.c heap.c units.c names.c lower.c
WASM_FLAGS := -O2 -std=gnu11 -DBO_VERSION='"$(VERSION)"' -sMODULARIZE -sEXPORT_ES6 -sEXPORT_NAME=createBoModule \
	-sALLOW_MEMORY_GROWTH -sINVOKE_RUN=0 -sENVIRONMENT=web,worker,node -sFORCE_FILESYSTEM \
	-sEXPORTED_RUNTIME_METHODS=ccall,FS,stringToNewUTF8 -sEXPORTED_FUNCTIONS=_malloc,_free --embed-file ../include@/include

wasm: Makefile $(WASM_SRC) debugger.inc bo.h ../VERSION $(wildcard ../include/*)
	mkdir -p ../wasm/build
	emcc $(WASM_FLAGS) -o ../wasm/build/bo-core.mjs $(WASM_SRC) -lm

clean:
	rm -f bo
	rm -rf ../wasm/build

# differential test against the Python reference (run from the repository root)
test: bo
	cd .. && .venv/bin/python -m tests.diff_c
